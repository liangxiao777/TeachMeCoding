import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { clampThinkingLevel, getSupportedThinkingLevels, InMemoryCredentialStore, type Api, type AuthContext, type AuthEvent, type AuthPrompt,
  type CredentialStore, type Model, type MutableModels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loginAnswerSchema, loginStartSchema, modelSelectionSchema, type LoginEvent, type LoginSession, type ModelSelection,
  type BusinessErrorDetail, type ModelSettings, type ModelSummary, type ProviderSummary } from '@teach-me-coding/contracts';
import type { EnvLookup } from '../config/model.js';
import { BusinessError } from '../modules/learning.js';
import { classifyModelFailure } from './failure.js';

export interface ModelChoice { selection: ModelSelection; model: Model<Api> }
/** What the teaching runtime needs: the frozen choice for new work and model lookup for saved work. */
export interface ModelSource {
  readonly issue?: BusinessErrorDetail | null;
  current(): ModelChoice | null;
  resolve(selection: ModelSelection): Model<Api> | undefined;
  sessionRuntime(model: Model<Api>): Promise<ModelRuntime>;
  stream?: StreamFn;
}

export function authContext(env: EnvLookup): AuthContext {
  return {
    env: async (name) => env(name),
    fileExists: async (path) => existsSync(path.startsWith('~') ? join(homedir(), path.slice(1)) : path),
  };
}

type Live = LoginSession & { controller: AbortController; answer?: (value: string) => void; secrets: string[]; finishedAt?: number };

/**
 * Model choice and provider auth, entirely through pi-ai's catalog, auth
 * resolution, credential store and login flows. Secrets never leave the server.
 */
export class ModelService implements ModelSource {
  readonly models: MutableModels;
  private credentials: CredentialStore;
  private configurationIssue: BusinessErrorDetail | null = { code: 'MODEL_CONFIGURATION_CHECKING' };
  private authIssues = new Map<string, BusinessErrorDetail>();
  private authEpochs = new Map<string, number>();
  private logins = new Map<string, Live>();
  constructor(private db: Database.Database | null, private options: {
    env: EnvLookup; credentials?: CredentialStore; fallback?: { provider: string; model: string } | null;
  }) {
    this.credentials = options.credentials ?? new InMemoryCredentialStore();
    this.models = builtinModels({ credentials: this.credentials, authContext: authContext(options.env) });
  }
  readonly stream: StreamFn = async (model, context, options) => {
    const epoch = this.authEpochs.get(model.provider) ?? 0;
    const stream = this.models.streamSimple(model, context, options);
    void stream.result().then((message) => {
      // A request using old credentials must not invalidate a later login.
      if (epoch !== (this.authEpochs.get(model.provider) ?? 0)) return;
      const failure = message.stopReason === 'error' ? classifyModelFailure(model.provider, message.errorMessage) : undefined;
      if (failure?.category === 'oauth_reauth_required') {
        this.authIssues.set(model.provider, failure.detail);
      }
    }, () => {});
    return stream;
  };
  get issue() { return this.configurationIssue ?? this.authIssues.get(this.selection()?.provider ?? '') ?? null; }
  get ready() { return this.issue === null; }

  private resetAuthIssue(provider: string) {
    this.authEpochs.set(provider, (this.authEpochs.get(provider) ?? 0) + 1);
    this.authIssues.delete(provider);
  }

  async sessionRuntime(model: Model<Api>) {
    const provider = this.models.getProvider(model.provider);
    if (!provider) throw new BusinessError(503, { code: 'MODEL_PROVIDER_UNAVAILABLE' });
    const runtime = await ModelRuntime.create({ credentials: this.credentials, modelsPath: null, refreshOnCreate: false });
    const context = authContext(this.options.env);
    // Pi sessions and the teaching transport share credentials and the app's
    // injected environment. Never discover the user's CLI model configuration.
    runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth,
      ...(provider.auth.apiKey ? { apiKey: { ...provider.auth.apiKey,
        ...(provider.auth.apiKey.check ? { check: (input) => provider.auth.apiKey!.check!({ ...input, ctx: { ...input.ctx, ...context } }) } : {}),
        resolve: (input) => provider.auth.apiKey!.resolve({ ...input, ctx: { ...input.ctx, ...context } }),
      } } : {}),
    } });
    await runtime.refresh({ providers: [provider.id], allowNetwork: false });
    return runtime;
  }

  private setting<T>(key: string): T | undefined {
    const row = this.db?.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  private save(key: string, value: unknown) {
    this.db?.prepare('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  selection(): ModelSelection | null {
    const saved = modelSelectionSchema.safeParse(this.setting('model'));
    if (saved.success) return saved.data;
    const fallback = this.options.fallback;
    if (!fallback) return null;
    const model = this.models.getModel(fallback.provider, fallback.model);
    return { ...fallback, thinkingLevel: model ? clampThinkingLevel(model, 'high') : 'high' };
  }
  resolve(selection: ModelSelection) { return this.models.getModel(selection.provider, selection.model); }
  current(): ModelChoice | null {
    const selection = this.selection(), model = selection && this.resolve(selection);
    return this.ready && selection && model ? { selection, model } : null;
  }
  /** Recompute availability. Auth checks never refresh OAuth or reveal credentials. */
  async refresh() {
    const selection = this.selection(), model = selection && this.resolve(selection);
    let issue: BusinessErrorDetail | null = null;
    if (!selection) issue = { code: 'MODEL_NOT_SELECTED' };
    else if (!model) issue = { code: 'MODEL_SELECTION_UNAVAILABLE' };
    else if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) issue = { code: 'MODEL_THINKING_UNAVAILABLE' };
    else if (!await this.models.checkAuth(selection.provider).catch(() => undefined)) issue = { code: 'MODEL_CREDENTIALS_MISSING' };
    this.configurationIssue = issue;
  }

  async settings(): Promise<ModelSettings> {
    const stored = new Map((await this.credentials.list()).map((c) => [c.providerId, c.type]));
    const providers = await Promise.all(this.models.getProviders().map(async (p): Promise<ProviderSummary> => {
      const check = await this.models.checkAuth(p.id).catch(() => undefined);
      const issue = this.authIssues.get(p.id);
      return {
        id: p.id, name: p.name, models: this.models.getModels(p.id).length, stored: stored.get(p.id) ?? null,
        configured: check ? { type: check.type, ...(check.source ? { source: check.source } : {}) } : null,
        ...(issue ? { issue } : {}),
        auth: {
          ...(p.auth.apiKey ? { apiKey: { name: p.auth.apiKey.name, login: !!p.auth.apiKey.login } } : {}),
          ...(p.auth.oauth ? { oauth: { name: p.auth.oauth.name, ...(p.auth.oauth.loginLabel ? { label: p.auth.oauth.loginLabel } : {}), subscription: !!p.auth.oauth.isSubscription } } : {}),
        },
      };
    }));
    return { selection: this.selection(), ready: this.ready, issue: this.issue, providers };
  }
  modelsOf(provider: string): ModelSummary[] {
    if (!this.models.getProvider(provider)) throw new BusinessError(404, { code: 'MODEL_PROVIDER_NOT_FOUND' });
    return this.models.getModels(provider).map((m) => ({ id: m.id, name: m.name, reasoning: m.reasoning,
      thinkingLevels: getSupportedThinkingLevels(m), contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: [...m.input] }));
  }
  async select(raw: unknown) {
    const selection = modelSelectionSchema.parse(raw), model = this.resolve(selection);
    if (!model) throw new BusinessError(422, { code: 'MODEL_NOT_IN_CATALOG' });
    if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) throw new BusinessError(422, { code: 'MODEL_THINKING_UNSUPPORTED' });
    this.save('model', selection);
    await this.refresh();
    return this.settings();
  }

  private deviceId() {
    const saved = this.setting<string>('device_id');
    if (saved) return saved;
    const id = randomUUID();
    this.save('device_id', id);
    return id;
  }
  private view(s: Live): LoginSession {
    const { controller: _c, answer: _a, secrets: _s, finishedAt: _f, ...session } = s;
    return structuredClone(session);
  }
  private sweep() {
    for (const [id, s] of this.logins) if (s.finishedAt && Date.now() - s.finishedAt > 10 * 60_000) this.logins.delete(id);
  }
  login(providerId: string, raw: unknown): LoginSession {
    const { type } = loginStartSchema.parse(raw), provider = this.models.getProvider(providerId);
    if (!provider) throw new BusinessError(404, { code: 'MODEL_PROVIDER_NOT_FOUND' });
    if (type === 'oauth' ? !provider.auth.oauth : !provider.auth.apiKey?.login) throw new BusinessError(422, { code: 'LOGIN_METHOD_UNSUPPORTED' });
    this.sweep();
    for (const s of this.logins.values()) if (s.providerId === providerId && s.state === 'running') s.controller.abort();
    const session: Live = { id: randomUUID(), providerId, type, state: 'running', prompt: null, events: [], error: null, controller: new AbortController(), secrets: [] };
    this.logins.set(session.id, session);
    const notify = (event: AuthEvent) => {
      const safe: LoginEvent = event.type === 'device_code'
        ? { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri, ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}) }
        : event.type === 'info' ? { type: event.type, message: event.message, ...(event.links ? { links: event.links.map((l) => ({ ...l })) } : {}) }
        : event.type === 'auth_url' ? { type: event.type, url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) }
        : { type: event.type, message: event.message };
      session.events = [...session.events, safe].slice(-50);
    };
    const prompt = (request: AuthPrompt) => new Promise<string>((resolve, reject) => {
      const { signal, ...shown } = request;
      const id = randomUUID();
      const clear = () => { if (session.prompt?.id === id) { session.prompt = null; session.answer = undefined; } };
      session.prompt = shown.type === 'select' ? { id, type: 'select', message: shown.message, options: shown.options.map((o) => ({ ...o })) } : { id, ...shown };
      session.answer = (value) => {
        if (shown.type === 'secret') session.secrets.push(value);
        clear(); resolve(value);
      };
      for (const s of [signal, session.controller.signal]) s?.addEventListener('abort', () => { clear(); reject(new Error('Login cancelled.')); }, { once: true });
    });
    void this.models.login(providerId, type, { signal: session.controller.signal, prompt, notify }, { getDeviceId: () => this.deviceId() })
      .then(() => { this.resetAuthIssue(providerId); session.state = 'succeeded'; })
      .catch((error: unknown) => {
        session.state = session.controller.signal.aborted ? 'cancelled' : 'failed';
        session.error = session.state === 'cancelled' ? null : { code: 'LOGIN_FAILED' };
        // Only upstream diagnostics retain prose, after session-secret redaction.
        if (session.state !== 'cancelled' && error instanceof Error) {
          let diagnostic = error.message;
          for (const secret of session.secrets) if (secret) diagnostic = diagnostic.replaceAll(secret, '••••');
          session.diagnostic = diagnostic.slice(0, 500);
        }
      })
      .finally(() => {
        session.prompt = null; session.answer = undefined; session.secrets = []; session.finishedAt = Date.now();
        void this.models.refresh({ providers: [providerId] }).finally(() => this.refresh());
      });
    return this.view(session);
  }
  loginState(id: string) {
    const session = this.logins.get(id);
    if (!session) throw new BusinessError(404, { code: 'LOGIN_SESSION_NOT_FOUND' });
    return session;
  }
  getLogin(id: string) { return this.view(this.loginState(id)); }
  answerLogin(id: string, raw: unknown) {
    const input = loginAnswerSchema.parse(raw), session = this.loginState(id);
    if (session.state !== 'running' || session.prompt?.id !== input.promptId || !session.answer) throw new BusinessError(409, { code: 'LOGIN_PROMPT_OUTDATED' });
    session.answer(input.value);
    return this.view(session);
  }
  cancelLogin(id: string) {
    const session = this.loginState(id);
    if (session.state === 'running') session.controller.abort();
    return this.view(session);
  }
  async logout(providerId: string) {
    if (!this.models.getProvider(providerId)) throw new BusinessError(404, { code: 'MODEL_PROVIDER_NOT_FOUND' });
    await this.models.logout(providerId);
    this.resetAuthIssue(providerId);
    await this.refresh();
    return this.settings();
  }
  close() { for (const s of this.logins.values()) s.controller.abort(); }
}

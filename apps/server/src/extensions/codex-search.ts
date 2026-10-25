import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AuthCheck, AuthResult, CredentialStore, Models } from '@earendil-works/pi-ai';
import type { WebSearchResult } from '@teach-me-coding/contracts';
import { descendants, stopProcesses } from '../runtime/processes.js';

export interface CodexAuthSource {
  checkAuth(signal?: AbortSignal): Promise<AuthCheck | undefined>;
  getAuth(signal: AbortSignal, forceRefresh?: boolean): Promise<AuthResult | undefined>;
}

const provider = 'openai-codex';
const maxBytes = 1024 * 1024;
const maxAnswer = 20_000;
const workerInstructions = 'Bounded web-search worker: use hosted web_search, return concise grounded answer with source URLs, no other tools/files/follow-ups';

function cancelled(signal: AbortSignal): Error {
  return new DOMException(signal.reason?.name === 'TimeoutError' ? 'Codex search timed out.' : 'Codex search cancelled.',
    signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}

/** Race even implementations that fail to honor their supplied signal. Never reflect auth errors. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.aborted ? abort() : resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Provider-scoped auth only: does not read or mutate the selected teaching model. */
export function codexAuthSource(models: Models, credentials: CredentialStore): CodexAuthSource {
  return {
    async checkAuth(signal) {
      if (signal?.aborted) throw cancelled(signal);
      try {
        const pending = models.checkAuth(provider, { signal });
        const check = signal ? await abortable(pending, signal) : await pending;
        return check?.type === 'oauth' ? check : undefined;
      } catch { throw signal?.aborted ? cancelled(signal) : new Error('Codex OAuth readiness check failed.'); }
    },
    async getAuth(signal, forceRefresh = false) {
      if (signal.aborted) throw cancelled(signal);
      try {
        if (forceRefresh) {
          // Public Models has no force-refresh flag. Its subsequent getAuth serializes
          // token rotation in this same store; preserve all account/refresh fields.
          await abortable(credentials.modify(provider, async (current) => {
            if (signal.aborted) throw cancelled(signal);
            return current?.type === 'oauth' ? { ...current, expires: 0 } : undefined;
          }, { signal }), signal);
        }
        if (signal.aborted) throw cancelled(signal);
        const result = await abortable(models.getAuth(provider, { signal }), signal);
        return result?.source === 'OAuth' ? result : undefined;
      } catch { throw signal.aborted ? cancelled(signal) : new Error('Codex OAuth authentication failed.'); }
    },
  };
}

/** Internal dependency injection, not a user-configurable executable or config endpoint. */
export interface CodexSearchLaunchOptions {
  launch?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

// Verified against @openai/codex 0.160.0. There is deliberately no guessed
// apply_patch toggle: the *top-level* thread environments: [] removes native tools.
const restrictions: Record<string, string | number | boolean | string[]> = {
  project_root_markers: [], cli_auth_credentials_store: 'ephemeral',
  'features.shell_tool': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.apps': false, 'features.hooks': false, notify: [], 'features.image_generation': false,
  'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  project_doc_max_bytes: 0, web_search: 'live', 'features.standalone_web_search': false,
  'skills.include_instructions': false, include_environment_context: false,
  'history.persistence': 'none', 'analytics.enabled': false,
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol response.');
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid Codex protocol string.');
  return value;
}
function empty(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }
function compatible(version: string): boolean {
  // Fail closed on major-version changes and prereleases; 0.160+ exposes the
  // environment-free thread contract. The returned restrictions are also attested.
  const match = /^0\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) >= 160;
}

function tokens(result: AuthResult | undefined): { accessToken: string; chatgptAccountId: string; chatgptPlanType: null } {
  try {
    if (result?.source !== 'OAuth') throw new Error();
    const accessToken = result.auth.apiKey;
    if (!accessToken || accessToken.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) throw new Error();
    const claims = object(JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')));
    const chatgptAccountId = string(object(claims['https://api.openai.com/auth']).chatgpt_account_id);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(chatgptAccountId)) throw new Error();
    for (const [name, value] of Object.entries(result.auth.headers ?? {})) {
      if (name.toLowerCase() === 'chatgpt-account-id' && value !== chatgptAccountId) throw new Error();
      if (name.toLowerCase() === 'authorization' && value !== `Bearer ${accessToken}`) throw new Error();
    }
    return { accessToken, chatgptAccountId, chatgptPlanType: null };
  } catch { throw new Error('Suitable Codex ChatGPT OAuth authentication is required.'); }
}

async function resolveTokens(auth: CodexAuthSource, signal: AbortSignal, forceRefresh = false) {
  let result: AuthResult | undefined;
  try { result = await abortable(auth.getAuth(signal, forceRefresh), signal); }
  catch { throw signal.aborted ? cancelled(signal) : new Error('Codex OAuth authentication failed.'); }
  return tokens(result);
}

/** No ambient process secrets, proxies, NODE_OPTIONS, teaching or MCP credentials. */
function privateEnvironment(home: string, root: string): NodeJS.ProcessEnv {
  return { HOME: home, CODEX_HOME: home, TMPDIR: root, TMP: root, TEMP: root,
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home } : {}),
    LANG: 'en_US.UTF-8' };
}

class Rpc {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private decoder = new StringDecoder('utf8');
  private frame = '';
  private bytes = 0;
  private failure?: Error;
  private closing = false;
  private closed = false;
  readonly exited: Promise<void>;
  onNotification: (method: string, params: ObjectValue) => void = () => {};
  onRequest: (method: string, params: ObjectValue) => Promise<unknown> = async () => { throw new Error('Codex server request rejected.'); };
  onFailure: (error: Error) => void = () => {};

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => child.once('close', () => {
      this.closed = true;
      if (!this.closing) this.fail(new Error('Codex search process exited.'));
      resolve();
    }));
    // 'exit' can precede 'close' when a descendant still holds stdio open.
    child.once('exit', () => { if (!this.closing) this.fail(new Error('Codex search process exited.')); });
    child.once('error', () => this.fail(new Error('Codex search process could not start.')));
    child.stdin.on('error', () => this.fail(new Error('Codex search transport closed.')));
    child.stdout.on('error', () => this.fail(new Error('Codex search transport failed.')));
    // Drain but never retain, log, or reflect stderr (which can contain auth).
    child.stderr.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (data: Buffer) => {
      if (this.failure) return;
      try {
        this.bytes += data.length;
        if (this.bytes > maxBytes) throw new Error('Codex search output exceeded its limit.');
        this.frame += this.decoder.write(data);
        let end: number;
        while ((end = this.frame.indexOf('\n')) !== -1) {
          const line = this.frame.slice(0, end);
          this.frame = this.frame.slice(end + 1);
          if (line.trim()) this.route(object(JSON.parse(line)));
        }
      } catch (error) {
        this.frame = '';
        this.fail(error instanceof SyntaxError ? new Error('Invalid Codex protocol frame.')
          : error instanceof Error ? error : new Error('Invalid Codex protocol response.'));
      }
    });
  }

  fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure(error);
  }
  assertHealthy() { if (this.failure) throw this.failure; }

  private route(message: ObjectValue) {
    if (typeof message.method === 'string') {
      const params = message.params === undefined ? {} : object(message.params);
      if (message.id !== undefined) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Error('Invalid Codex request ID.');
        void this.onRequest(message.method, params).then((result) => {
          return this.write({ id: message.id, result });
        }, () => {
          this.fail(new Error('Codex server request rejected.'));
          return this.write({ id: message.id, error: { code: -32603, message: 'Search worker rejected server request.' } });
        }).catch(() => this.fail(new Error('Codex search transport closed.')));
      } else this.onNotification(message.method, params);
    } else if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return; // A cancelled request may receive a late response.
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error('Codex search RPC failed.'));
      else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new Error('Invalid Codex protocol response.'));
    } else throw new Error('Invalid Codex protocol message.');
  }

  private write(message: ObjectValue): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) return Promise.reject(new Error('Codex search transport closed.'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        error ? reject(new Error('Codex search transport closed.')) : resolve();
      });
    });
  }
  async notify(method: string, signal: AbortSignal) {
    if (signal.aborted) throw cancelled(signal);
    this.assertHealthy();
    await abortable(this.write({ method }), signal);
  }
  async request(method: string, params: ObjectValue, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw cancelled(signal);
    this.assertHealthy();
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    // Install the waiter before writing; a response can arrive before write's callback.
    const writing = this.write({ id, method, params }).catch(() => {
      this.fail(new Error('Codex search transport closed.'));
    });
    try { return await abortable(Promise.all([writing, response]).then(([, result]) => result), signal); }
    finally { this.pending.delete(id); }
  }

  async close() {
    this.closing = true;
    if (process.platform === 'win32') {
      // Snapshot before closing stdin: codex.js can exit before its native
      // child, which may still own the private workspace or inherited pipes.
      const pids = this.child.pid ? descendants(this.child.pid) : [];
      this.child.stdin.end();
      await stopProcesses(pids);
      await this.exited;
      this.frame = ''; this.pending.clear();
      for (let attempt = 0; attempt < 50; attempt++) {
        if (pids.every((pid) => {
          try { process.kill(pid, 0); return false; }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        })) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Codex search process tree did not exit.');
    }
    this.child.stdin.end();
    // codex.js owns a native child. A detached POSIX group terminates both, not
    // just the JS wrapper. This is capability isolation, NOT OS-level containment.
    const terminate = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch { /* Already exited. */ }
    };
    terminate('SIGTERM');
    const timer = setTimeout(() => terminate('SIGKILL'), 500);
    try { await this.exited; } finally {
      // A descendant may have closed its inherited pipes before ignoring TERM.
      // Do not cancel its group cleanup just because the wrapper has exited.
      terminate('SIGKILL');
      clearTimeout(timer); this.frame = ''; this.pending.clear();
    }
    if (this.child.pid) {
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(-this.child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw new Error('Codex search process group exit could not be verified.');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      // Do not remove a workspace that a surviving process may still be using.
      throw new Error('Codex search process group did not exit.');
    }
  }
}

function attestConfig(response: unknown) {
  const config = object(object(response).config);
  for (const [path, expected] of Object.entries(restrictions)) {
    let actual: unknown = config;
    for (const key of path.split('.')) actual = object(actual)[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Codex search restrictions were not applied.');
  }
  // An empty CLI mcp_servers table would merge, not remove inherited servers.
  // Inspect the effective config before initiating any MCP discovery or auth.
  if (Object.keys(object(config.mcp_servers)).length || Object.keys(object(config.model_providers)).length
    || (config.model_provider != null && config.model_provider !== 'openai')
    || config.openai_base_url != null || config.model_catalog_json != null
    || (config.chatgpt_base_url != null && config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/')
    || config.instructions != null || config.developer_instructions != null || config.model_instructions_file != null
    || config.hooks != null) throw new Error('Inherited Codex capabilities or provider configuration are not allowed.');
}

async function attestMcp(rpc: Rpc, signal: AbortSignal, threadId?: string) {
  const status = object(await rpc.request('mcpServerStatus/list', { limit: null, cursor: null, ...(threadId ? { threadId } : {}) }, signal));
  if (!empty(status.data) || status.nextCursor !== null) throw new Error('Codex search MCP capabilities are not allowed.');
}

type SearchOutput = { answer: string; results: WebSearchResult[] };
class Collector {
  private turnId?: string;
  private early: { method: string; params: ObjectValue }[] = [];
  private bytes = 0;
  private messages = new Map<string, string>();
  private deltas = new Map<string, string>();
  private searches = new Map<string, ObjectValue>();
  private done = false;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  readonly completed = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  constructor(private threadId: string) {
    // Failures can arrive while turn/start is pending.
    void this.completed.catch(() => {});
  }
  fail(error: Error) { this.reject(error); }
  notification(method: string, params: ObjectValue) {
    if (params.threadId !== this.threadId) return;
    const activity = /commandExecution|fileChange|mcpToolCall|dynamicToolCall|permissions|imageView|imageGeneration|collabAgent|^hook\//.test(method);
    if (!activity && !['item/started', 'item/completed', 'rawResponseItem/completed', 'item/agentMessage/delta', 'turn/completed', 'error'].includes(method)) return;
    const eventTurnId = method === 'turn/completed' ? object(params.turn).id : params.turnId;
    if (typeof eventTurnId !== 'string') throw new Error('Missing Codex event turn ID.');
    if (this.turnId && eventTurnId !== this.turnId) return;
    this.bytes += Buffer.byteLength(JSON.stringify(params));
    if (this.bytes > maxBytes) throw new Error('Codex search collector exceeded its limit.');
    if (!this.turnId) {
      if (this.early.length >= 256) throw new Error('Too many early Codex notifications.');
      this.early.push({ method, params });
    } else this.consume(method, params);
  }
  acknowledge(turn: unknown) {
    const value = object(turn);
    this.turnId = string(value.id);
    for (const entry of this.early) {
      const id = entry.method === 'turn/completed' ? object(entry.params.turn).id : entry.params.turnId;
      if (id === this.turnId) this.consume(entry.method, entry.params);
    }
    this.early = [];
    if (value.status !== 'inProgress' && value.status !== 'completed') throw new Error('Codex search turn did not start.');
  }
  private item(value: unknown, completed: boolean) {
    const item = object(value), type = string(item.type), id = string(item.id);
    if (!['userMessage', 'agentMessage', 'reasoning', 'webSearch'].includes(type)) throw new Error('Unexpected Codex tool activity.');
    if (!completed) return;
    if (type === 'agentMessage') {
      if (typeof item.text !== 'string') throw new Error('Invalid Codex answer.');
      this.messages.set(id, item.text.slice(0, maxAnswer));
    } else if (type === 'webSearch') {
      const action = object(item.action);
      if (!['search', 'openPage', 'findInPage'].includes(String(action.type)) || item.results !== null) {
        throw new Error('Invalid Codex hosted search item.');
      }
      if (typeof item.query !== 'string'
        || (action.type === 'search' && !((action.query === null || typeof action.query === 'string')
          && (action.queries === null || (Array.isArray(action.queries) && action.queries.every((query) => typeof query === 'string')))))
        || (action.type !== 'search' && action.url !== null && typeof action.url !== 'string')) {
        throw new Error('Invalid Codex hosted search action.');
      }
      this.searches.set(id, action);
    }
  }
  private consume(method: string, params: ObjectValue) {
    if (method === 'item/started' || method === 'item/completed') this.item(params.item, method === 'item/completed');
    else if (method === 'rawResponseItem/completed') {
      const item = object(params.item);
      if (!['message', 'agent_message', 'reasoning', 'web_search_call'].includes(String(item.type))) throw new Error('Unexpected Codex tool activity.');
    } else if (method === 'item/agentMessage/delta') {
      const id = string(params.itemId);
      if (typeof params.delta !== 'string') throw new Error('Invalid Codex answer delta.');
      this.deltas.set(id, ((this.deltas.get(id) ?? '') + params.delta).slice(0, maxAnswer));
    } else if (method === 'error') throw new Error('Codex search turn failed.');
    else if (method === 'turn/completed') {
      const turn = object(params.turn);
      // Terminal snapshots are audited too, but do not substitute for actual
      // item/completed webSearch evidence.
      if (!Array.isArray(turn.items)) throw new Error('Invalid Codex completed turn.');
      for (const value of turn.items) this.item(value, false);
      if (turn.status !== 'completed' || turn.error != null) throw new Error('Codex search turn failed.');
      this.done = true;
      this.resolve();
    } else throw new Error('Unexpected Codex tool activity.');
  }
  result(count: number): SearchOutput {
    const answer = [...new Set([...this.messages.keys(), ...this.deltas.keys()])]
      .map((id) => this.messages.get(id)?.trim() || this.deltas.get(id)?.trim() || '').filter(Boolean).join('\n\n').slice(0, maxAnswer).trim();
    if (!this.done || !answer || !this.searches.size) throw new Error('Codex search completed without a grounded search answer.');
    const results: WebSearchResult[] = [], seen = new Set<string>();
    const add = (raw: unknown, title = '', snippet = '') => {
      if (typeof raw !== 'string' || raw.length > 2048 || results.length >= count) return;
      let url: URL;
      try { url = new URL(raw); } catch { return; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || seen.has(url.href)) return;
      seen.add(url.href);
      results.push({ title: (title.trim() || url.hostname).slice(0, 500), url: url.href, snippet: snippet.trim().slice(0, 2000) });
    };
    // Hosted results is null: metadata comes only from actual navigation actions
    // and URLs in the answer, never an invented search-results schema.
    for (const action of this.searches.values()) if (action.type === 'openPage' || action.type === 'findInPage') add(action.url);
    for (const match of answer.matchAll(/\[([^\]\n]*)\]\((https?:\/\/[^\s<>]+?)(?:\s+"[^"]*")?\)/g)) add(match[2], match[1], answer.slice(Math.max(0, match.index! - 200), match.index! + 300));
    for (const match of answer.matchAll(/https?:\/\/[^\s<>"\[\]]+/g)) add(match[0].replace(/[),.;!?]+$/, ''), '', answer.slice(Math.max(0, match.index! - 200), match.index! + 300));
    if (!results.length) throw new Error('Codex search answer contained no safe source URLs.');
    return { answer, results };
  }
}

/** Transient hosted search. Caller owns a single total deadline including auth/startup. */
export async function runCodexSearch(query: string, count: number, auth: CodexAuthSource, signal: AbortSignal,
  options: CodexSearchLaunchOptions = {}): Promise<SearchOutput> {
  if (signal.aborted) throw cancelled(signal);
  if (!query.trim() || query.length > 1000 || !Number.isInteger(count) || count < 1 || count > 10) throw new Error('Invalid Codex search input.');
  let root: string | undefined, rpc: Rpc | undefined, threadId: string | undefined, turnId = '', collector: Collector | undefined;
  let interrupt: Promise<unknown> | undefined, refreshes = 0, refreshing = false;
  const lifetime = new AbortController(), privateTokens = new Set<string>();
  const requestInterrupt = () => {
    if (!rpc || !threadId || interrupt) return;
    interrupt = rpc.request('turn/interrupt', { threadId, turnId }, AbortSignal.timeout(250)).catch(() => {});
  };
  const onAbort = () => { collector?.fail(cancelled(signal)); requestInterrupt(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const initial = await resolveTokens(auth, signal);
    privateTokens.add(initial.accessToken);
    root = await mkdtemp(join(tmpdir(), 'teachme-codex-search-'));
    // Canonicalize macOS /var -> /private/var before comparing native responses.
    root = await realpath(root);
    const home = join(root, 'codex-home'), cwd = join(root, 'workspace');
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
    if (signal.aborted) throw cancelled(signal);
    const command = process.execPath;
    const args = [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), 'app-server', '--listen', 'stdio://',
      ...Object.entries(restrictions).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`])];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (options.launch ?? ((executable, argv, settings) => spawn(executable, [...argv], { ...settings, stdio: 'pipe' })))(command, args,
        { cwd, env: privateEnvironment(home, root), detached: process.platform !== 'win32', windowsHide: true });
    } catch { throw new Error('Codex search process could not start.'); }
    rpc = new Rpc(child);
    rpc.onFailure = (error) => { lifetime.abort(); collector?.fail(error); };
    rpc.onNotification = (method, params) => {
      if (/^(command\/exec\/|process\/)/.test(method)) throw new Error('Unexpected Codex tool activity.');
      if (collector) collector.notification(method, params);
      else if ((method === 'item/started' || method === 'item/completed')
        || method === 'rawResponseItem/completed'
        || /commandExecution|fileChange|mcpToolCall|dynamicToolCall|permissions\/|imageView|imageGeneration|collabAgent|^hook\//.test(method)) {
        throw new Error('Unexpected Codex tool activity before search.');
      }
    };
    rpc.onRequest = async (method, params) => {
      if (method !== 'account/chatgptAuthTokens/refresh' || refreshing || ++refreshes > 2) throw new Error('Codex server request rejected.');
      if (params.previousAccountId != null && params.previousAccountId !== initial.chatgptAccountId) throw new Error('Codex auth account mismatch.');
      refreshing = true;
      try {
        const refreshSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(5000)]);
        const next = await resolveTokens(auth, refreshSignal, true);
        if (next.chatgptAccountId !== initial.chatgptAccountId) throw new Error('Codex auth account mismatch.');
        privateTokens.add(next.accessToken);
        return next;
      } finally { refreshing = false; }
    };
    const initialized = object(await rpc.request('initialize', {
      clientInfo: { name: 'teachme_hosted_search', title: 'TeachMeCoding', version: '1.0.0' }, capabilities: { experimentalApi: true },
    }, signal));
    const version = /^teachme_hosted_search\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(string(initialized.userAgent))?.[1];
    if (!version || !compatible(version) || initialized.codexHome !== home) throw new Error('Unsupported Codex search protocol.');
    await rpc.notify('initialized', signal);
    attestConfig(await rpc.request('config/read', { cwd, includeLayers: true }, signal));
    // Native administrator policy can override CLI flags and introduce hooks or
    // endpoints. Conservative admission: managed requirements need a separate audit.
    if (object(await rpc.request('configRequirements/read', {}, signal)).requirements !== null) throw new Error('Managed Codex requirements are not supported for search.');
    await attestMcp(rpc, signal);
    const before = object(await rpc.request('account/read', { refreshToken: false }, signal));
    if (before.account !== null) throw new Error('Inherited Codex credentials are not allowed.');
    await rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...initial }, signal);
    if (object(object(await rpc.request('account/read', { refreshToken: false }, signal)).account).type !== 'chatgpt') throw new Error('Codex ChatGPT authentication was not accepted.');
    const catalog = object(await rpc.request('model/list', { limit: null, cursor: null, includeHidden: false }, signal));
    if (!Array.isArray(catalog.data) || catalog.nextCursor !== null) throw new Error('Invalid Codex model catalog.');
    const textModels = catalog.data.map(object).filter((model) => model.hidden !== true && Array.isArray(model.inputModalities) && model.inputModalities.includes('text'));
    const model = string((textModels.find((entry) => entry.isDefault === true) ?? textModels[0] ?? {}).model);
    const started = object(await rpc.request('thread/start', {
      model, modelProvider: 'openai', cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      environments: [], dynamicTools: [], experimentalRawEvents: true, developerInstructions: workerInstructions, config: restrictions,
    }, signal));
    const thread = object(started.thread), sandbox = object(started.sandbox);
    threadId = string(thread.id);
    if (started.cwd !== cwd || thread.cwd !== cwd || started.model !== model || started.modelProvider !== 'openai'
      || thread.modelProvider !== 'openai' || thread.ephemeral !== true || thread.path !== null || !empty(thread.environments)
      || !empty(started.instructionSources) || started.approvalPolicy !== 'never' || sandbox.type !== 'readOnly'
      || sandbox.networkAccess !== false || !compatible(string(thread.cliVersion)) || thread.cliVersion !== version) {
      throw new Error('Codex search thread restrictions were not applied.');
    }
    await attestMcp(rpc, signal, threadId);
    collector = new Collector(threadId);
    // Subscribe BEFORE turn/start: completion can precede its acknowledgement.
    const turn = object(await rpc.request('turn/start', {
      threadId, input: [{ type: 'text', text: query, text_elements: [] }], approvalPolicy: 'never', effort: 'low',
    }, signal)).turn;
    turnId = string(object(turn).id);
    collector.acknowledge(turn);
    rpc.assertHealthy();
    await abortable(collector.completed, signal);
    rpc.assertHealthy();
    if (signal.aborted) throw cancelled(signal);
    const output = collector.result(count), serialized = JSON.stringify(output);
    if ([...privateTokens].some((token) => serialized.includes(token))) throw new Error('Codex search returned private authentication data.');
    return output;
  } catch (error) {
    requestInterrupt();
    if (signal.aborted) throw cancelled(signal);
    // Only adapter-created errors cross this boundary, never auth/child payloads.
    if (error instanceof Error && /^(Codex|Invalid Codex|Inherited Codex|Unsupported Codex|Suitable Codex|Managed Codex|Unexpected Codex|Missing Codex|Too many early Codex)/.test(error.message)) throw new Error(error.message);
    throw new Error('Codex hosted search failed.');
  } finally {
    signal.removeEventListener('abort', onAbort);
    await interrupt;
    lifetime.abort();
    await rpc?.close();
    if (root) await rm(root, { recursive: true, force: true });
    // Cancellation during cleanup wins over an already collected success.
    if (signal.aborted) throw cancelled(signal);
    rpc?.assertHealthy();
    privateTokens.clear();
  }
}

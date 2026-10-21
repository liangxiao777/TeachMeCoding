import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { openDatabase } from '../storage/database.js';
import { ModelService } from './service.js';
import { FileCredentialStore } from './credentials.js';
import { BusinessError } from '../modules/learning.js';
import { reply, response } from '../agents/test-support.js';

const stealth = { provider: 'openrouter', model: 'stealth/space-bunny-alpha' };

function service(db = openDatabase(':memory:')) {
  const credentials = new InMemoryCredentialStore(), models = new ModelService(db, { credentials });
  db.prepare("INSERT INTO app_settings VALUES ('model', ?)").run(JSON.stringify({ ...stealth, thinkingLevel: 'high' }));
  return { db, models, credentials };
}

test('selection comes only from the database and survives reopening without an environment default', async () => {
  const db = openDatabase(':memory:'), models = new ModelService(db);
  const previous = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = stealth.model;
  try {
    assert.equal(models.selection(), null);
    assert.equal(models.current(), null);
    await models.refresh();
    assert.deepEqual(models.issue, { code: 'MODEL_NOT_SELECTED' });
    assert.deepEqual((await models.settings()).issue, { code: 'MODEL_NOT_SELECTED' });
    await models.select({ ...stealth, thinkingLevel: 'low' });
    assert.deepEqual(models.selection(), { ...stealth, thinkingLevel: 'low' });
    assert.deepEqual(new ModelService(db).selection(), { ...stealth, thinkingLevel: 'low' });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = previous;
    models.close(); db.close();
  }
});

test('readiness reports the exact missing piece instead of a bare unavailable', async () => {
  const { db, models } = service();
  assert.deepEqual(models.issue, { code: 'MODEL_CONFIGURATION_CHECKING' });
  assert.deepEqual((await models.settings()).issue, { code: 'MODEL_CONFIGURATION_CHECKING' });
  await models.refresh();
  assert.equal(models.current(), null, 'provider key missing, so not ready');
  assert.deepEqual((await models.settings()).issue, { code: 'MODEL_CREDENTIALS_MISSING' });
  const keyed = service();
  await keyed.credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-stored-key' }));
  await keyed.models.refresh();
  assert.notEqual(keyed.models.current(), null);
  const settings = await keyed.models.settings();
  assert.equal(settings.ready, true);
  assert.equal(settings.issue, null);
  assert.equal('issueDetail' in settings, false);
  // A saved model that is gone from the catalog is a distinct, actionable issue.
  const lost = service();
  lost.db.prepare("UPDATE app_settings SET value=? WHERE key='model'").run(JSON.stringify({ provider: 'openrouter', model: 'gone/model', thinkingLevel: 'high' }));
  await lost.models.refresh();
  assert.equal(lost.models.current(), null);
  assert.deepEqual((await lost.models.settings()).issue, { code: 'MODEL_SELECTION_UNAVAILABLE' });
  lost.db.prepare("UPDATE app_settings SET value=? WHERE key='model'").run(JSON.stringify({ ...stealth, thinkingLevel: 'off' }));
  await lost.models.refresh();
  assert.deepEqual(lost.models.issue, { code: 'MODEL_THINKING_UNAVAILABLE' });
  assert.deepEqual((await lost.models.settings()).issue, { code: 'MODEL_THINKING_UNAVAILABLE' });
  db.close(); keyed.db.close(); lost.db.close();
});

test('OAuth refresh rejection changes readiness without deleting credentials, and a new login restores it', async () => {
  for (const [detail, rejected] of [
    ['OpenAI OAuth token request failed (400): {"error":"invalid_grant","private":"synthetic-refresh-secret"}', true],
    ['OpenAI OAuth token request failed (401): {"error":{"code":"refresh_token_invalidated"}}', true],
    ['OpenAI OAuth token request failed (400): {"error":"invalid_client"}', true],
    ['OpenAI OAuth token request failed (503): {"error":"invalid_grant"}', false],
    ['OpenAI OAuth token request failed (400): {"error":"unknown","message":"invalid_grant"}', false],
    ['fetch failed', false],
  ] as const) {
    const db = openDatabase(':memory:'), credentials = new InMemoryCredentialStore();
    const original = { type: 'oauth' as const, access: 'synthetic-access-secret', refresh: 'synthetic-refresh-secret', expires: 0 };
    await credentials.modify('openai', async () => original);
    await credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-stored-key' }));
    const models = new ModelService(db, { credentials });
    await models.select({ provider: 'openai', model: 'gpt-6.1-sol', thinkingLevel: 'high' });
    const provider = models.models.getProvider('openai')!;
    models.models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!,
      refresh: async () => { throw new Error(detail); },
      login: async () => ({ ...original, access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', expires: Date.now() + 3_600_000 }),
    } } });
    try {
      await models.refresh();
      const model = models.current()!.model;
      const result = await (await models.stream(model, normalizeContext({ messages: [] }))).result();
      assert.equal(result.stopReason, 'error');
      const settings = await models.settings();
      assert.equal(settings.ready, !rejected);
      assert.equal(models.current() === null, rejected);
      assert.equal(!!settings.providers.find((p) => p.id === 'openai')?.issue, rejected);
      const expectedDetail = rejected ? { code: 'MODEL_OAUTH_REAUTH_REQUIRED', params: { provider: 'ChatGPT' } } : undefined;
      assert.deepEqual(settings.issue, expectedDetail ?? null);
      assert.deepEqual(settings.providers.find((p) => p.id === 'openai')?.issue, expectedDetail);
      assert.deepEqual(await credentials.read('openai'), original, 'Rejected credentials are preserved for explicit recovery');
      assert.doesNotMatch(JSON.stringify(settings), /synthetic-.*secret|"private"/);
      await models.refresh();
      assert.equal(models.ready, !rejected, 'A presence-only refresh must not erase a known rejection');
      if (!rejected) continue;
      assert.deepEqual(settings.issue, { code: 'MODEL_OAUTH_REAUTH_REQUIRED', params: { provider: 'ChatGPT' } });
      await models.select({ ...stealth, thinkingLevel: 'high' });
      assert.equal(models.ready, true, 'The failure is scoped to its provider');
      await models.select({ provider: 'openai', model: model.id, thinkingLevel: 'high' });
      assert.equal(models.ready, false, 'Reselecting a model is not reauthentication');
      const login = models.login('openai', { type: 'oauth' });
      await waitFor(() => models.getLogin(login.id), (s) => s.state === 'succeeded', 'OAuth reconnection');
      await models.refresh();
      assert.equal(models.ready, true);
      assert.equal((await models.settings()).providers.find((p) => p.id === 'openai')?.issue, undefined);
      assert.equal((await models.settings()).issue, null);
      assert.equal((await credentials.read('openai'))?.type, 'oauth');
    } finally { models.close(); db.close(); }
  }
});

test('an older successful request cannot clear a known OAuth refresh rejection', async () => {
  const db = openDatabase(':memory:'), credentials = new InMemoryCredentialStore();
  const credential = { type: 'oauth' as const, access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 };
  await credentials.modify('openai', async () => credential);
  const models = new ModelService(db, { credentials });
  await models.select({ provider: 'openai', model: 'gpt-6.1-sol', thinkingLevel: 'high' });
  const provider = models.models.getProvider('openai')!, held = createAssistantMessageEventStream();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const stream = () => { entered(); return held; };
  models.models.setProvider({ ...provider, stream, streamSimple: stream, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!,
    toAuth: async (saved) => ({ apiKey: saved.access }),
    refresh: async () => { throw new Error('OpenAI OAuth token request failed (400): {"error":"invalid_grant"}'); },
  } } });
  try {
    await models.refresh();
    const model = models.current()!.model, context = normalizeContext({ messages: [] });
    const old = await models.stream(model, context);
    await started;
    await credentials.modify('openai', async () => ({ ...credential, expires: 0 }));
    const rejected = await (await models.stream(model, context)).result();
    assert.equal(rejected.stopReason, 'error');
    assert.equal(models.ready, false);
    const { errorMessage: _error, ...metadata } = rejected;
    held.push({ type: 'done', reason: 'stop', message: { ...metadata, stopReason: 'stop', content: [{ type: 'text', text: 'Earlier response.' }] } });
    assert.equal((await old.result()).stopReason, 'stop');
    assert.equal((await models.settings()).ready, false, 'Success with an earlier access token does not repair its rejected refresh token');
    assert.deepEqual(models.issue, { code: 'MODEL_OAUTH_REAUTH_REQUIRED', params: { provider: 'ChatGPT' } });
  } finally { models.close(); db.close(); }
});

test('selection validation rejects unknown providers, unknown models and unsupported levels', async () => {
  const { db, models } = service();
  await assert.rejects(models.select({ provider: 'nope', model: 'x', thinkingLevel: 'high' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, model: 'gone/model', thinkingLevel: 'high' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, thinkingLevel: 'off' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, thinkingLevel: 'ludicrous' }));
  assert.deepEqual(models.selection(), { ...stealth, thinkingLevel: 'high' }, 'failed selection must not overwrite the saved choice');
  db.close();
});

test('settings enumerates pi-ai providers and catalog models without leaking secrets', async () => {
  const { db, models, credentials } = service();
  await credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-stored-key' }));
  const settings = await models.settings();
  assert.ok(settings.providers.length > 20, 'pi-ai catalog lists many providers');
  const openrouter = settings.providers.find((p) => p.id === 'openrouter')!;
  assert.equal(openrouter.name, 'OpenRouter');
  assert.ok(openrouter.models > 100);
  assert.equal(openrouter.auth.apiKey?.login, true);
  assert.equal(openrouter.auth.oauth?.name, 'OpenRouter OAuth');
  assert.deepEqual(openrouter.configured, { type: 'api_key' });
  assert.ok(!JSON.stringify(settings).includes('synthetic-stored-key'));
  const list = models.modelsOf('openrouter');
  const model = list.find((m) => m.id === stealth.model)!;
  assert.equal(model.reasoning, true);
  assert.ok(model.thinkingLevels.includes('high'));
  assert.ok(model.contextWindow > 0);
  assert.throws(() => models.modelsOf('nope'), BusinessError);
  db.close();
});

test('model requests and native sessions use only the app file; logout and reopening never resurrect ambient keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-model-auth-')), path = join(root, 'credentials.json');
  const db = openDatabase(':memory:'), credentials = new FileCredentialStore(path), models = new ModelService(db, { credentials });
  const previous = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.OPENROUTER_API_KEY = 'synthetic-ambient-key'; process.env.ANTHROPIC_API_KEY = 'synthetic-unrelated-key';
  try {
    await models.select({ ...stealth, thinkingLevel: 'high' });
    assert.equal(models.current(), null);
    const model = models.resolve(models.selection()!)!, native = await models.sessionRuntime(model);
    assert.equal(await native.checkAuth(model.provider), undefined);
    assert.equal(await native.getAuth(model), undefined);
    assert.deepEqual(native.getProviders().map((provider) => provider.id), ['openrouter']);
    // A session created before a login sees the same credential store afterward.
    await credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-stored-key' }));
    await models.refresh(); assert.ok(models.current());
    assert.equal((await native.getAuth(model))?.auth.apiKey, 'synthetic-stored-key');
    assert.equal((await models.models.getAuth(model))?.auth.apiKey, 'synthetic-stored-key');
    let requests = 0;
    const provider = models.models.getProvider(model.provider)!;
    models.models.setProvider({ ...provider, streamSimple: (_model, _context, options) => {
      requests++; assert.equal(options?.apiKey, 'synthetic-stored-key'); assert.deepEqual(options?.env, {});
      assert.ok(!Object.keys(options?.headers ?? {}).some((name) => name.toLowerCase() === 'authorization'));
      return response(reply([{ type: 'text', text: 'Stored credentials only.' }]));
    } });
    const context = normalizeContext({ messages: [] });
    assert.equal((await (await models.stream(model, context, { apiKey: 'synthetic-request-key', env: { OPENROUTER_API_KEY: 'synthetic-request-env' },
      headers: { Authorization: 'Bearer synthetic-request-header' } })).result()).stopReason, 'stop');
    await models.logout('openrouter');
    assert.equal(models.current(), null);
    assert.equal(await native.getAuth(model), undefined);
    assert.equal((await (await models.stream(model, context)).result()).stopReason, 'error');
    assert.equal(requests, 1, 'missing credentials fail before entering a transport');
    const reopened = new ModelService(db, { credentials: new FileCredentialStore(path) });
    await reopened.refresh(); assert.deepEqual(reopened.issue, { code: 'MODEL_CREDENTIALS_MISSING' });
    assert.equal(await reopened.models.getAuth(model), undefined);
    assert.ok((await reopened.settings()).providers.every((provider) => provider.configured === null));
    reopened.close();
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    models.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('provider transports cannot supplement saved config with ambient endpoints or cloud identities', async (t) => {
  const { db, models, credentials } = service();
  const previous = process.env.AZURE_OPENAI_BASE_URL;
  process.env.AZURE_OPENAI_BASE_URL = 'http://127.0.0.1:1/ambient-endpoint';
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  try {
    assert.equal(models.models.getProvider('amazon-bedrock'), undefined);
    for (const key of [undefined, 'gcp-vertex-credentials', '<service-account>']) {
      await credentials.modify('google-vertex', async () => ({ type: 'api_key', key,
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/external/credentials.json', GOOGLE_CLOUD_PROJECT: 'external', GOOGLE_CLOUD_LOCATION: 'global' } }));
      assert.equal(await models.models.checkAuth('google-vertex'), undefined);
    }
    await credentials.modify('google-vertex', async () => ({ type: 'api_key', key: 'synthetic-stored-vertex-key' }));
    assert.deepEqual(await models.models.checkAuth('google-vertex'), { type: 'api_key' });
    await credentials.modify('azure-openai-responses', async () => ({ type: 'api_key', key: 'synthetic-stored-azure-key' }));
    const model = { ...models.models.getModels('azure-openai-responses')[0]!, baseUrl: '' }, context = normalizeContext({ messages: [] });
    const native = await models.sessionRuntime(model);
    for (const result of [await (await models.stream(model, context)).result(), await native.streamSimple(model, context).result()]) {
      assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage!, /Azure OpenAI base URL is required/);
    }
    assert.equal(request.mock.callCount(), 0, 'an ambient endpoint must never receive a saved credential');
  } finally {
    if (previous === undefined) delete process.env.AZURE_OPENAI_BASE_URL; else process.env.AZURE_OPENAI_BASE_URL = previous;
    models.close(); db.close();
  }
});

test('native OAuth refresh writes back to the same private credential file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-oauth-refresh-')), path = join(root, 'credentials.json');
  const db = openDatabase(':memory:'), credentials = new FileCredentialStore(path), models = new ModelService(db, { credentials });
  const original = { type: 'oauth' as const, access: 'synthetic-expired-access', refresh: 'synthetic-old-refresh', expires: 0 };
  const renewed = { ...original, access: 'synthetic-renewed-access', refresh: 'synthetic-new-refresh', expires: Date.now() + 3_600_000 };
  let refreshes = 0;
  try {
    await credentials.modify('openai', async () => original);
    const provider = models.models.getProvider('openai')!;
    models.models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!,
      refresh: async (saved) => { assert.deepEqual(saved, original); refreshes++; return renewed; },
      toAuth: async (saved) => ({ apiKey: saved.access }),
    } } });
    const model = models.resolve({ provider: 'openai', model: 'gpt-6.1-sol', thinkingLevel: 'high' })!;
    const native = await models.sessionRuntime(model);
    assert.equal(refreshes, 0, 'creating a native session must not refresh or make a request');
    assert.equal((await native.getAuth(model))?.auth.apiKey, renewed.access);
    assert.deepEqual(await new FileCredentialStore(path).read('openai'), renewed);
    assert.equal((await models.models.getAuth(model))?.auth.apiKey, renewed.access);
    assert.equal(refreshes, 1);
    assert.doesNotMatch(JSON.stringify(await models.settings()), /synthetic-.*(access|refresh)/);
  } finally { models.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

// A fully offline provider: login asks for a secret and stores it; auth is
// never ambiently configured.
const noTransport = () => { throw new Error('synthetic provider has no transport'); };
function installSynthetic(models: ModelService) {
  models.models.setProvider(createProvider({
    id: 'synthetic', name: 'Synthetic', models: [],
    api: { stream: noTransport, streamSimple: noTransport },
    auth: {
      apiKey: {
        name: 'Synthetic key',
        login: async (interaction) => ({ type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Enter the key.' }) }),
        resolve: async () => undefined,
      },
    },
  }));
}
async function waitFor<T>(read: () => T, match: (value: T) => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (match(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

test('api-key login prompts for a secret, persists the credential, and sessions can be cancelled', async () => {
  const { db, models } = service();
  installSynthetic(models);
  const session = models.login('synthetic', { type: 'api_key' });
  assert.equal(session.providerId, 'synthetic');
  assert.equal(session.state, 'running');
  const pending = await waitFor(() => models.getLogin(session.id), (s) => s.prompt !== null, 'secret prompt');
  assert.equal(pending.prompt!.type, 'secret');
  assert.equal(pending.prompt!.message, 'Enter the key.');
  const promptId = pending.prompt!.id;
  assert.throws(() => models.answerLogin(session.id, { promptId: '00000000-0000-4000-8000-000000000000', value: 'x' }), BusinessError);
  const answered = models.answerLogin(session.id, { promptId, value: 'synthetic-key-value' });
  assert.equal(answered.prompt, null);
  const done = await waitFor(() => models.getLogin(session.id), (s) => s.state !== 'running', 'login to settle');
  assert.equal(done.state, 'succeeded');
  assert.ok(!JSON.stringify(done).includes('synthetic-key-value'), 'typed secrets never surface in session state');
  // The credential went to the app store, not the session or the wire.
  assert.equal(await models.models.checkAuth('synthetic'), undefined, 'synthetic resolve stays unconfigured');
  assert.equal((await models.settings()).providers.find((p) => p.id === 'synthetic')?.stored, 'api_key');
  assert.throws(() => models.answerLogin(session.id, { promptId, value: 'late' }), BusinessError, 'finished sessions reject answers');
  // Cancellation settles the session and stores nothing.
  const second = models.login('synthetic', { type: 'api_key' });
  await waitFor(() => models.getLogin(second.id), (s) => s.prompt !== null, 'second prompt');
  models.cancelLogin(second.id);
  const cancelled = await waitFor(() => models.getLogin(second.id), (s) => s.state !== 'running', 'cancellation');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error, null);
  assert.throws(() => models.login('synthetic', { type: 'oauth' }), BusinessError, 'provider without oauth rejects it');
  assert.throws(() => models.login('nope', { type: 'api_key' }), BusinessError);
  await assert.rejects(models.logout('nope'), BusinessError);
  db.close(); models.close();
});

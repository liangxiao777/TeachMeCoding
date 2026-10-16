import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { openDatabase } from '../storage/database.js';
import { ModelService } from './service.js';
import { BusinessError } from '../modules/learning.js';

const env = (name: string) => name === 'OPENROUTER_API_KEY' ? 'synthetic-env-key' : undefined;
const noenv = () => undefined;
const stealth = { provider: 'openrouter', model: 'stealth/space-bunny-alpha' };

function service(db = openDatabase(':memory:'), lookup: (n: string) => string | undefined = noenv, fallback = stealth) {
  const models = new ModelService(db, { env: lookup, fallback });
  return { db, models };
}

test('fallback selection is used only until an explicit choice is saved', async () => {
  const { db, models } = service();
  assert.deepEqual(models.selection(), { ...stealth, thinkingLevel: 'high' });
  await models.select({ ...stealth, thinkingLevel: 'low' });
  assert.deepEqual(models.selection(), { ...stealth, thinkingLevel: 'low' });
  // A second service over the same database restores the saved choice.
  const again = new ModelService(db, { env: noenv, fallback: null });
  assert.deepEqual(again.selection(), { ...stealth, thinkingLevel: 'low' });
  // Without fallback and without a saved choice there is no selection at all.
  const empty = new ModelService(openDatabase(':memory:'), { env: noenv, fallback: null });
  assert.equal(empty.selection(), null);
  assert.equal(empty.current(), null);
  db.close();
});

test('readiness reports the exact missing piece instead of a bare unavailable', async () => {
  const { db, models } = service();
  await models.refresh();
  assert.equal(models.current(), null, 'provider key missing, so not ready');
  assert.match((await models.settings()).issue!, /凭据/);
  const keyed = service(openDatabase(':memory:'), env).models;
  await keyed.refresh();
  assert.notEqual(keyed.current(), null);
  const settings = await keyed.settings();
  assert.equal(settings.ready, true);
  assert.equal(settings.issue, null);
  // A saved model that is gone from the catalog is a distinct, actionable issue.
  const lost = service();
  lost.db.prepare("INSERT INTO app_settings VALUES ('model', ?)").run(JSON.stringify({ provider: 'openrouter', model: 'gone/model', thinkingLevel: 'high' }));
  await lost.models.refresh();
  assert.equal(lost.models.current(), null);
  assert.match((await lost.models.settings()).issue!, /目录/);
  db.close(); lost.db.close();
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
    const models = new ModelService(db, { env, credentials, fallback: { provider: 'openai', model: 'gpt-6.1-sol' } });
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
      assert.deepEqual(await credentials.read('openai'), original, 'Rejected credentials are preserved for explicit recovery');
      assert.doesNotMatch(JSON.stringify(settings), /synthetic-.*secret|"private"/);
      await models.refresh();
      assert.equal(models.ready, !rejected, 'A presence-only refresh must not erase a known rejection');
      if (!rejected) continue;
      assert.equal(settings.issue, 'ChatGPT 登录已失效，请在应用设置中重新登录。');
      await models.select({ ...stealth, thinkingLevel: 'high' });
      assert.equal(models.ready, true, 'The failure is scoped to its provider');
      await models.select({ provider: 'openai', model: model.id, thinkingLevel: 'high' });
      assert.equal(models.ready, false, 'Reselecting a model is not reauthentication');
      const login = models.login('openai', { type: 'oauth' });
      await waitFor(() => models.getLogin(login.id), (s) => s.state === 'succeeded', 'OAuth reconnection');
      await models.refresh();
      assert.equal(models.ready, true);
      assert.equal((await models.settings()).providers.find((p) => p.id === 'openai')?.issue, undefined);
      assert.equal((await credentials.read('openai'))?.type, 'oauth');
    } finally { models.close(); db.close(); }
  }
});

test('an older successful request cannot clear a known OAuth refresh rejection', async () => {
  const db = openDatabase(':memory:'), credentials = new InMemoryCredentialStore();
  const credential = { type: 'oauth' as const, access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 };
  await credentials.modify('openai', async () => credential);
  const models = new ModelService(db, { env: noenv, credentials, fallback: { provider: 'openai', model: 'gpt-6.1-sol' } });
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
    assert.equal(models.issue, 'ChatGPT 登录已失效，请在应用设置中重新登录。');
  } finally { models.close(); db.close(); }
});

test('selection validation rejects unknown providers, unknown models and unsupported levels', async () => {
  const { db, models } = service();
  await assert.rejects(models.select({ provider: 'nope', model: 'x', thinkingLevel: 'high' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, model: 'gone/model', thinkingLevel: 'high' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, thinkingLevel: 'off' }), BusinessError);
  await assert.rejects(models.select({ ...stealth, thinkingLevel: 'ludicrous' }));
  assert.deepEqual(models.selection(), { ...stealth, thinkingLevel: 'high' }, 'failed selection must not overwrite the fallback');
  db.close();
});

test('settings enumerates pi-ai providers and catalog models without leaking secrets', async () => {
  const { db, models } = service(undefined, env);
  const settings = await models.settings();
  assert.ok(settings.providers.length > 20, 'pi-ai catalog lists many providers');
  const openrouter = settings.providers.find((p) => p.id === 'openrouter')!;
  assert.equal(openrouter.name, 'OpenRouter');
  assert.ok(openrouter.models > 100);
  assert.equal(openrouter.auth.apiKey?.login, true);
  assert.equal(openrouter.auth.oauth?.name, 'OpenRouter OAuth');
  assert.deepEqual(openrouter.configured, { type: 'api_key', source: 'OPENROUTER_API_KEY' });
  assert.ok(!JSON.stringify(settings).includes('synthetic-env-key'));
  const list = models.modelsOf('openrouter');
  const model = list.find((m) => m.id === stealth.model)!;
  assert.equal(model.reasoning, true);
  assert.ok(model.thinkingLevels.includes('high'));
  assert.ok(model.contextWindow > 0);
  assert.throws(() => models.modelsOf('nope'), BusinessError);
  db.close();
});

test('native sessions share app credentials and injected auth rather than discovering CLI configuration', async () => {
  const db = openDatabase(':memory:'), credentials = new InMemoryCredentialStore();
  const models = new ModelService(db, { env, credentials, fallback: stealth });
  try {
    await models.refresh();
    const model = models.current()!.model, native = await models.sessionRuntime(model);
    assert.deepEqual(await native.checkAuth(model.provider), { type: 'api_key', source: 'OPENROUTER_API_KEY' });
    assert.equal((await native.getAuth(model))?.auth.apiKey, 'synthetic-env-key');
    // A session created before a login sees the same credential store afterward.
    await credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-stored-key' }));
    assert.equal((await native.getAuth(model))?.auth.apiKey, 'synthetic-stored-key');
    assert.equal((await models.models.getAuth(model))?.auth.apiKey, 'synthetic-stored-key');
    await credentials.delete('openrouter');
    assert.equal((await native.getAuth(model))?.auth.apiKey, 'synthetic-env-key');
    const unconfigured = new ModelService(db, { env: noenv, fallback: stealth });
    const isolated = await unconfigured.sessionRuntime(model);
    assert.equal(await isolated.checkAuth(model.provider), undefined);
    assert.equal(await isolated.getAuth(model), undefined);
  } finally { models.close(); db.close(); }
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

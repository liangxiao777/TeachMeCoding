import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProvider } from '@earendil-works/pi-ai';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';
import { ModelService } from '../models/service.js';
import { openDatabase } from '../storage/database.js';

const stealth = { provider: 'openrouter', model: 'stealth/space-bunny-alpha' };

async function fixture() {
  const access = createLocalAccess({ port: 4310 });
  const db = openDatabase(':memory:');
  const models = new ModelService(db, { env: () => undefined, fallback: stealth });
  await models.refresh();
  const app = createApp(access, undefined, undefined, undefined, models);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token, 'content-type': 'application/json' };
  return { app, headers, db, models };
}
async function getLogin(app: ReturnType<typeof createApp>, headers: Record<string, string>, id: string) {
  return (await app.request(`/api/settings/login/${id}`, { headers })).json();
}

test('model settings endpoints serve the catalog, persist selection and validate input', async () => {
  const { app, headers, db } = await fixture();
  const initial = await app.request('/api/settings/model', { headers });
  assert.equal(initial.status, 200);
  const settings = await initial.json();
  assert.equal(settings.ready, false);
  assert.match(settings.issue, /凭据/);
  assert.deepEqual(settings.selection, { ...stealth, thinkingLevel: 'high' });
  assert.ok(settings.providers.some((p: { id: string; models: number }) => p.id === 'openrouter' && p.models > 100));
  const list = await (await app.request('/api/settings/providers/openrouter/models', { headers })).json();
  const model = list.find((m: { id: string }) => m.id === stealth.model);
  assert.equal(model.reasoning, true);
  assert.ok(model.thinkingLevels.includes('high'));
  assert.equal((await app.request('/api/settings/providers/nope/models', { headers })).status, 404);
  const saved = await app.request('/api/settings/model', { method: 'POST', headers,
    body: JSON.stringify({ ...stealth, thinkingLevel: 'low' }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).selection.thinkingLevel, 'low');
  const invalid = await app.request('/api/settings/model', { method: 'POST', headers,
    body: JSON.stringify({ ...stealth, thinkingLevel: 'off' }) });
  assert.equal(invalid.status, 422);
  const malformed = await app.request('/api/settings/model', { method: 'POST', headers, body: JSON.stringify({ provider: 1 }) });
  assert.equal(malformed.status, 400);
  db.close();
});

test('login endpoints drive a complete prompt/answer flow and reject bad input', async () => {
  const { app, headers, db, models } = await fixture();
  const noTransport = () => { throw new Error('synthetic provider has no transport'); };
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
  assert.equal((await app.request('/api/settings/providers/nope/login', { method: 'POST', headers,
    body: JSON.stringify({ type: 'api_key' }) })).status, 404);
  assert.equal((await app.request('/api/settings/login/00000000-0000-4000-8000-000000000000', { headers })).status, 404);
  assert.equal((await app.request('/api/settings/providers/synthetic/login', { method: 'POST', headers,
    body: JSON.stringify({ type: 'magic' }) })).status, 400);
  assert.equal((await app.request('/api/settings/providers/synthetic/login', { method: 'POST', headers,
    body: JSON.stringify({ type: 'oauth' }) })).status, 422);
  const started = await (await app.request('/api/settings/providers/synthetic/login', { method: 'POST', headers,
    body: JSON.stringify({ type: 'api_key' }) })).json();
  let state = await getLogin(app, headers, started.id);
  for (let i = 0; i < 200 && !state.prompt; i++) { await new Promise((r) => setTimeout(r, 10)); state = await getLogin(app, headers, started.id); }
  assert.equal(state.prompt?.type, 'secret');
  const answered = await (await app.request(`/api/settings/login/${started.id}/answer`, { method: 'POST', headers,
    body: JSON.stringify({ promptId: state.prompt.id, value: 'synthetic-key-value' }) })).json();
  assert.equal(answered.prompt, null);
  for (let i = 0; i < 200 && state.state === 'running'; i++) { await new Promise((r) => setTimeout(r, 10)); state = await getLogin(app, headers, started.id); }
  assert.equal(state.state, 'succeeded');
  assert.ok(!JSON.stringify(state).includes('synthetic-key-value'));
  const settings = await (await app.request('/api/settings/model', { headers })).json();
  assert.equal(settings.providers.find((p: { id: string }) => p.id === 'synthetic').stored, 'api_key');
  // Logout removes the stored credential.
  await app.request('/api/settings/providers/synthetic/logout', { method: 'POST', headers });
  const after = await (await app.request('/api/settings/model', { headers })).json();
  assert.equal(after.providers.find((p: { id: string }) => p.id === 'synthetic').stored, null);
  db.close(); models.close();
});

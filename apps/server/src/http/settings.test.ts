import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '@earendil-works/pi-ai';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';
import { ModelService } from '../models/service.js';
import { openDatabase } from '../storage/database.js';
import { McpService } from '../extensions/mcp.js';
import { SkillService } from '../extensions/skills.js';
import { SearchService } from '../extensions/search.js';

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

test('MCP and Skills work without a model, retain access protection and reject invalid config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-settings-')), db = openDatabase(':memory:');
  const access = createLocalAccess({ port: 4310 });
  const mcp = new McpService(join(root, 'mcp.json'), { env: () => undefined, cwd: root });
  const skills = new SkillService(db, root);
  const app = createApp(access, undefined, undefined, undefined, undefined, mcp, skills);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token, 'content-type': 'application/json' };
  try {
    assert.equal((await app.request('/api/settings/mcp', { headers: { host: 'localhost:4310' } })).status, 401);
    assert.equal((await app.request('/api/settings/skills', { headers: { ...headers, origin: 'http://evil.invalid' } })).status, 403);
    assert.equal((await app.request('/api/settings/model', { headers })).status, 503);
    const saved = await app.request('/api/settings/mcp', { method: 'POST', headers, body: JSON.stringify({ mcpServers: {
      fixture: { command: '/disabled-fixture', enabled: false, env: { TOKEN: 'synthetic-api-secret' } },
    } }) });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes('synthetic-api-secret'));
    assert.equal((await app.request('/api/settings/mcp', { method: 'POST', headers, body: '{"mcpServers":{"invalid":{}}}' })).status, 400);
    assert.equal((await app.request('/api/settings/mcp/reconnect', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await app.request('/api/settings/skills', { headers })).status, 200);
    assert.equal((await app.request('/api/settings/skills', { method: 'POST', headers, body: '{"paths":["relative"],"disabled":[]}' })).status, 400);
    assert.equal((await app.request('/api/settings/skills/reload', { method: 'POST', headers, body: '{}' })).status, 200);
  } finally { await mcp.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('single-server MCP endpoints validate names, protect mutations and preserve unrelated entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-mcp-api-'));
  const access = createLocalAccess({ port: 4310 });
  const mcp = new McpService(join(root, 'mcp.json'), { env: () => undefined, cwd: root });
  const app = createApp(access, undefined, undefined, undefined, undefined, mcp);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token, 'content-type': 'application/json' };
  const body = JSON.stringify({ name: 'first', configuration: { command: '/not-started', enabled: false } });
  const post = (path: string, body = '{}') => app.request(`/api/settings/mcp${path}`, { method: 'POST', headers, body });
  try {
    assert.equal((await app.request('/api/settings/mcp/servers', { method: 'POST', headers: { host: 'localhost:4310' }, body })).status, 401);
    assert.equal((await app.request('/api/settings/mcp/servers', { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body })).status, 403);
    assert.equal((await post('/servers', body)).status, 201);
    assert.equal((await post('/servers', body)).status, 409);
    assert.equal((await post('/servers', JSON.stringify({ name: 'bad name', configuration: { command: 'node' } }))).status, 400);
    assert.equal((await post('/servers', JSON.stringify({ name: 'second', configuration: { url: 'https://example.invalid/mcp', enabled: false } }))).status, 201);
    assert.equal((await post('/servers/first', JSON.stringify({ name: 'renamed', configuration: { command: '/not-started', enabled: false } }))).status, 200);
    assert.equal((await post('/servers/renamed/reconnect')).status, 200);
    assert.equal((await post('/servers/missing/reconnect')).status, 404);
    assert.equal((await post('/servers/renamed/delete')).status, 200);
    assert.deepEqual(Object.keys(mcp.settings().configuration.mcpServers), ['second']);
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Skills library endpoints protect installation and file access, and complete the managed/reference lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-api-')), db = openDatabase(':memory:');
  const access = createLocalAccess({ port: 4310 }), skills = new SkillService(db, join(root, 'app'));
  const source = join(root, 'source', 'explaining-types'); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: explaining-types\ndescription: Explain type errors when reviewing learner code.\n---\nShow one concrete type error.');
  const app = createApp(access, undefined, undefined, undefined, undefined, undefined, skills);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token, 'content-type': 'application/json' };
  const post = (path: string, input: unknown) => app.request(`/api/settings/skills/${path}`, { method: 'POST', headers, body: JSON.stringify(input) });
  try {
    for (const path of ['install', 'local', 'check', 'update', 'remove']) {
      assert.equal((await app.request(`/api/settings/skills/${path}`, { method: 'POST', headers: { host: 'localhost:4310' }, body: '{}' })).status, 401);
      assert.equal((await app.request(`/api/settings/skills/${path}`, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
    }
    assert.equal((await app.request('/api/settings/skills/details?filePath=/etc/passwd', { headers })).status, 404);
    assert.equal((await app.request('/api/settings/skills/leaderboard', { headers: { host: 'localhost:4310' } })).status, 401);
    assert.equal((await app.request('/api/settings/skills/leaderboard', { headers: { ...headers, origin: 'https://evil.invalid' } })).status, 403);
    for (const query of ['view=unknown', 'page=-1', 'page=1.5', 'page=not-a-number', 'view=hot&extra=1']) {
      assert.equal((await app.request(`/api/settings/skills/leaderboard?${query}`, { headers })).status, 400);
    }
    assert.equal((await post('install', { source: '--global' })).status, 400);
    assert.equal((await post('local', { path: 'relative' })).status, 400);
    assert.equal((await post('install', {})).status, 400);
    const installed = await post('install', { source, skill: 'explaining-types' });
    assert.equal(installed.status, 201);
    const item = (await installed.json()).skills[0];
    assert.equal(item.enabled, true); assert.equal(item.installation.cliVersion, '1.7.0');
    const query = `filePath=${encodeURIComponent(item.filePath)}`;
    const details = await (await app.request(`/api/settings/skills/details?${query}`, { headers })).json();
    assert.match(details.content, /concrete type error/);
    assert.equal((await app.request(`/api/settings/skills/file?${query}&name=../../credentials.json`, { headers })).status, 400);
    assert.equal((await post('check', { filePath: item.filePath })).status, 200);
    assert.equal((await post('update', { filePath: item.filePath })).status, 200);
    assert.equal((await post('remove', { filePath: item.filePath })).status, 200);
    assert.equal(existsSync(item.filePath), false); assert.equal(existsSync(join(source, 'SKILL.md')), true);
    const local = await post('local', { path: source }); assert.equal(local.status, 200);
    assert.equal((await local.json()).skills[0].installation, null);
    assert.equal((await post('remove', { filePath: join(source, 'SKILL.md') })).status, 200);
    assert.equal(existsSync(join(source, 'SKILL.md')), true);
    assert.equal((await (await app.request('/api/settings/skills', { headers })).json()).skills.length, 0);
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('search settings and diagnostics work without a model, protect every route and never return credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-search-api-')), access = createLocalAccess({ port: 4310 });
  let requests = 0, failed = false;
  const search = new SearchService(join(root, 'search.json'), { env: () => undefined, fetch: async (_url, options) => {
    requests++; assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-search-secret');
    assert.deepEqual(JSON.parse(String(options?.body)), { query: 'Rust references', max_results: 2 });
    return failed ? new Response('reflected synthetic-search-secret', { status: 401 }) : Response.json({ results: [
      { title: 'Rust reference', url: 'https://doc.rust-lang.org/reference/', content: 'Language reference' },
    ] });
  } });
  const app = createApp(access, undefined, undefined, undefined, undefined, undefined, undefined, search);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token, 'content-type': 'application/json' };
  const post = (path: string, input: unknown) => app.request(`/api/settings/search${path}`, { method: 'POST', headers, body: JSON.stringify(input) });
  try {
    for (const [path, method] of [['', 'GET'], ['', 'POST'], ['/test', 'POST']] as const) {
      assert.equal((await app.request(`/api/settings/search${path}`, { method, headers: { host: 'localhost:4310' } })).status, 401);
      assert.equal((await app.request(`/api/settings/search${path}`, { method, headers: { ...headers, origin: 'https://evil.invalid' } })).status, 403);
    }
    const initial = await app.request('/api/settings/search', { headers }); assert.equal(initial.status, 200);
    assert.equal((await initial.json()).enabled, false);
    assert.equal((await app.request('/api/settings/model', { headers })).status, 503);
    assert.equal((await post('/test', { query: 'Rust references', count: 2 })).status, 422);
    for (const input of [{ provider: 'invalid' }, {}, { enabled: 1 }, { apiKey: 'bad\r\nheader' }, { provider: 'tavily', unknown: true }]) {
      assert.equal((await post('', input)).status, 400);
    }
    const saved = await post('', { provider: 'tavily', apiKey: 'synthetic-search-secret' });
    assert.equal(saved.status, 200); assert.doesNotMatch(await saved.text(), /synthetic-search-secret/);
    assert.equal(requests, 0, 'saving must not make a paid network request');
    for (const input of [{ query: ' ' }, { query: 'Rust references', count: 11 }, { query: 'Rust references', apiKey: 'must-not-accept' }]) {
      assert.equal((await post('/test', input)).status, 400);
    }
    const tested = await post('/test', { query: 'Rust references', count: 2 }); assert.equal(tested.status, 200);
    assert.deepEqual((await tested.json()).results, [{ title: 'Rust reference', url: 'https://doc.rust-lang.org/reference/', snippet: 'Language reference' }]);
    assert.equal((await search.settings()).enabled, false); assert.equal(requests, 1);
    failed = true;
    const failure = await post('/test', { query: 'Rust references', count: 2 }); assert.equal(failure.status, 503);
    assert.doesNotMatch(await failure.text(), /synthetic-search-secret|reflected/);
    assert.equal((await post('', { enabled: true })).status, 200); assert.equal((await search.tools()).length, 1);
    assert.equal((await post('', { enabled: false })).status, 200); assert.deepEqual(await search.tools(), []);
    assert.doesNotMatch(await (await app.request('/api/settings/search', { headers })).text(), /synthetic-search-secret/);
    assert.equal((await createApp(access, undefined, undefined, undefined, undefined, new McpService(join(root, 'mcp.json'), { env: () => undefined, cwd: root }))
      .request('/api/settings/search', { headers })).status, 503);
  } finally { search.close(); rmSync(root, { recursive: true, force: true }); }
});

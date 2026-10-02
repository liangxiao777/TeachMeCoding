import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';

test('health has a shared public shape; unknown API paths never return SPA HTML', async () => {
  const access = createLocalAccess({ port: 4310 });
  const app = createApp(access);
  const headers = { host: 'localhost:4310', 'x-tmc-token': access.token };
  const health = await app.request('/api/health', { headers });
  assert.deepEqual(await health.json(), { status: 'ok', service: 'teach-me-coding' });
  for (const path of ['/api', '/api/no-such-endpoint']) {
    const response = await app.request(path, { headers });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type')!, /application\/json/);
  }
});

test('token bootstrap requires a local custom-header request and protected checks have no side effects', async () => {
  const app = createApp(createLocalAccess({ port: 4310 }));
  const headers = { host: 'localhost:4310', 'x-tmc-client': 'browser' };
  assert.equal((await app.request('/api/access', { headers: { host: 'localhost:4310' } })).status, 403);
  assert.equal((await app.request('/api/access', { headers: { ...headers, origin: 'http://evil.test' } })).status, 403);
  const bootstrap = await app.request('/api/access', { headers });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.equal(bootstrap.headers.get('access-control-allow-origin'), null);
  const { token } = await bootstrap.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await app.request('/api/access/check', { method: 'POST', headers })).status, 401);
  const checked = await app.request('/api/access/check', { method: 'POST', headers: { ...headers, 'x-tmc-token': token } });
  assert.deepEqual(await checked.json(), { ok: true });
  const preflight = await app.request('/api/access', { method: 'OPTIONS', headers: {
    ...headers, origin: 'http://evil.test', 'access-control-request-headers': 'x-tmc-client',
  } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

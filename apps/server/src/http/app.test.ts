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
    assert.deepEqual(await response.json(), { code: 'NOT_FOUND' });
  }
});

test('token bootstrap requires a local custom-header request and protected checks have no side effects', async () => {
  const app = createApp(createLocalAccess({ port: 4310 }));
  const headers = { host: 'localhost:4310', 'x-tmc-client': 'browser' };
  const noClient = await app.request('/api/access', { headers: { host: 'localhost:4310' } });
  assert.equal(noClient.status, 403);
  assert.deepEqual(await noClient.json(), { code: 'LOCAL_CLIENT_REQUIRED' });
  const denied = await app.request('/api/access', { headers: { ...headers, origin: 'http://evil.test' } });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { code: 'LOCAL_ACCESS_DENIED' });
  const bootstrap = await app.request('/api/access', { headers });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.equal(bootstrap.headers.get('access-control-allow-origin'), null);
  const { token } = await bootstrap.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const noToken = await app.request('/api/access/check', { method: 'POST', headers });
  assert.equal(noToken.status, 401);
  assert.deepEqual(await noToken.json(), { code: 'REQUEST_TOKEN_REQUIRED' });
  const checked = await app.request('/api/access/check', { method: 'POST', headers: { ...headers, 'x-tmc-token': token } });
  assert.deepEqual(await checked.json(), { ok: true });
  const preflight = await app.request('/api/access', { method: 'OPTIONS', headers: {
    ...headers, origin: 'http://evil.test', 'access-control-request-headers': 'x-tmc-client',
  } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('preview enables trusted frame documents and module origins without opening cross-site APIs', async () => {
  const previewOrigin = 'http://127.0.0.1:54492';
  const normal = createApp(createLocalAccess({ port: 4310 }));
  const access = createLocalAccess({ port: 4310, previewOrigin });
  const app = createApp(access);
  const headers = { host: '127.0.0.1:4310' };
  const normalPage = await normal.request('/', { headers });
  assert.equal(normalPage.headers.get('x-frame-options'), 'DENY');
  assert.match(normalPage.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const page = await app.request('/', { headers });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.ok(page.headers.get('content-security-policy')!.includes(`frame-ancestors 'self' ${previewOrigin} vscode-webview: vscode-file://vscode-app`));
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)![1]!;
  assert.equal((await app.request(asset, { headers: { ...headers, origin: previewOrigin } })).status, 200);
  assert.equal((await normal.request(asset, { headers: { ...headers, origin: previewOrigin } })).status, 403);
  const framed = { ...headers, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
  assert.equal((await app.request('/', { headers: framed })).status, 200);
  assert.equal((await normal.request('/', { headers: framed })).status, 403);
  for (const path of ['/api/health', '/api/access', '/api/access/check']) {
    assert.equal((await app.request(path, { headers: { ...framed, 'x-tmc-client': 'browser', 'x-tmc-token': access.token } })).status, 403);
  }
  const bootstrap = await app.request('/api/access', { headers: { ...headers, origin: previewOrigin, 'x-tmc-client': 'browser' } });
  assert.equal(bootstrap.status, 200);
  const { token } = await bootstrap.json();
  assert.equal((await app.request('/api/access/check', { method: 'POST', headers: { ...headers, origin: previewOrigin, 'x-tmc-token': token } })).status, 200);
  assert.equal((await app.request('/api/access/check', { method: 'POST', headers: { ...headers, origin: previewOrigin } })).status, 401);
  assert.equal((await app.request('/api/access', { headers: { ...headers, origin: 'http://evil.test', 'x-tmc-client': 'browser' } })).status, 403);
});

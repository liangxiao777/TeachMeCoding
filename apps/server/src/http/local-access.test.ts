import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { createLocalAccess, localAccessError } from './local-access.js';

test('network binding admits only this machine’s IPv4 authorities and keeps request protection', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ en0: ['192.0.2.23', '198.51.100.27'].map((address) => ({
    address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null,
  })) }));
  const access = createLocalAccess({ hostname: '0.0.0.0', port: 4310 });
  for (const host of ['192.0.2.23:4310', '198.51.100.27:4310']) {
    const headers = new Headers({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(localAccessError(headers, createLocalAccess({ port: 4310 })), 403);
    assert.equal(localAccessError(headers, access, { requireToken: true }), 401);
    headers.set('x-tmc-token', access.token);
    assert.equal(localAccessError(headers, access, { requireToken: true }), undefined);
    headers.set('origin', 'http://evil.test');
    assert.equal(localAccessError(headers, access, { requireToken: true }), 403);
  }
  for (const host of ['192.0.2.24:4310', '192.0.2.23:5173', '192.0.2.23.evil.test:4310']) {
    assert.equal(localAccessError(new Headers({ host, 'x-forwarded-host': '192.0.2.23:4310' }), access), 403);
  }
  const proxy = new Headers({ host: '192.0.2.23:15173', origin: 'http://192.0.2.23:15173' });
  const dev = createLocalAccess({ hostname: '0.0.0.0', port: 4310, development: true, webPort: 15173 });
  assert.equal(localAccessError(proxy, access), 403);
  assert.equal(localAccessError(proxy, dev), undefined);
  proxy.set('sec-fetch-site', 'cross-site');
  assert.equal(localAccessError(proxy, dev), 403);
});

test('Host and Origin use exact allowed authorities; forwarded headers cannot grant access', () => {
  const access = createLocalAccess({ port: 4310 });
  for (const host of ['127.0.0.1:4310', 'localhost:4310']) {
    assert.equal(localAccessError(new Headers({ host, origin: `http://${host}` }), access), undefined);
  }
  for (const host of ['', 'evil.test:4310', '127.0.0.1:4311', '127.0.0.1.evil.test:4310', 'localhost:4310,evil.test']) {
    assert.equal(localAccessError(new Headers({ host, 'x-forwarded-host': 'localhost:4310' }), access), 403);
  }
  for (const origin of ['', 'null', 'http://evil.test', 'https://localhost:4310', 'http://localhost:4311', 'http://localhost:4310/']) {
    assert.equal(localAccessError(new Headers({ host: 'localhost:4310', origin }), access), 403);
  }
});

test('development admits only its proxy origins, which production rejects', () => {
  const headers = new Headers({ host: 'localhost:5173', origin: 'http://localhost:5173' });
  assert.equal(localAccessError(headers, createLocalAccess({ port: 4310, development: true })), undefined);
  assert.equal(localAccessError(headers, createLocalAccess({ port: 4310 })), 403);
  for (const site of ['same-site', 'cross-site']) {
    assert.equal(localAccessError(new Headers({ host: 'localhost:4310', 'sec-fetch-site': site }), createLocalAccess({ port: 4310 })), 403);
  }
});

test('sensitive HTTP operations reject absent, malformed, wrong and old-instance tokens', () => {
  const access = createLocalAccess({ port: 4310 });
  const headers = new Headers({ host: 'localhost:4310' });
  for (const token of ['', 'x', '0'.repeat(64), createLocalAccess({ port: 4310 }).token]) {
    headers.set('x-tmc-token', token);
    assert.equal(localAccessError(headers, access, { requireToken: true }), 401);
  }
  headers.set('x-tmc-token', access.token);
  assert.equal(localAccessError(headers, access, { requireToken: true }), undefined);
});

test('terminal upgrades require an Origin and a protocol token, never a query/header shortcut', () => {
  const access = createLocalAccess({ port: 4310 });
  const headers = new Headers({ host: 'localhost:4310', 'x-tmc-token': access.token });
  assert.equal(localAccessError(headers, access, { websocket: true }), 403);
  headers.set('origin', 'http://localhost:4310');
  assert.equal(localAccessError(headers, access, { websocket: true }), 401);
  headers.set('sec-websocket-protocol', `tmc-terminal, tmc-token.${access.token}`);
  assert.equal(localAccessError(headers, access, { websocket: true }), undefined);
  headers.set('origin', 'http://evil.test');
  assert.equal(localAccessError(headers, access, { websocket: true }), 403);
});

test('preview grants one origin while preserving Host, Origin and token boundaries', () => {
  const previewOrigin = 'http://127.0.0.1:54492';
  const access = createLocalAccess({ port: 4310, previewOrigin });
  const headers = new Headers({ host: '127.0.0.1:4310', origin: previewOrigin, 'sec-fetch-site': 'same-origin' });
  assert.equal(localAccessError(headers, createLocalAccess({ port: 4310 })), 403);
  assert.equal(localAccessError(headers, access), undefined);
  assert.equal(localAccessError(headers, access, { requireToken: true }), 401);
  headers.set('x-tmc-token', access.token);
  assert.equal(localAccessError(headers, access, { requireToken: true }), undefined);
  headers.set('host', '127.0.0.1:54492');
  assert.equal(localAccessError(headers, access, { requireToken: true }), undefined);
  headers.set('host', '127.0.0.1:4310');
  for (const origin of ['http://127.0.0.1:54493', 'http://localhost:54492', 'http://evil.test', 'null']) {
    headers.set('origin', origin);
    assert.equal(localAccessError(headers, access, { requireToken: true }), 403);
  }
  headers.set('origin', previewOrigin);
  headers.set('host', 'evil.test:4310');
  headers.set('x-forwarded-host', '127.0.0.1:4310');
  assert.equal(localAccessError(headers, access, { requireToken: true }), 403);
  headers.set('host', '127.0.0.1:4310');
  for (const site of ['same-site', 'cross-site']) {
    headers.set('sec-fetch-site', site);
    assert.equal(localAccessError(headers, access, { requireToken: true }), 403);
  }
  headers.set('sec-fetch-site', 'same-origin');
  assert.equal(localAccessError(headers, access, { websocket: true }), 401);
  headers.set('sec-websocket-protocol', `tmc-terminal, tmc-token.${access.token}`);
  assert.equal(localAccessError(headers, access, { websocket: true }), undefined);
  headers.delete('origin');
  assert.equal(localAccessError(headers, access, { websocket: true }), 403);
  assert.throws(() => createLocalAccess({ port: 4310, previewOrigin: 'http://evil.test' }), /TMC_PREVIEW_ORIGIN/);
});

test('preview frame navigation exception never admits API, token or Origin shortcuts', () => {
  const access = createLocalAccess({ port: 4310, previewOrigin: 'http://127.0.0.1:54492' });
  const headers = new Headers({ host: '127.0.0.1:4310', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' });
  assert.equal(localAccessError(headers, createLocalAccess({ port: 4310 }), { documentNavigation: true }), 403);
  assert.equal(localAccessError(headers, access), 403);
  assert.equal(localAccessError(headers, access, { documentNavigation: true }), undefined);
  assert.equal(localAccessError(headers, access, { documentNavigation: true, requireToken: true }), 403);
  assert.equal(localAccessError(headers, access, { documentNavigation: true, websocket: true }), 403);
  headers.set('origin', 'http://evil.test');
  assert.equal(localAccessError(headers, access, { documentNavigation: true }), 403);
  headers.delete('origin');
  headers.set('sec-fetch-dest', 'script');
  assert.equal(localAccessError(headers, access, { documentNavigation: true }), 403);
  headers.set('sec-fetch-dest', 'iframe');
  headers.set('sec-fetch-mode', 'cors');
  assert.equal(localAccessError(headers, access, { documentNavigation: true }), 403);
});

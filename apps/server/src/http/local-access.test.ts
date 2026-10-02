import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAccess, localAccessError } from './local-access.js';

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

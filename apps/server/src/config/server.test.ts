import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverConfig } from './server.js';

test('network binding is explicit and host and ports are validated', () => {
  assert.deepEqual(serverConfig({}), { hostname: '127.0.0.1', port: 4310, development: false });
  assert.deepEqual(serverConfig({ HOST: '0.0.0.0' }), { hostname: '0.0.0.0', port: 4310, development: false });
  assert.deepEqual(serverConfig({ PORT: '4311', NODE_ENV: 'development' }), { hostname: '127.0.0.1', port: 4311, development: true });
  for (const HOST of ['', 'localhost', '0.0.0.0:4310', '::', 'evil.test']) {
    assert.throws(() => serverConfig({ HOST }), /HOST must be/);
  }
  for (const PORT of ['', '0', '-1', '65536', '4.2', '0x10', 'invalid']) {
    assert.throws(() => serverConfig({ PORT }), /PORT must be an integer/);
    assert.throws(() => serverConfig({ TMC_WEB_PORT: PORT }), /TMC_WEB_PORT must be an integer/);
  }
  assert.equal(serverConfig({ TMC_WEB_PORT: '15173' }).webPort, 15173);
});

test('preview origins are explicit canonical HTTP loopback origins', () => {
  assert.equal(serverConfig({ TMC_PREVIEW_ORIGIN: 'http://127.0.0.1:54492/' }).previewOrigin, 'http://127.0.0.1:54492');
  assert.equal(serverConfig({ TMC_PREVIEW_ORIGIN: 'http://localhost:5174' }).previewOrigin, 'http://localhost:5174');
  assert.equal(serverConfig({ TMC_PREVIEW_ORIGIN: 'http://localhost:80' }).previewOrigin, 'http://localhost');
  for (const TMC_PREVIEW_ORIGIN of ['', '*', 'null', 'https://localhost:54492', 'http://evil.test:54492', 'http://192.168.1.2:54492', 'http://127.0.0.1.evil.test:54492', 'http://user@localhost:54492', 'http://localhost:0', 'http://localhost:65536', 'http://localhost:54492/path', 'http://localhost:54492?x=1', 'http://localhost:54492#x', ' http://localhost:54492', 'http://localhost:54492\n', 'http://127.1:54492']) {
    assert.throws(() => serverConfig({ TMC_PREVIEW_ORIGIN }), /TMC_PREVIEW_ORIGIN/);
  }
});

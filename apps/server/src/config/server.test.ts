import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverConfig } from './server.js';

test('local bind cannot be overridden and ports are validated', () => {
  assert.deepEqual(serverConfig({ HOST: '0.0.0.0' }), { hostname: '127.0.0.1', port: 4310, development: false });
  assert.deepEqual(serverConfig({ PORT: '4311', NODE_ENV: 'development' }), { hostname: '127.0.0.1', port: 4311, development: true });
  for (const PORT of ['', '0', '-1', '65536', '4.2', '0x10', 'invalid']) {
    assert.throws(() => serverConfig({ PORT }), /PORT must be an integer/);
    assert.throws(() => serverConfig({ TMC_WEB_PORT: PORT }), /TMC_WEB_PORT must be an integer/);
  }
  assert.equal(serverConfig({ TMC_WEB_PORT: '15173' }).webPort, 15173);
});

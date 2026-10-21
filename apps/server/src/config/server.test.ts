import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startupEnvironment } from '@teach-me-coding/contracts/startup';
import { serverConfig } from './server.js';

test('startup files load only the six startup options, without exporting credentials or choosing the runtime mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-startup-config-'));
  const path = join(root, '.env');
  const before = process.env.PORT;
  try {
    writeFileSync(path, [
      'TMC_DATA_DIR="/tmp/synthetic data #17"', 'HOST=0.0.0.0', 'PORT=4431 # API', 'TMC_WEB_PORT=5531',
      'TMC_PREVIEW_ORIGIN=http://127.0.0.1:54492', 'TMC_AGENT_DEBUG_SNAPSHOTS=1',
      'NODE_ENV=development', 'OPENROUTER_API_KEY=synthetic-secret', 'OPENROUTER_MODEL=ignored/model',
      'BRAVE_API_KEY=synthetic-search-secret', 'VITE_SECRET=not-public', 'HTTPS_PROXY=http://ignored.test',
    ].join('\n'));
    assert.deepEqual(startupEnvironment({}, path), {
      TMC_DATA_DIR: '/tmp/synthetic data #17', HOST: '0.0.0.0', PORT: '4431', TMC_WEB_PORT: '5531',
      TMC_PREVIEW_ORIGIN: 'http://127.0.0.1:54492', TMC_AGENT_DEBUG_SNAPSHOTS: '1',
    });
    assert.equal(process.env.PORT, before);
    const environment = {
      TMC_DATA_DIR: '/tmp/override', HOST: '127.0.0.1', PORT: '4432', TMC_WEB_PORT: '5532',
      TMC_PREVIEW_ORIGIN: 'http://localhost:54493', TMC_AGENT_DEBUG_SNAPSHOTS: '0', NODE_ENV: 'production',
      OPENROUTER_API_KEY: 'synthetic-ambient-secret',
    };
    const original = { ...environment };
    assert.deepEqual(startupEnvironment(environment, path), {
      TMC_DATA_DIR: '/tmp/override', HOST: '127.0.0.1', PORT: '4432', TMC_WEB_PORT: '5532',
      TMC_PREVIEW_ORIGIN: 'http://localhost:54493', TMC_AGENT_DEBUG_SNAPSHOTS: '0', NODE_ENV: 'production',
    });
    assert.deepEqual(environment, original);
    assert.throws(() => serverConfig(startupEnvironment({ PORT: '' }, path)), /PORT must be an integer/);
    writeFileSync(path, 'TMC_DATA_DIR=${HOME}/data\n');
    assert.equal(startupEnvironment({}, path).TMC_DATA_DIR, '${HOME}/data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a startup file is optional, but unreadable files fail without exposing their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-startup-file-'));
  try {
    assert.deepEqual(startupEnvironment({ HOST: '127.0.0.1', NODE_ENV: 'development' }, join(root, 'missing.env')), { HOST: '127.0.0.1', NODE_ENV: 'development' });
    assert.deepEqual(serverConfig(startupEnvironment({}, join(root, 'missing.env'))), { hostname: '127.0.0.1', port: 4310, development: false });
    assert.throws(() => startupEnvironment({}, root), { message: 'Startup .env file cannot be read.' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

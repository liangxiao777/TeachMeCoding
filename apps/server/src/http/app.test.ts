import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';

test('health has a shared public shape; unknown API paths never return SPA HTML', async () => {
  const app = createApp();
  const health = await app.request('/api/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'teach-me-coding' });
  for (const path of ['/api', '/api/no-such-endpoint']) {
    const response = await app.request(path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type')!, /application\/json/);
  }
});

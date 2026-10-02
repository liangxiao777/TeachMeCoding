import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';

test('all business reads and mutations use local protection, validation and idempotency', async () => {
  const db = openDatabase(':memory:'); const l = new Learning(db);
  const access = createLocalAccess({ port: 14333 }); const app = createApp(access, l);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, extra = {}) => app.request(`http://127.0.0.1:14333/api${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await app.request('/api/spaces', { headers: { Host: headers.Host } })).status, 401);
    assert.equal((await post('/spaces', { name: 'A', goal: 'Learn' }, { Origin: 'http://evil.test' })).status, 403);
    assert.equal((await post('/spaces', { name: 'A', goal: 'Learn' }, { 'X-TMC-Token': '' })).status, 401);
    assert.equal((await post('/spaces', { name: 'A', goal: 'Learn', piState: {} })).status, 400);
    assert.equal(l.list().length, 0);
    const first = await post('/spaces', { name: 'A', goal: 'Learn' });
    assert.equal(first.status, 200);
    const space = await first.json();
    assert.deepEqual(await (await post('/spaces', { name: 'A', goal: 'Learn' })).json(), space);
    assert.equal((await post('/spaces', { name: 'B', goal: 'Learn' })).status, 409);
    const session = space.sessions[0].id;
    const get = await app.request(`/api/spaces/${space.id}/sessions/${session}`, { headers });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal((await post(`/spaces/${space.id}/sessions`, { scope: 'unit', unitId: randomUUID(), title: 'Missing' }, { 'Idempotency-Key': randomUUID() })).status, 404);
    assert.equal((await post(`/spaces/${space.id}/generate`, {}, { 'Idempotency-Key': randomUUID() })).status, 404);
    assert.equal((await app.request(`/api/spaces/${space.id}`, { headers })).status, 200);
    assert.equal(l.list().length, 1);
  } finally { db.close(); }
});

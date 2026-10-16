import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { Projects } from '../modules/projects.js';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';
import { conceptIntake } from '../agents/test-support.js';

test('conversation approval settings are isolated, revisioned and idempotent without consuming drafts', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const access = createLocalAccess({ port: 14333 }), app = createApp(access, learning);
  const space = learning.create({ name: 'Preferences', goal: 'Learn' }), other = learning.create({ name: 'Other', goal: 'Learn' });
  const session = space.sessions[0]!.id, path = `/api/spaces/${space.id}/sessions/${session}/settings`;
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (body: unknown, key = randomUUID(), url = path) => app.request(url, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body),
  });
  try {
    const before = learning.saveSessionDraft(space.id, session, { revision: 0, text: 'Keep this draft', quote: null, routeSuggestion: '' });
    assert.deepEqual(before.settings, { revision: 0, yolo: false });
    for (const invalid of [{ yolo: true }, { revision: 0, yolo: 'true' }, { revision: 0, yolo: true, extra: true }]) {
      assert.equal((await post(invalid)).status, 400);
    }
    assert.equal((await post({ revision: 0, yolo: true }, randomUUID(), `/api/spaces/${other.id}/sessions/${session}/settings`)).status, 404);
    db.exec("CREATE TRIGGER fail_setting BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT, 'injected setting failure'); END");
    const key = randomUUID(), input = { revision: 0, yolo: true };
    assert.equal((await post(input, key)).status, 503);
    assert.deepEqual(learning.session(space.id, session), before);
    db.exec('DROP TRIGGER fail_setting');
    const saved = await post(input, key); assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).settings, { revision: 1, yolo: true });
    assert.equal((await post(input)).status, 409);
    const disabled = await post({ revision: 1, yolo: false }); assert.equal(disabled.status, 200);
    assert.deepEqual((await disabled.json()).settings, { revision: 2, yolo: false });
    // Replaying an old successful request cannot turn the mode back on.
    assert.deepEqual((await (await post(input, key)).json()).settings, { revision: 2, yolo: false });
    const restored = new Learning(db).session(space.id, session);
    assert.deepEqual(restored.draft, before.draft); assert.deepEqual(restored.messages, before.messages);
    assert.deepEqual(restored.settings, { revision: 2, yolo: false });
    assert.equal(learning.session(space.id, space.sessions[1]!.id).settings.yolo, false);
    assert.equal(learning.session(other.id, other.sessions[0]!.id).settings.yolo, false);
  } finally { db.close(); }
});

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

test('space names validate consistently with creation and reject stale edits without changing other data', async () => {
  const db = openDatabase(':memory:'); const l = new Learning(db);
  const access = createLocalAccess({ port: 14333 }); const app = createApp(access, l);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, extra = {}) => app.request(`/api${path}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID(), ...extra }, body: JSON.stringify(body),
  });
  try {
    const space = l.create({ name: 'Original', goal: 'Learn' });
    const other = l.create({ name: 'Other', goal: 'Independent' });
    const path = `/spaces/${space.id}/name`;
    const input = { name: 'Renamed', previousName: space.name };
    for (const name of ['', ' \t\n ', 'x'.repeat(201), null, 42]) {
      assert.equal((await post('/spaces', { name, goal: 'Learn' })).status, 400);
      assert.equal((await post(path, { ...input, name })).status, 400);
    }
    for (const invalid of [{ name: 'Renamed' }, { previousName: space.name }, { ...input, previousName: null }, { ...input, piState: {} }]) {
      assert.equal((await post(path, invalid)).status, 400);
    }
    assert.equal((await post(path, input, { 'X-TMC-Token': '' })).status, 401);
    assert.equal((await post(path, input, { 'Idempotency-Key': '' })).status, 400);
    assert.equal((await post('/spaces/not-a-uuid/name', input)).status, 400);
    assert.equal((await post(`/spaces/${randomUUID()}/name`, input)).status, 404);
    assert.equal((await post(path, { ...input, previousName: ` ${space.name} ` })).status, 409);
    assert.deepEqual(l.space(space.id), space);

    const name = '学'.repeat(200);
    const created = await post('/spaces', { name: ` ${name} `, goal: 'Learn' });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).name, name);
    const renamed = await post(path, { ...input, name: ` \t${name}\n ` });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { id: space.id, name, createdAt: space.createdAt });
    assert.equal((await post(path, input)).status, 409);
    assert.deepEqual(l.space(space.id), { ...space, name });
    assert.deepEqual(l.space(other.id), other);

    // Existing maximum-length names remain editable.
    const previousName = 'x'.repeat(200);
    db.prepare('UPDATE spaces SET name=? WHERE id=?').run(previousName, space.id);
    assert.equal((await post(path, { name: 'Shorter', previousName })).status, 200);
    assert.equal(l.space(space.id).name, 'Shorter');
  } finally { db.close(); }
});

test('space rename and idempotent responses persist after reopening without replaying older edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-name-api-'));
  const databasePath = join(root, 'app.db');
  let db = openDatabase(databasePath);
  let l = new Learning(db);
  const access = createLocalAccess({ port: 14333 }); let app = createApp(access, l);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, key: string) => app.request(`/api${path}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body),
  });
  try {
    const space = l.create({ name: 'Before', goal: 'Learn' });
    const path = `/spaces/${space.id}/name`;
    const input = { name: 'After', previousName: space.name }, key = randomUUID();
    const summary = { id: space.id, name: input.name, createdAt: space.createdAt };
    for (let n = 0; n < 2; n++) {
      const response = await post(path, input, key);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), summary);
    }
    assert.equal((await post(path, { ...input, name: 'Different' }, key)).status, 409);
    assert.equal((await post(path, input, randomUUID())).status, 409);
    const latestInput = { name: 'Latest', previousName: input.name }, latestKey = randomUUID();
    assert.equal((await post(path, latestInput, latestKey)).status, 200);
    const latest = { ...summary, name: latestInput.name };
    const expected = { ...space, name: latest.name };
    assert.deepEqual(l.space(space.id), expected);

    db.close();
    db = openDatabase(databasePath); l = new Learning(db); app = createApp(access, l);
    for (const [body, requestKey, responseBody] of [[input, key, summary], [latestInput, latestKey, latest]] as const) {
      const response = await post(path, body, requestKey);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), responseBody);
    }
    assert.equal((await post(path, input, randomUUID())).status, 409);
    assert.deepEqual(await (await app.request('/api/spaces', { headers })).json(), [latest]);
    assert.deepEqual(await (await app.request(`/api/spaces/${space.id}`, { headers })).json(), expected);
    assert.equal(db.prepare('SELECT * FROM requests').all().length, 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('saving drafts cannot unlock an unstarted unit through its own learning activity', async () => {
  const db = openDatabase(':memory:'); const l = new Learning(db);
  const access = createLocalAccess({ port: 14333 }); const app = createApp(access, l);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => app.request(`/api${path}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body),
  });
  try {
    const space = l.create({ name: 'Sequential learning', goal: 'Learn' });
    l.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: 'Goal?', answer: 'Learn' }] }, intake: conceptIntake, confirmed: true });
    const units = ['First', 'Locked'].map((title) => ({ id: randomUUID(), title, summary: 'Learn in order', goals: ['Explain the concept'] }));
    l.applyProposal(space.id, l.proposeRoute(space.id, space.sessions.find((session) => session.scope === 'route')!.id,
      { note: 'Learn in order', stages: [{ id: randomUUID(), title: 'Stage', units }] }).id);
    const second = units[1]!.id;
    const session = l.createSession(space.id, { scope: 'unit', unitId: second, title: 'Empty session' });
    assert.equal(l.unit(space.id, second).started, false);
    assert.equal((await post(`/spaces/${space.id}/sessions/${session.id}/draft`, { ...session.draft, text: 'Do not unlock myself' })).status, 422);
    assert.equal((await post(`/spaces/${space.id}/units/${second}/draft`, { revision: 0, q1: 'Do not unlock myself', q2: '' })).status, 422);
    assert.equal(l.unit(space.id, second).started, false);
    assert.throws(() => l.assertUnitUnlocked(space.id, second), /尚未解锁/);
    assert.equal(l.session(space.id, session.id).draft.revision, 0);
    assert.equal(l.unit(space.id, second).draft.revision, 0);
    l.saveLesson(space.id, units[0]!.id, { title: 'First lesson', content: 'Published predecessor' });
    assert.equal((await post(`/spaces/${space.id}/sessions/${session.id}/draft`, { ...session.draft, text: 'Now accessible' })).status, 200);
    assert.equal((await post(`/spaces/${space.id}/units/${second}/draft`, { revision: 0, q1: 'Now accessible', q2: '' })).status, 200);
    assert.equal(l.unit(space.id, second).started, true);
  } finally { db.close(); }
});

test('project HTTP operations enforce protection and do not store source in SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-project-api-'));
  const db = openDatabase(':memory:'); const l = new Learning(db);
  const access = createLocalAccess({ port: 14333 }); const app = createApp(access, l, new Projects(root));
  const space = l.create({ name: 'Files', goal: 'Learn' });
  const base = `/api/spaces/${space.id}/project`;
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const create = { method: 'POST', headers, body: JSON.stringify({ path: 'main.rs', kind: 'file' }) };
  try {
    assert.equal((await app.request(`${base}/create`, { ...create, headers: { ...headers, 'X-TMC-Token': '' } })).status, 401);
    assert.equal((await app.request(`/api/spaces/${randomUUID()}/project/create`, create)).status, 404);
    assert.equal((await app.request(`${base}/create`, create)).status, 200);
    const file = await (await app.request(`${base}/file?path=main.rs`, { headers })).json();
    const content = 'unique source sentinel';
    assert.equal((await app.request(`${base}/save`, { ...create, body: JSON.stringify({ ...file, content }) })).status, 200);
    assert.equal(readFileSync(join(root, 'projects', space.id, 'main.rs'), 'utf8'), content);
    assert.equal(db.prepare('SELECT * FROM requests').all().length, 0);
    assert.equal((await app.request(`${base}/file?path=..%2F..%2Fapp.db`, { headers })).status, 422);
    assert.equal((await app.request(`${base}/tree`, { headers: { ...headers, Origin: 'http://evil.test' } })).status, 403);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

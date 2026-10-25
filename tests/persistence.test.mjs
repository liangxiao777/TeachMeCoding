import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openDatabase } from '../apps/server/dist/storage/database.js';
import { Learning } from '../apps/server/dist/modules/learning.js';
import { spawnServer, stopServer } from './server-process.mjs';

const entry = fileURLToPath(new URL('../apps/server/dist/index.js', import.meta.url));
function launch(root, port, cwd) {
  const child = spawnServer(entry, { cwd, env: { PORT: String(port), TMC_DATA_DIR: root } });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(child, 'exit');
  return { child, exited, logs: () => logs, async ready() {
    for (let n = 0; n < 100; n++) {
      if (logs.includes('listening')) return;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Test server did not start');
  }, async stop(signal = 'SIGTERM') { stopServer(child, signal); await exited; } };
}

test('real process restart and crash recovery preserve business data, idempotency and files; duplicate startup is refused', { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tmc-restart-')); const root = join(cwd, 'data');
  const children = [];
  const base = 'http://127.0.0.1:14340';
  let token = '';
  const auth = async () => { token = (await (await fetch(`${base}/api/access`, { headers: { 'X-TMC-Client': 'browser' } })).json()).token; };
  const call = async (path, input, key = randomUUID()) => {
    const response = await fetch(`${base}/api${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-TMC-Token': token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  try {
    const first = launch(root, 14340, cwd); children.push(first); await first.ready(); await auth();
    const key = randomUUID(), input = { name: 'Restart A', goal: 'Precise persistence' };
    const space = await call('/spaces', input, key);
    const other = await call('/spaces', { name: 'Restart B', goal: 'Independent space' });
    const session = space.sessions[0].id;
    const quote = { source: 'code', label: 'nested/main.rs', text: 'quoted snapshot 31' };
    await call(`/spaces/${space.id}/requirement`, { ...space.requirement, value: { rows: [{ question: 'What to learn?', answer: 'Precise persistence' }] },
      intake: { researchRef: null }, confirmed: true });
    await call(`/spaces/${space.id}/sessions/${session}/messages`, { text: 'Question 17', quote, draftRevision: 1 });
    await call(`/spaces/${space.id}/sessions/${session}/draft`, { revision: 2, text: 'Unsent draft 29', quote, routeSuggestion: '' });
    await call(`/spaces/${space.id}/project/create`, { path: 'nested', kind: 'directory' });
    await call(`/spaces/${space.id}/project/create`, { path: 'nested/main.rs', kind: 'file' });
    const file = await call(`/spaces/${space.id}/project/file?path=nested/main.rs`);
    const saved = await call(`/spaces/${space.id}/project/save`, { ...file, content: 'fn main() { println!("31"); }' });
    const expectedSession = await call(`/spaces/${space.id}/sessions/${session}`);
    assert.deepEqual(expectedSession.messages.map((m) => m.text), ['Precise persistence', 'Question 17']);
    const oldToken = token;
    await first.stop();

    // Seed generation outputs through internal business entrypoints only while the service is stopped.
    const db = openDatabase(join(root, 'app.db')); const l = new Learning(db);
    const unit = randomUUID(), secondUnit = randomUUID();
    const routeSession = space.sessions.find((s) => s.scope === 'route').id;
    const p = l.proposeRoute(space.id, routeSession, { note: 'Saved route', stages: [{ id: randomUUID(), title: 'Stage', units: [unit, secondUnit].map((id) => ({ id, title: id === unit ? 'One' : 'Two', summary: '', goals: [] })) }] });
    l.applyProposal(space.id, p.id);
    l.saveLesson(space.id, unit, { title: 'Persisted lesson', content: 'Exact material 37' });
    l.saveAssessmentSpec(space.id, unit, { q1: 'Explain', q2: 'Code', starter: 'start' });
    l.saveAssessmentDraft(space.id, unit, { revision: 0, q1: 'Answer 41', q2: 'Code 43' });
    l.saveAssessmentResult(space.id, unit, 1, { result: 'needs_work', summary: 'Evidence', mastered: [], concerns: ['Keep learning'], evidence: ['Explanation'], toVerify: ['Execution'] });
    l.saveAssessmentDraft(space.id, unit, { revision: 2, q1: 'Retest 47', q2: '' });
    l.saveAssessmentDraft(space.id, secondUnit, { revision: 0, q1: 'Other draft 53', q2: 'Other code' });
    const expectedUnit = l.unit(space.id, unit), expectedOtherUnit = l.unit(space.id, secondUnit);
    const runId = randomUUID(), pendingTask = randomUUID(), completedTask = randomUUID();
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)').run(space.id, runId, null, routeSession, 'roadmap', 'running');
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(space.id, pendingTask, unit, null, 'lesson', 'pending');
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(space.id, completedTask, unit, null, 'assessment', 'succeeded');
    db.close();

    const second = launch(root, 14340, cwd); children.push(second); await second.ready(); await auth();
    assert.notEqual(token, oldToken);
    assert.equal((await fetch(`${base}/api/spaces`, { headers: { 'X-TMC-Token': oldToken } })).status, 401);
    assert.deepEqual(await call(`/spaces/${space.id}/sessions/${session}`), expectedSession);
    assert.deepEqual(await call(`/spaces/${space.id}/units/${unit}`), expectedUnit);
    assert.deepEqual(await call(`/spaces/${space.id}/units/${secondUnit}`), expectedOtherUnit);
    assert.deepEqual(await call(`/spaces/${space.id}/project/file?path=nested/main.rs`), saved);
    assert.deepEqual(await call('/spaces', input, key), space);
    assert.equal((await call('/spaces')).length, 2);
    assert.equal((await call(`/spaces/${other.id}`)).sessions.length, 2);
    const restored = await call(`/spaces/${space.id}`);
    assert.deepEqual(Object.fromEntries(restored.runs.map((r) => [r.id, r.state])), { [runId]: 'interrupted' });
    assert.deepEqual(Object.fromEntries(restored.tasks.map((t) => [t.id, t.state])), { [pendingTask]: 'interrupted', [completedTask]: 'succeeded' });
    assert.equal(restored.requirement.confirmed, true);
    assert.equal(restored.route.revision, 1);
    const duplicate = launch(root, 14341, cwd); children.push(duplicate);
    assert.equal((await duplicate.exited)[0], 1);
    assert.match(duplicate.logs(), /already in use/);
    assert.deepEqual(await call(`/spaces/${space.id}/units/${unit}`), expectedUnit);
    await second.stop('SIGKILL');
    const third = launch(root, 14340, cwd); children.push(third); await third.ready(); await auth();
    assert.deepEqual(await call(`/spaces/${space.id}`), restored);
    assert.equal((await call(`/spaces/${space.id}/project/file?path=nested/main.rs`)).content, saved.content);
    await third.stop();
    assert.equal(await readFile(join(root, 'projects', space.id, 'nested/main.rs'), 'utf8'), saved.content);
    const check = openDatabase(join(root, 'app.db'));
    try { assert.equal(check.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(check.pragma('foreign_key_check'), []); } finally { check.close(); }
  } finally {
    for (const child of children) await child.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('startup reports migration and newer-version failures without replacing existing databases', { timeout: 15000 }, async () => {
  for (const version of [0, 999]) {
    const root = await mkdtemp(join(tmpdir(), 'tmc-startup-failure-'));
    const path = join(root, 'app.db');
    const db = openDatabase(path);
    new Learning(db).create({ name: 'Preserve this space', goal: 'Never silently reset data' });
    // Version zero with existing tables is an incompatible old schema; the first migration must fail.
    db.pragma(`user_version = ${version}`); db.close();
    const before = await readFile(path);
    const child = launch(root, 14341, root);
    try {
      assert.equal((await child.exited)[0], 1);
      assert.match(child.logs(), /Cannot open local data/);
      assert.match(child.logs(), version === 0 ? /Database migration 1 failed; existing data was preserved/ : /Database was created by a newer application/);
      assert.deepEqual(await readFile(path), before);
    } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
  }
});

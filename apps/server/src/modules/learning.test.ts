import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../storage/database.js';
import { Learning } from './learning.js';

export function populated(learning: Learning, name = 'Rust') {
  const space = learning.create({ name, goal: `学习 ${name}` });
  learning.saveRequirement(space.id, { ...space.requirement, confirmed: true });
  const unit = () => ({ id: randomUUID(), title: 'Unit', summary: 'Summary', goals: ['Goal'] });
  const units = [unit(), unit()];
  const routeSession = space.sessions.find((s) => s.scope === 'route')!.id;
  const p = learning.proposeRoute(space.id, routeSession, { note: 'Test route', stages: [{ id: randomUUID(), title: 'Stage', units }] });
  learning.applyProposal(space.id, p.id);
  return { space: learning.space(space.id), units, routeSession };
}

test('sessions, messages, references, independent unit drafts and historical records retain ownership', () => {
  const db = openDatabase(':memory:');
  const l = new Learning(db);
  try {
    const a = populated(l); const b = populated(l, 'Python');
    const [u1, u2] = a.units;
    const s1 = l.createSession(a.space.id, { scope: 'unit', unitId: u1!.id, title: 'First' });
    const s2 = l.createSession(a.space.id, { scope: 'unit', unitId: u2!.id, title: 'Second' });
    const history = l.createSession(a.space.id, { scope: 'unit', unitId: u1!.id, title: 'History' });
    const quote = { source: 'code', label: 'src/one.rs', text: 'let a = 17;' };
    l.saveSessionDraft(a.space.id, s1.id, { revision: 0, text: 'A draft', quote, routeSuggestion: '' });
    l.saveSessionDraft(a.space.id, s2.id, { revision: 0, text: 'B draft', quote: null, routeSuggestion: '' });
    l.addMessage(a.space.id, s1.id, { text: 'A question', quote, draftRevision: 1 });
    assert.deepEqual(l.session(a.space.id, s1.id).messages.map((m) => [m.text, m.quote]), [['A question', quote]]);
    assert.equal(l.session(a.space.id, s2.id).draft.text, 'B draft');
    assert.equal(l.session(a.space.id, history.id).messages.length, 0);
    assert.throws(() => l.session(b.space.id, s1.id), /不存在/);
    assert.throws(() => l.createSession(b.space.id, { scope: 'unit', unitId: u1!.id, title: 'Bad' }), /不存在/);
    l.saveAssessmentDraft(a.space.id, u1!.id, { revision: 0, q1: 'answer one', q2: 'code one' });
    l.saveAssessmentDraft(a.space.id, u2!.id, { revision: 0, q1: 'answer two', q2: 'code two' });
    const record = l.saveAssessmentResult(a.space.id, u1!.id, 1, { result: 'needs_work', summary: 'Try again', mastered: [], concerns: ['borrowing'], evidence: ['one'], toVerify: ['two'] });
    assert.equal(l.record(a.space.id, record.id).unitId, u1!.id);
    assert.deepEqual(record.answers, { q1: 'answer one', q2: 'code one' });
    assert.equal(l.unit(a.space.id, u2!.id).draft.q1, 'answer two');
    assert.equal(l.unit(a.space.id, u1!.id).draft.q1, '');
    assert.throws(() => l.record(b.space.id, record.id), /不存在/);
    l.saveLesson(a.space.id, u1!.id, { title: 'Ownership', content: 'Persisted material' });
    assert.equal(l.unit(a.space.id, u1!.id).lesson!.content, 'Persisted material');
    assert.equal(l.unit(a.space.id, u2!.id).lesson, null);
  } finally { db.close(); }
});

test('idempotency, stale revisions and transaction failures do not duplicate or partially apply writes', () => {
  const db = openDatabase(':memory:'); const l = new Learning(db);
  try {
    const key = randomUUID(), body = { name: 'Only once', goal: 'Learn' };
    const create = () => l.once(key, '/spaces', body, () => l.create(body));
    assert.equal(create().id, create().id);
    assert.equal(l.list().length, 1);
    assert.throws(() => l.once(key, '/spaces', { name: 'Other' }, () => l.create(body)), /幂等键/);
    const { space, units, routeSession } = populated(l);
    const content = space.route.content!;
    const added = { id: randomUUID(), title: 'new', summary: '', goals: [] };
    const proposed = { ...content, stages: [{ ...content.stages[0]!, units: [...units, added] }] };
    const p = l.proposeRoute(space.id, routeSession, proposed);
    const stale = l.proposeRoute(space.id, routeSession, content);
    db.exec("CREATE TRIGGER fail_route BEFORE UPDATE ON routes BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => l.applyProposal(space.id, p.id), /injected failure/);
    assert.throws(() => l.unit(space.id, added.id), /不存在/);
    assert.equal(l.space(space.id).proposals.find((x) => x.id === p.id)!.state, 'pending');
    db.exec('DROP TRIGGER fail_route');
    l.applyProposal(space.id, p.id); l.applyProposal(space.id, p.id);
    assert.equal(l.space(space.id).route.revision, 2);
    assert.throws(() => l.applyProposal(space.id, stale.id), /内容已改变/);
    const s = l.session(space.id, routeSession);
    const messageKey = randomUUID();
    const input = { text: 'once', quote: null, draftRevision: 0 };
    const send = () => l.once(messageKey, 'message', input, () => l.addMessage(space.id, s.id, input));
    send(); send();
    assert.equal(l.session(space.id, s.id).messages.length, 1);
    assert.throws(() => l.saveSessionDraft(space.id, s.id, s.draft), /内容已改变/);
    assert.throws(() => l.addMessage(space.id, s.id, input), /内容已改变/);
    assert.equal(l.session(space.id, s.id).messages.length, 1);
  } finally { db.close(); }
});

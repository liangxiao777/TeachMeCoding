import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase } from '../storage/database.js';
import { Learning } from './learning.js';
import { Assessments } from './assessments.js';
import { populated } from '../agents/test-support.js';

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
    assert.throws(() => l.proposeRoute(space.id, routeSession, content), /先接受或拒绝/);
    assert.equal(l.space(space.id).proposals.filter((proposal) => proposal.state === 'pending').length, 1);
    db.exec("CREATE TRIGGER fail_route BEFORE UPDATE ON routes BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => l.applyProposal(space.id, p.id), /injected failure/);
    assert.throws(() => l.unit(space.id, added.id), /不存在/);
    assert.equal(l.space(space.id).proposals.find((x) => x.id === p.id)!.state, 'pending');
    db.exec('DROP TRIGGER fail_route');
    l.applyProposal(space.id, p.id); l.applyProposal(space.id, p.id);
    assert.equal(l.space(space.id).route.revision, 2);
    assert.throws(() => l.rejectProposal(space.id, p.id, {}), /已经结束/);
    const stale = l.proposeRoute(space.id, routeSession, content);
    l.saveRequirement(space.id, { ...l.space(space.id).requirement, confirmed: true });
    assert.throws(() => l.applyProposal(space.id, stale.id), /内容已改变/);
    assert.throws(() => l.addMessage(space.id, routeSession, { text: 'blocked', quote: null, draftRevision: 0 }), /先接受或拒绝/);
    l.rejectProposal(space.id, stale.id, {}); l.rejectProposal(space.id, stale.id, {});
    assert.equal(l.space(space.id).proposals.find((proposal) => proposal.id === stale.id)!.state, 'rejected');
    assert.throws(() => l.applyProposal(space.id, stale.id), /已经结束/);
    assert.throws(() => l.rejectProposal(space.id, stale.id, { feedback: 'Change the decision' }), /已经结束/);
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

test('inserting supplemental stages preserves passed evidence and access; only unstarted units can be removed or retargeted', () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
  const assessments = new Assessments(learning), first = units[0]!, second = units[1]!;
  try {
    for (const unit of units) {
      learning.saveLesson(space.id, unit.id, { title: unit.title, content: `Original lesson ${unit.id}` });
      assessments.saveSpec(space.id, unit.id, { public: { q1: 'Explain the boundary', q2: '', q2Kind: 'reasoning' },
        rubric: { q1: { answer: 'Boundary', criteria: ['Explain why'] }, q2: { answer: 'No code', criteria: ['Reasoning'] } } },
      { requirement: space.requirement.revision, route: space.route.revision, lesson: 1 }, 0);
      const fixed = assessments.submit(space.id, unit.id, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'A concrete explanation', q2: '' });
      assert.equal(assessments.grade(space.id, unit.id, fixed, { result: 'pass', summary: 'Reasoning verified' }).valid, true);
    }
    const before = units.map((unit) => learning.unit(space.id, unit.id));
    const supplement = { id: randomUUID(), title: 'Supplement', summary: 'A missing prerequisite', goals: ['Explain the missing concept'] };
    const middle = { id: randomUUID(), title: 'Middle supplement', summary: 'Bridge between retained units', goals: [] };
    const future = { id: randomUUID(), title: 'Future', summary: '', goals: ['Build'] };
    const content = { note: 'Insert before learned material without erasing it', stages: [
      { id: randomUUID(), title: 'Supplemental stage', units: [supplement] },
      { ...space.route.content!.stages[0]!, title: 'Regrouped', units: [second, middle, { ...first, title: 'Corrected title', summary: 'Corrected summary' }, future] },
    ] };
    learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, content).id);
    for (const [index, unit] of units.entries()) {
      const current = learning.unit(space.id, unit.id);
      assert.equal(current.status, 'passed');
      assert.deepEqual(current.records, before[index]!.records);
      assert.deepEqual(current.lesson, before[index]!.lesson);
      assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, unit.id));
    }
    assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, supplement.id));
    assert.throws(() => learning.assertUnitUnlocked(space.id, middle.id), /尚未解锁/);
    assert.throws(() => learning.assertUnitUnlocked(space.id, future.id), /尚未解锁/);
    // The unchanged assessment remains usable after an unrelated route revision.
    assert.doesNotThrow(() => assessments.submit(space.id, second.id, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'Another explanation', q2: '' }));
    const removeLearned = structuredClone(content);
    removeLearned.stages[1]!.units = [first, future];
    assert.throws(() => learning.proposeRoute(space.id, routeSession, removeLearned), /不能移除/);
    const retarget = structuredClone(content);
    retarget.stages[1]!.units[0]!.goals = ['A different learning objective'];
    assert.throws(() => learning.proposeRoute(space.id, routeSession, retarget), /学习目标/);
    // Empty session/draft records alone are not learning history.
    learning.createSession(space.id, { scope: 'unit', unitId: future.id, title: 'Empty' });
    learning.saveAssessmentDraft(space.id, future.id, { revision: 0, q1: '', q2: '' });
    const removeFuture = structuredClone(content);
    removeFuture.stages[1]!.units.pop();
    learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, removeFuture).id);
    assert.throws(() => learning.unit(space.id, future.id), /当前学习路线/);
    assert.equal(db.prepare('SELECT 1 FROM units WHERE space_id=? AND id=?').get(space.id, future.id) !== undefined, true);
    // Publication and acceptance both enforce protection: learning may start while a proposal is pending.
    const removeSupplement = { ...removeFuture, stages: [removeFuture.stages[1]!] };
    const pending = learning.proposeRoute(space.id, routeSession, removeSupplement);
    const session = learning.createSession(space.id, { scope: 'unit', unitId: supplement.id, title: 'Started' });
    learning.saveSessionDraft(space.id, session.id, { revision: 0, text: 'An actual question', quote: null, routeSuggestion: '' });
    assert.throws(() => learning.applyProposal(space.id, pending.id), /不能移除/);
    assert.deepEqual(learning.space(space.id).route.content, removeFuture);
    learning.rejectProposal(space.id, pending.id, {});
    const retargetMiddle = structuredClone(removeFuture);
    retargetMiddle.stages[1]!.units[1]!.goals = ['Replacement goal'];
    const lateGoal = learning.proposeRoute(space.id, routeSession, retargetMiddle);
    learning.saveAssessmentDraft(space.id, middle.id, { revision: 0, q1: 'A real attempted answer', q2: '' });
    assert.throws(() => learning.applyProposal(space.id, lateGoal.id), /学习目标/);
    assert.deepEqual(learning.space(space.id).route.content, removeFuture);
  } finally { db.close(); }
});

test('started means actual saved learning content, not empty session or draft records; protected units retain IDs and goals', () => {
  for (const activity of ['empty', 'blank', 'quoted-blank', 'lesson', 'assessment', 'result', 'assessment-draft', 'session-draft', 'quoted-draft', 'message'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
    const unit = units[0]!, other = units[1]!, session = learning.createSession(space.id, { scope: 'unit', unitId: unit.id, title: activity });
    try {
      const blank = activity === 'empty' ? '' : ' \t\r\n\u00a0\u2003';
      learning.saveAssessmentDraft(space.id, unit.id, { revision: 0, q1: activity === 'assessment-draft' ? 'Actual answer' : blank, q2: '' });
      learning.saveSessionDraft(space.id, session.id, { revision: 0, text: activity === 'session-draft' ? 'Actual question' : blank,
        quote: activity === 'quoted-draft' || activity === 'quoted-blank' ? { source: 'code', label: 'Example', text: activity === 'quoted-blank' ? blank : 'print(17)' } : null, routeSuggestion: '' });
      if (activity === 'lesson') learning.saveLesson(space.id, unit.id, { title: 'Lesson', content: 'Saved material' });
      if (activity === 'assessment') learning.saveAssessmentSpec(space.id, unit.id, { q1: 'Explain the boundary', q2: '', q2Kind: 'reasoning' });
      if (activity === 'result') learning.saveAssessmentResult(space.id, unit.id, 1, { result: 'needs_work', summary: 'Saved evidence' });
      if (activity === 'message') learning.addMessage(space.id, session.id, { text: 'Actual question', quote: null, draftRevision: 1 });
      const started = !['empty', 'blank', 'quoted-blank'].includes(activity);
      assert.equal(learning.unit(space.id, unit.id).started, started, activity);
      assert.equal(learning.progress(space.id).find((progress) => progress.id === unit.id)!.started, started, activity);
      const removed = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [other] }] };
      const retargeted = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [{ ...unit, goals: ['Different objective'] }, other] }] };
      if (started) {
        assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, unit.id), activity);
        assert.throws(() => learning.proposeRoute(space.id, routeSession, removed), /不能移除/, activity);
        assert.throws(() => learning.proposeRoute(space.id, routeSession, retargeted), /学习目标/, activity);
        const moved = { note: 'Correct wording and group without changing objectives', stages: [
          { ...space.route.content!.stages[0]!, units: [other] },
          { id: randomUUID(), title: 'Moved group', units: [{ ...unit, title: 'Corrected title', summary: 'Corrected summary' }] },
        ] };
        learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, moved).id);
        assert.deepEqual(learning.space(space.id).route.content, moved);
        assert.equal(learning.unit(space.id, unit.id).started, true);
        assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, unit.id), 'Unpublished predecessor must not relock started activity');
      } else {
        learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, retargeted).id);
        learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, removed).id);
        assert.throws(() => learning.unit(space.id, unit.id), /当前学习路线/);
      }
    } finally { db.close(); }
  }
});

test('legacy flat history and legacy text events hydrate without doubling the saved text, including long event histories', () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  try {
    const space = learning.create({ name: 'Legacy', goal: 'Legacy history' }), session = space.sessions[0]!.id;
    const flat = randomUUID(), run = randomUUID();
    db.prepare("INSERT INTO messages VALUES (?,?,?,'agent','Imported text',NULL,0)").run(space.id, session, flat);
    db.prepare("INSERT INTO runs VALUES (?,?,NULL,?,'intake','succeeded')").run(space.id, run, session);
    db.prepare("INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,'{}',0)").run(space.id, run);
    db.prepare("INSERT INTO messages VALUES (?,?,?,'agent',?,NULL,0)").run(space.id, session, run, 'x'.repeat(600));
    const append = db.prepare('INSERT INTO agent_events VALUES (?,?,?,?)');
    db.transaction(() => {
      for (let seq = 1; seq <= 600; seq++) append.run(space.id, run, seq, JSON.stringify({ type: 'text', delta: 'x' }));
      append.run(space.id, run, 601, JSON.stringify({ type: 'state', state: 'succeeded', error: null }));
    })();
    const [imported, streamed] = learning.session(space.id, session).messages;
    assert.equal(imported?.text, 'Imported text'); assert.equal(imported?.parts, undefined);
    assert.equal(streamed?.text, 'x'.repeat(600)); assert.equal(streamed?.sequence, 601);
    assert.deepEqual(streamed?.parts, [{ type: 'text', id: `${run}:legacy-text:1`, text: 'x'.repeat(600) }]);
    assert.deepEqual(new Learning(db).session(space.id, session).messages, [imported, streamed]);
  } finally { db.close(); }
});

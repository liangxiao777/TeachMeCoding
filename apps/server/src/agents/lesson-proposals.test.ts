import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { JsonObject } from '@earendil-works/pi-ai';
import { lessonMarkdown } from '@teach-me-coding/contracts';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { Assessments } from '../modules/assessments.js';
import { workspaceApi } from '../http/workspaces.js';
import { TeachingRuntime } from './runtime.js';
import { approveLesson, populated, reply, response, stageLesson, syntheticSource } from './test-support.js';
import { createTask } from './tasks.js';
import { compileContext, type FrozenContext } from './context.js';

const original = { title: 'Applied lesson', content: '## Applied\n\nOriginal material.\n' };
const changed = { title: 'Changed lesson', content: '## Replacement\n\nComplete corrected material.' };

test('lesson regeneration inherits only its explicit originating conversation approval mode', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
  learning.saveLesson(space.id, unit, original);
  const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'YOLO' }).id;
  const wrong = learning.createSession(space.id, { scope: 'unit', unitId: units[1]!.id, title: 'Other unit' }).id;
  learning.saveSessionSettings(space.id, session, { revision: 0, yolo: true });
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => response(context.messages.at(-1)?.role === 'toolResult'
    ? reply([]) : reply([{ type: 'toolCall', id: 'lesson', name: 'submit_lesson', arguments: changed }], 'toolUse')) });
  try {
    assert.throws(() => runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1, sessionId: wrong }), /发起会话的单元/);
    assert.throws(() => runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1, sessionId: space.sessions[0]!.id }), /发起会话的单元/);
    const manual = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1 });
    await runtime.idle(manual.id); assert.equal(runtime.get(space.id, manual.id).state, 'succeeded');
    const pending = learning.space(space.id).lessonProposals.at(-1)!;
    assert.equal(pending.state, 'pending'); assert.equal(pending.sessionId, session);
    assert.deepEqual(learning.unit(space.id, unit).lesson, { ...original, revision: 1 });
    learning.rejectLessonProposal(space.id, pending.id, {});
    const automatic = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1, sessionId: session });
    await runtime.idle(automatic.id); assert.equal(runtime.get(space.id, automatic.id).state, 'succeeded');
    assert.equal(learning.space(space.id).lessonProposals.at(-1)!.state, 'applied');
    assert.deepEqual(learning.unit(space.id, unit).lesson, { ...changed, revision: 2 });
    assert.equal(learning.unit(space.id, units[1]!.id).lesson, null);
  } finally { await runtime.close(); db.close(); }
});

test('tutor lesson tools bind the applied unit and stage only the last valid full candidate after normal completion', async () => {
  for (const mode of ['normal', 'failed', 'stopped', 'no-op', 'no-lesson'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
    if (mode !== 'no-lesson') learning.saveLesson(space.id, unit, original);
    const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'Tutor' });
    let requests = 0, runId = '';
    const runtime = new TeachingRuntime(learning, syntheticSource, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, stream: (_m, context) => {
      requests++;
      assert.deepEqual(learning.unit(space.id, unit).lesson, mode === 'no-lesson' ? null : { ...original, revision: 1 });
      assert.equal(learning.space(space.id).lessonProposals.length, 0, 'No publication while the run is active.');
      const tools = context.messages.find((m) => m.role === 'system')!.toolsAdded!;
      if (mode === 'no-lesson') {
        assert.ok(!tools.some((t) => ['read_current_lesson', 'propose_lesson_change'].includes(t.name)));
        return response(reply([]));
      }
      const schema = JSON.parse(JSON.stringify(tools.find((t) => t.name === 'propose_lesson_change')!.parameters));
      assert.deepEqual(Object.keys(schema.properties), ['title', 'content', 'note']);
      assert.deepEqual(schema.required, ['title', 'content']);
      if (requests === 1) return response(reply([{ type: 'toolCall', id: 'read', name: 'read_current_lesson', arguments: {} }], 'toolUse'));
      if (requests === 2) {
        assert.match(JSON.stringify(context.messages.at(-1)), /Original material/);
        const candidate = mode === 'no-op' ? original : changed;
        return response(reply([
          { type: 'toolCall', id: 'first', name: 'propose_lesson_change', arguments: { title: 'First candidate', content: 'Discarded valid candidate' } },
          { type: 'toolCall', id: 'last-valid', name: 'propose_lesson_change', arguments: candidate },
          { type: 'toolCall', id: 'blank', name: 'propose_lesson_change', arguments: { title: 'Invalid', content: ' \r\n ' } },
          { type: 'toolCall', id: 'other-unit', name: 'propose_lesson_change', arguments: { ...changed, unitId: units[1]!.id } },
        ], 'toolUse'));
      }
      const errors = context.messages.filter((m) => m.role === 'toolResult' && ['blank', 'other-unit'].includes(m.toolCallId));
      assert.equal(errors.length, 2); assert.ok(errors.every((m) => m.role === 'toolResult' && m.isError));
      if (mode === 'stopped') runtime.stop(space.id, runId);
      return response(reply([], mode === 'failed' ? 'error' : 'stop'));
    } });
    try {
      const { run } = runtime.submit(space.id, session.id, randomUUID(), { text: 'Improve the lesson', quote: null, draftRevision: 0 });
      runId = run.id; await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, mode === 'failed' ? 'failed' : mode === 'stopped' ? 'interrupted' : 'succeeded');
      const proposals = learning.space(space.id).lessonProposals;
      assert.equal(proposals.length, mode === 'normal' ? 1 : 0);
      if (mode === 'normal') {
        const proposal = proposals[0]!;
        assert.deepEqual(proposal.content, changed); assert.equal(proposal.note, '');
        assert.equal(proposal.unitId, unit); assert.equal(proposal.sessionId, session.id);
        assert.deepEqual(proposal.source, { kind: 'run', id: run.id });
        assert.deepEqual(proposal.baseLesson, { ...original, revision: 1 });
        const saved = learning.applyLessonProposal(space.id, proposal.id);
        assert.deepEqual(saved.unit.lesson, { ...changed, revision: 2 });
        assert.equal(learning.unit(space.id, units[1]!.id).lesson, null);
      } else assert.equal(learning.unit(space.id, unit).lesson?.revision ?? 0, mode === 'no-lesson' ? 0 : 1);
    } finally { await runtime.close(); db.close(); }
  }
});

test('acceptance is atomic, idempotent, isolated and available over HTTP without a model', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), other = populated(learning, 'Other');
  const unit = units[0]!.id, api = workspaceApi(learning);
  const post = (spaceId: string, proposal: string, action: string, body: unknown, key = randomUUID()) => api.request(`/spaces/${spaceId}/lesson-proposals/${proposal}/${action}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  try {
    learning.saveLesson(space.id, unit, original);
    learning.saveAssessmentDraft(space.id, unit, { revision: 0, q1: 'Unsent answer', q2: 'Unsent code' });
    learning.saveAssessmentSpec(space.id, unit, { q1: 'Keep this question', q2: '', q2Kind: 'reasoning' });
    const p = stageLesson(learning, space.id, unit, { ...changed, note: 'Correct the explanation' })!;
    const before = learning.unit(space.id, unit), workspace = learning.space(space.id);
    const histories = ['assessment_specs', 'assessment_versions', 'assessment_drafts', 'assessments', 'messages', 'conclusions', 'action_proposals']
      .map((table) => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }));
    assert.throws(() => learning.saveLesson(space.id, unit, changed), /明确接受/);
    assert.equal((await post(other.space.id, p.id, 'apply', {})).status, 404);
    assert.equal((await post(space.id, p.id, 'apply', { unitId: units[1]!.id })).status, 400);
    db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON lesson_versions BEGIN SELECT RAISE(ABORT, 'injected lesson version failure'); END");
    const key = randomUUID();
    assert.equal((await post(space.id, p.id, 'apply', {}, key)).status, 503);
    assert.deepEqual(learning.unit(space.id, unit), before); assert.deepEqual(learning.space(space.id), workspace);
    db.exec('DROP TRIGGER fail_version');
    const applied = await post(space.id, p.id, 'apply', {}, key); assert.equal(applied.status, 200);
    const result = await applied.json();
    assert.deepEqual(result.unit.lesson, { ...changed, revision: 2 });
    assert.equal(result.workspace.lessonProposals.find((item: { id: string }) => item.id === p.id).state, 'applied');
    assert.deepEqual(await (await post(space.id, p.id, 'apply', {}, key)).json(), result);
    assert.equal((await post(space.id, p.id, 'apply', {})).status, 200);
    assert.equal(learning.unit(space.id, unit).lesson!.revision, 2);
    assert.equal((await post(space.id, p.id, 'reject', { feedback: '' })).status, 409);
    assert.deepEqual(learning.space(space.id).route, workspace.route);
    assert.deepEqual(learning.space(space.id).requirement, workspace.requirement);
    assert.equal(learning.unit(space.id, units[1]!.id).lesson, null);
    for (const { table, rows } of histories) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
    assert.deepEqual(learning.lessonVersion(space.id, unit, 1), { ...original, revision: 1 });
  } finally { db.close(); }
});

test('publication checks source ownership and frozen revisions; stale proposals can reject but cannot accept', async () => {
  for (const change of ['requirement', 'route', 'lesson', 'reference', 'unread', 'source'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id, reference = units[1]!.id;
    try {
      learning.saveLesson(space.id, unit, original); learning.saveLesson(space.id, reference, { title: 'Reference', content: 'Reference version one' });
      const refs = change === 'reference' ? [{ unitId: reference, revision: 1 }] : [];
      const p = stageLesson(learning, space.id, unit, changed, refs)!;
      // Simulate a concurrent persisted baseline/reference change, not a permitted overwrite API.
      if (change === 'requirement') learning.saveRequirement(space.id, { ...space.requirement, confirmed: true });
      if (change === 'route') db.prepare('UPDATE routes SET revision=revision+1 WHERE space_id=?').run(space.id);
      if (change === 'lesson' || change === 'reference' || change === 'unread') {
        const target = change === 'lesson' ? unit : reference;
        db.prepare('INSERT INTO lesson_versions SELECT space_id,unit_id,revision+1,content FROM lessons WHERE space_id=? AND unit_id=?').run(space.id, target);
        db.prepare('UPDATE lessons SET revision=revision+1 WHERE space_id=? AND unit_id=?').run(space.id, target);
      }
      if (change === 'source') db.prepare("UPDATE tasks SET unit_id=? WHERE space_id=? AND id=?").run(reference, space.id, p.source.id);
      const before = learning.unit(space.id, unit), workspace = learning.space(space.id);
      if (change === 'unread') assert.equal(learning.applyLessonProposal(space.id, p.id).unit.lesson!.revision, 2);
      else {
        assert.throws(() => learning.applyLessonProposal(space.id, p.id), /改变|不一致/);
        assert.deepEqual(learning.unit(space.id, unit), before); assert.deepEqual(learning.space(space.id), workspace);
        learning.rejectLessonProposal(space.id, p.id, {}); learning.rejectLessonProposal(space.id, p.id, {});
        assert.throws(() => learning.applyLessonProposal(space.id, p.id), /已经结束/);
      }
    } finally { db.close(); }
  }
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), other = populated(learning, 'Other');
  try {
    for (const u of units) learning.saveLesson(space.id, u.id, original);
    const p = stageLesson(learning, space.id, units[0]!.id, changed)!;
    learning.rejectLessonProposal(space.id, p.id, {});
    const base = { requirement: p.requirementRevision, route: p.routeRevision, lesson: 1 };
    assert.throws(() => learning.proposeLesson(space.id, units[1]!.id, changed, base, p.source), /不一致/);
    assert.throws(() => learning.proposeLesson(space.id, units[0]!.id, changed, base, p.source, [], space.sessions[0]!.id), /所属单元/);
    learning.saveLesson(other.space.id, other.units[0]!.id, original);
    assert.throws(() => learning.proposeLesson(other.space.id, other.units[0]!.id, changed, base, p.source), /不存在/);
    const input = JSON.parse((db.prepare('SELECT input FROM task_runs WHERE id=?').get(p.source.id) as { input: string }).input) as FrozenContext;
    const task = createTask(learning, input, p.source.id);
    await task.tools.find((t) => t.name === 'submit_lesson')!.execute('candidate', changed);
    learning.saveRequirement(space.id, { ...space.requirement, confirmed: true });
    assert.throws(() => task.commit(), /内容已改变/);
    assert.equal(learning.space(space.id).lessonProposals.filter((p) => p.state === 'pending').length, 0);
  } finally { db.close(); }
});

test('route and lesson review mutually gate sessions, generation, independent retry and already-running publication', async () => {
  for (const kind of ['route', 'lesson'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning), unit = units[0]!.id, next = units[1]!.id;
    learning.saveLesson(space.id, unit, original);
    const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'Tutor' });
    let fail = true;
    const runtime = new TeachingRuntime(learning, syntheticSource, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, stream: (_m, context) => fail ? response(reply([], 'error'))
      : response(context.messages.at(-1)?.role === 'toolResult' ? reply([]) : reply([{ type: 'toolCall', id: 'lesson', name: 'submit_lesson', arguments: changed }], 'toolUse')) });
    try {
      const failed = runtime.generate(space.id, next, randomUUID(), { kind: 'lesson', revision: 0 }); await runtime.idle(failed.id);
      const chat = runtime.submit(space.id, session.id, randomUUID(), { text: 'Question', quote: null, draftRevision: 0 }); await runtime.idle(chat.run.id);
      fail = false;
      const active = runtime.generate(space.id, next, randomUUID(), { kind: 'lesson', revision: 0 });
      const pending = kind === 'route' ? learning.proposeRoute(space.id, routeSession, space.route.content) : stageLesson(learning, space.id, unit, changed)!;
      const before = learning.space(space.id), draft = learning.session(space.id, session.id).draft;
      for (const task of [{ kind: 'lesson', revision: 1 }, { kind: 'assessment', revision: 0 }, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'Answer', q2: '' }]) {
        assert.throws(() => runtime.generate(space.id, unit, randomUUID(), task), /先接受或拒绝/);
      }
      assert.throws(() => runtime.retryTask(space.id, failed.id, randomUUID()), /先接受或拒绝/);
      assert.throws(() => runtime.retry(space.id, chat.run.id, randomUUID()), /先接受或拒绝/);
      assert.throws(() => runtime.submit(space.id, session.id, randomUUID(), { text: 'Blocked', quote: null, draftRevision: draft.revision }), /先接受或拒绝/);
      assert.throws(() => learning.addMessage(space.id, session.id, { text: 'Blocked', quote: null, draftRevision: draft.revision }), /先接受或拒绝/);
      assert.throws(() => learning.saveLesson(space.id, next, changed), /先接受或拒绝/);
      assert.throws(() => kind === 'route' ? stageLesson(learning, space.id, unit, changed) : learning.proposeRoute(space.id, routeSession, space.route.content), /先接受或拒绝/);
      assert.deepEqual(learning.space(space.id), before); assert.deepEqual(learning.session(space.id, session.id).draft, draft);
      await runtime.idle(active.id); assert.equal(runtime.get(space.id, active.id).state, 'failed');
      assert.match(runtime.get(space.id, active.id).error!, /先接受或拒绝/); assert.equal(learning.unit(space.id, next).lesson, null);
      if (kind === 'route') learning.rejectProposal(space.id, pending.id, {});
      else learning.rejectLessonProposal(space.id, pending.id, {});
      const retry = runtime.retryTask(space.id, failed.id, randomUUID()); await runtime.idle(retry.id);
      assert.equal(runtime.get(space.id, retry.id).state, 'succeeded'); assert.equal(learning.unit(space.id, next).lesson!.revision, 1);
    } finally { await runtime.close(); db.close(); }
  }
});

test('lesson rejection feedback follows the saved owner session from CURRENT applied lesson, with rejected draft reference only', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
  learning.saveLesson(space.id, unit, original);
  const a = stageLesson(learning, space.id, unit, { title: 'A draft', content: 'A-DRAFT-ONLY' })!;
  const saved = learning.saveSessionDraft(space.id, a.sessionId, { revision: 0, text: 'Unrelated composer', quote: null, routeSuggestion: '' });
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    const xml = context.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content
      : m.content.filter((part) => part.type === 'text').map((part) => part.text).join('')).find((text) => text.includes('<context schemaVersion='))!;
    assert.match(xml.match(/<source kind="lesson"[^>]*>(.*?)<\/source>/s)![1]!, /Original material/);
    assert.doesNotMatch(xml.match(/<source kind="lesson"[^>]*>(.*?)<\/source>/s)![1]!, /A-DRAFT-ONLY/);
    assert.match(xml.match(/<source kind="rejected-lesson-proposal"[^>]*>(.*?)<\/source>/s)![1]!, /A-DRAFT-ONLY/);
    assert.match(xml, /Please correct the original/);
    return response(context.messages.at(-1)?.role === 'toolResult' ? reply([])
      : reply([{ type: 'toolCall', id: 'b', name: 'propose_lesson_change', arguments: changed }], 'toolUse'));
  } });
  try {
    const key = randomUUID(), feedback = 'Please correct the original', decision = runtime.rejectLessonProposal(space.id, a.id, key, { feedback });
    assert.ok(decision.run); assert.equal(decision.run.kind, 'tutor'); assert.equal(decision.run.sessionId, a.sessionId);
    assert.equal(decision.session.id, a.sessionId); assert.equal(decision.followupError, null); assert.deepEqual(decision.session.draft, saved.draft);
    assert.equal(runtime.rejectLessonProposal(space.id, a.id, key, { feedback }).run!.id, decision.run.id);
    assert.equal(runtime.rejectLessonProposal(space.id, a.id, randomUUID(), { feedback }).run, null);
    await runtime.idle(decision.run.id); assert.equal(runtime.get(space.id, decision.run.id).state, 'succeeded', runtime.get(space.id, decision.run.id).error ?? '');
    const b = learning.space(space.id).lessonProposals.at(-1)!;
    assert.equal(b.baseRevision, 1); assert.deepEqual(b.content, changed); assert.deepEqual(b.source, { kind: 'run', id: decision.run.id });
    assert.deepEqual(learning.unit(space.id, unit).lesson, { ...original, revision: 1 });
    assert.equal(learning.session(space.id, a.sessionId).messages.filter((m) => m.role === 'user' && m.text === feedback).length, 1);
    assert.throws(() => learning.applyLessonProposal(space.id, a.id), /已经结束/);
    assert.throws(() => runtime.rejectLessonProposal(space.id, a.id, randomUUID(), { feedback: 'Reverse decision' }), /已经结束/);
  } finally { await runtime.close(); db.close(); }
});

test('offline or failed follow-up start still saves rejection and feedback exactly once without consuming an unsent draft', async () => {
  for (const mode of ['blank', 'offline', 'start-failed'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
    learning.saveLesson(space.id, unit, original);
    const owner = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'Existing owner' });
    const p = stageLesson(learning, space.id, unit, changed)!; assert.equal(p.sessionId, owner.id);
    const saved = learning.saveSessionDraft(space.id, owner.id, { revision: 0, text: 'Unsent opinion', quote: null, routeSuggestion: '' });
    const runtime = new TeachingRuntime(learning, mode === 'start-failed' ? syntheticSource : null);
    const api = workspaceApi(learning, undefined, runtime), feedback = mode === 'blank' ? '  ' : 'Keep my saved opinion', key = randomUUID();
    const post = (body: unknown, requestKey = key) => api.request(`/spaces/${space.id}/lesson-proposals/${p.id}/reject`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify(body) });
    try {
      assert.equal((await post({ feedback: 123 }, randomUUID())).status, 400);
      if (mode === 'start-failed') db.exec("CREATE TRIGGER fail_followup BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected start failure'); END");
      const result = await post({ feedback }); assert.equal(result.status, 200); const decision = await result.json();
      assert.equal(decision.run, null); assert.equal(decision.session.id, owner.id); assert.deepEqual(decision.session.draft, saved.draft);
      assert.equal(decision.workspace.lessonProposals[0].state, 'rejected'); assert.equal(decision.workspace.lessonProposals[0].feedback, feedback.trim());
      if (mode === 'blank') { assert.equal(decision.followupError, null); assert.equal(decision.session.messages.length, 0); }
      else { assert.match(decision.followupError, /已拒绝提案并保存修改意见/); assert.deepEqual(decision.session.messages.map((m: { role: string; text: string }) => [m.role, m.text]), [['user', feedback]]); }
      assert.equal((await post({ feedback })).status, 200); assert.equal((await post({ feedback }, randomUUID())).status, 200);
      assert.equal((await post({ feedback: 'Different opinion' }, randomUUID())).status, 409);
      assert.deepEqual(learning.session(space.id, owner.id).draft, saved.draft); assert.equal(learning.space(space.id).runs.length, 0);
      assert.deepEqual(learning.unit(space.id, unit).lesson, { ...original, revision: 1 });
    } finally { await runtime.close(); db.close(); }
  }
});

test('historical passes retain access and saved work but never become current evidence or allow submitting old questions', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id, a = new Assessments(learning);
  learning.saveLesson(space.id, unit, original);
  const sources = { requirement: space.requirement.revision, route: space.route.revision, lesson: 1 };
  const spec = { public: { q1: 'Explain', q2: '', q2Kind: 'reasoning' }, rubric: { q1: { answer: 'Explain why', criteria: ['Reasoning'] }, q2: { answer: 'None', criteria: ['None'] } } };
  a.saveSpec(space.id, unit, spec, sources, 0);
  const fixed = a.submit(space.id, unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'Known explanation', q2: '' });
  const record = a.grade(space.id, unit, fixed, { result: 'pass', summary: 'Verified reasoning', evidence: ['OLD-PASS-EVIDENCE'] });
  learning.saveAssessmentDraft(space.id, unit, { revision: 0, q1: 'Keep answer', q2: 'Keep code' });
  const owner = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'Conclusion owner' });
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    assert.doesNotMatch(JSON.stringify(context), /OLD-PASS-EVIDENCE|OLD-ADOPTED-FACT/);
    assert.match(JSON.stringify(context), /historicalPass/);
    return response(reply([]));
  } });
  try {
    // A saved run binds the adopted conclusion to the old lesson.
    const source = randomUUID();
    db.prepare("INSERT INTO runs VALUES (?,?,?,?,'tutor','succeeded')").run(space.id, source, unit, owner.id);
    db.prepare("INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,'{}',0)").run(space.id, source);
    learning.proposeConclusion(space.id, unit, source, { text: 'OLD-ADOPTED-FACT' }, sources);
    const c = learning.conclusions(space.id)[0]!; learning.decideConclusion(space.id, c.id, { revision: c.revision, adopted: true });
    const before = learning.unit(space.id, unit);
    approveLesson(learning, space.id, unit, changed);
    const current = learning.unit(space.id, unit);
    assert.equal(current.status, 'learning'); assert.equal(current.records[0]!.valid, false);
    assert.deepEqual(current.historicalPass, { recordId: record.id, lessonRevision: 1 });
    assert.deepEqual(learning.progress(space.id).find((u) => u.id === unit)!.historicalPass, current.historicalPass);
    assert.deepEqual(current.draft, before.draft); assert.deepEqual(current.assessment, before.assessment);
    assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, units[1]!.id));
    assert.throws(() => a.submit(space.id, unit, { kind: 'evaluation', revision: 1, specRevision: 1, q1: 'New answer', q2: '' }), /内容已改变/);
    const { run } = runtime.submit(space.id, owner.id, randomUUID(), { text: 'Continue from current lesson', quote: null, draftRevision: 0 });
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    const input = JSON.parse((db.prepare('SELECT input FROM agent_runs WHERE id=?').get(run.id) as { input: string }).input) as FrozenContext;
    assert.deepEqual(input.evidence, []); assert.deepEqual(input.conclusions, []); assert.deepEqual(input.lesson, { ...changed, revision: 2 });
    const rejected = stageLesson(learning, space.id, unit, { title: 'Rejected', content: 'DRAFT-FOR-ONE-UNIT' })!;
    learning.rejectLessonProposal(space.id, rejected.id, {});
    assert.doesNotMatch(compileContext({ ...input, unitId: units[1]!.id, rejectedLessonProposal: { ...rejected, state: 'rejected' } }).xml, /DRAFT-FOR-ONE-UNIT/);
    learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
    assert.equal(learning.unit(space.id, unit).historicalPass, null, 'Different requirement revision is not continuation evidence.');
  } finally { await runtime.close(); db.close(); }
});

test('legacy complete Markdown comparisons are no-ops without rewriting immutable versions', () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
  const legacy = { title: 'Legacy', content: 'Original content', intro: 'Original intro', blocks: [
    { type: 'h2', id: 'legacy-heading', text: 'Heading' }, { type: 'code', file: 'demo.py', language: 'python', code: 'print("``` preserved")\n', caption: 'Caption' },
  ] };
  try {
    learning.saveLesson(space.id, unit, legacy);
    const content: JsonObject = { title: legacy.title, content: lessonMarkdown(learning.unit(space.id, unit).lesson!), note: 'No actual changes' };
    assert.equal(stageLesson(learning, space.id, unit, content), null);
    assert.equal(learning.space(space.id).lessonProposals.length, 0);
    assert.deepEqual(learning.unit(space.id, unit).lesson, { ...legacy, revision: 1 });
    assert.deepEqual(learning.lessonVersion(space.id, unit, 1), { ...legacy, revision: 1 });
    assert.equal(db.prepare('SELECT * FROM lesson_versions').all().length, 1);
  } finally { db.close(); }
});

test('Markdown indentation and exact whitespace changes require review rather than disappearing as no-ops', () => {
  for (const [before, after] of [['plain paragraph\n', '    plain paragraph\n'], ['    print(1)\n', 'print(1)\n'], ['paragraph\n', 'paragraph\r\n']]) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
    try {
      learning.saveLesson(space.id, unit, { title: 'Same title', content: before });
      const proposal = stageLesson(learning, space.id, unit, { title: 'Same title', content: after })!;
      assert.ok(proposal, 'Changing source formatting is not an unchanged document.');
      assert.equal(learning.unit(space.id, unit).lesson!.content, before);
      assert.equal(proposal.baseLesson.content, before);
      assert.equal(learning.applyLessonProposal(space.id, proposal.id).unit.lesson!.content, after);
      assert.equal(learning.lessonVersion(space.id, unit, 1).content, before);
    } finally { db.close(); }
  }
});

test('regeneration retries preserve old lessons and publish only a task-sourced proposal, including last-valid and no-op candidates', async () => {
  for (const mode of ['failed', 'stopped', 'no-op'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id;
    learning.saveLesson(space.id, unit, original);
    let retrying = false, taskId = '';
    const runtime = new TeachingRuntime(learning, syntheticSource, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, stream: (_m, context) => {
      assert.deepEqual(learning.unit(space.id, unit).lesson, { ...original, revision: 1 });
      if (context.messages.at(-1)?.role !== 'toolResult') return response(reply([
        { type: 'toolCall', id: 'first', name: 'submit_lesson', arguments: { title: 'Discarded', content: 'First valid full candidate' } },
        { type: 'toolCall', id: 'last', name: 'submit_lesson', arguments: mode === 'no-op' ? original : changed },
        { type: 'toolCall', id: 'invalid', name: 'submit_lesson', arguments: { title: 'Blank', content: '  ' } },
      ], 'toolUse'));
      if (!retrying && mode === 'stopped') runtime.stop(space.id, taskId);
      return response(reply([], !retrying && mode === 'failed' ? 'error' : 'stop'));
    } });
    try {
      const task = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1 }); taskId = task.id;
      await runtime.idle(task.id);
      assert.equal(runtime.get(space.id, task.id).state, mode === 'failed' ? 'failed' : mode === 'stopped' ? 'interrupted' : 'succeeded');
      assert.equal(learning.space(space.id).lessonProposals.length, 0);
      if (mode !== 'no-op') {
        retrying = true;
        const retry = runtime.retryTask(space.id, task.id, randomUUID()); await runtime.idle(retry.id);
        assert.equal(runtime.get(space.id, retry.id).state, 'succeeded');
        const p = learning.space(space.id).lessonProposals[0]!;
        assert.deepEqual(p.source, { kind: 'task', id: retry.id }); assert.deepEqual(p.content, changed);
        assert.deepEqual(learning.unit(space.id, unit).lesson, { ...original, revision: 1 });
        learning.applyLessonProposal(space.id, p.id);
        assert.deepEqual(learning.unit(space.id, unit).lesson, { ...changed, revision: 2 });
      }
    } finally { await runtime.close(); db.close(); }
  }
});

test('legacy passes, non-passes, unverified executions and unknown lesson revisions are not historical passes', () => {
  for (const mode of ['legacy', 'needs-work', 'unverified', 'unknown-version', 'same-lesson'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[0]!.id, a = new Assessments(learning);
    try {
      learning.saveLesson(space.id, unit, original);
      if (mode === 'legacy') learning.saveAssessmentResult(space.id, unit, 0, { result: 'pass', summary: 'Imported pass without verification' });
      else {
        a.saveSpec(space.id, unit, { public: { q1: 'Explain', q2: '', q2Kind: mode === 'unverified' ? 'code' : 'reasoning' },
          rubric: { q1: { answer: 'Reason', criteria: ['Reasoning'] }, q2: { answer: 'None', criteria: ['None'] } } },
        { requirement: space.requirement.revision, route: space.route.revision, lesson: 1 }, 0);
        const fixed = a.submit(space.id, unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'Answer', q2: '' });
        a.grade(space.id, unit, fixed, { result: mode === 'needs-work' ? 'needs_work' : 'pass', summary: 'Recorded result' });
      }
      if (mode !== 'same-lesson') approveLesson(learning, space.id, unit, changed);
      if (mode === 'unknown-version') {
        // Imported evidence names an unavailable historical version; do not invent its body.
        db.prepare("UPDATE assessments SET result=json_set(result,'$.lessonRevision',0) WHERE space_id=? AND unit_id=?").run(space.id, unit);
      }
      assert.equal(learning.unit(space.id, unit).historicalPass, null, mode);
    } finally { db.close(); }
  }
});

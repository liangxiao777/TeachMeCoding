import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { RouteContent } from '@teach-me-coding/contracts';
import { BusinessError, Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { createApp } from '../http/app.js';
import { createLocalAccess } from '../http/local-access.js';
import { TeachingRuntime } from './runtime.js';
import { conceptIntake, populated, reply, response, routeReply, syntheticSource } from './test-support.js';

test('YOLO accepts only its conversation artifacts and disabling it before completion restores review', async () => {
  for (const kind of ['route', 'lesson', 'conclusion'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
    const unit = units[0]!.id;
    learning.saveLesson(space.id, unit, { title: 'Original', content: 'Original lesson' });
    const session = kind === 'route' ? routeSession : learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'YOLO' }).id;
    const other = learning.createSession(space.id, { scope: kind === 'route' ? 'route' : 'unit', unitId: kind === 'route' ? null : unit, title: 'Manual' }).id;
    learning.saveSessionSettings(space.id, session, { revision: 0, yolo: true });
    let disable = false, candidate = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      if (context.messages.at(-1)?.role === 'toolResult') {
        if (disable) {
          learning.saveSessionSettings(space.id, session, { ...learning.sessionSettings(space.id, session), yolo: false });
          disable = false;
        }
        return response(reply([]));
      }
      candidate++;
      if (kind === 'route') return response(routeReply(context.messages, { ...space.route.content!, note: `YOLO route ${candidate}` }, true)!);
      return response(reply([{ type: 'toolCall', id: randomUUID(), name: kind === 'lesson' ? 'propose_lesson_change' : 'submit_learning_conclusion',
        arguments: kind === 'lesson' ? { title: `Updated ${candidate}`, content: `Updated lesson ${candidate}` } : { text: 'Separate reading from validation.' },
      }], 'toolUse'));
    } });
    const submit = async (owner: string) => {
      const { run } = runtime.submit(space.id, owner, randomUUID(), { text: 'Update', quote: null, draftRevision: learning.session(space.id, owner).draft.revision });
      await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
      return run.id;
    };
    try {
      await submit(other);
      if (kind === 'route') {
        const pending = learning.space(space.id).proposals.at(-1)!;
        assert.equal(pending.state, 'pending'); learning.rejectProposal(space.id, pending.id, {});
      } else if (kind === 'lesson') {
        const pending = learning.space(space.id).lessonProposals.at(-1)!;
        assert.equal(pending.state, 'pending'); learning.rejectLessonProposal(space.id, pending.id, {});
      } else assert.equal(learning.conclusions(space.id).at(-1)!.adopted, false);
      const accepted = await submit(session);
      if (kind === 'route') {
        assert.equal(learning.space(space.id).proposals.at(-1)!.state, 'applied');
        assert.equal(learning.space(space.id).route.content!.note, 'YOLO route 2');
      } else if (kind === 'lesson') {
        assert.equal(learning.space(space.id).lessonProposals.at(-1)!.state, 'applied');
        assert.deepEqual(learning.unit(space.id, unit).lesson, { title: 'Updated 2', content: 'Updated lesson 2', revision: 2 });
      } else assert.deepEqual(learning.conclusions(space.id).map((c) => [c.runId === accepted, c.adopted]), [[false, false], [true, true]]);
      disable = true;
      await submit(session);
      assert.equal(learning.sessionSettings(space.id, session).yolo, false);
      if (kind === 'route') assert.equal(learning.space(space.id).proposals.at(-1)!.state, 'pending');
      if (kind === 'lesson') {
        assert.equal(learning.space(space.id).lessonProposals.at(-1)!.state, 'pending');
        assert.deepEqual(learning.unit(space.id, unit).lesson, { title: 'Updated 2', content: 'Updated lesson 2', revision: 2 });
      }
      if (kind === 'conclusion') assert.equal(learning.conclusions(space.id).at(-1)!.adopted, false);
    } finally { await runtime.close(); db.close(); }
  }
});

test('YOLO confirms ready requirements and plans once, but never supplies clarification answers', async () => {
  for (const askQuestion of [false, true]) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const space = learning.create({ name: 'YOLO intake', goal: 'Learn text processing' }), session = space.sessions[0]!.id;
    learning.saveSessionSettings(space.id, session, { revision: 0, yolo: true });
    let ask = askQuestion;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      if (context.messages.some((m) => m.role === 'system' && m.toolsAdded?.some((t) => t.name === 'submit_route'))) {
        return response(routeReply(context.messages, { stages: [{ title: 'Text processing', units: [{ title: 'Read input' }] }] }) ?? reply([]));
      }
      if (context.messages.at(-1)?.role === 'toolResult') return response(reply([]));
      return response(reply([
        { type: 'toolCall', id: 'draft', name: 'submit_requirement_draft', arguments: { rows: [{ question: 'Goal?', answer: 'Process text files' }] } },
        ...(ask ? [{ type: 'toolCall' as const, id: 'question', name: 'ask_user_question', arguments: { questions: [{ prompt: 'Where will it run?', multiple: false,
          options: [{ label: 'Local command line', description: 'Read local files' }, { label: 'Browser', description: 'Read uploaded files' }] }] } }] : []),
      ], 'toolUse'));
    } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'Plan my learning', quote: null, draftRevision: 0 });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
      if (askQuestion) {
        assert.equal(learning.space(space.id).requirement.confirmed, false);
        assert.equal(learning.space(space.id).runs.filter((r) => r.kind === 'roadmap').length, 0);
        const round = learning.session(space.id, session).questions![0]!;
        assert.equal(round.state, 'pending'); assert.equal(round.answers, null);
        ask = false;
        const answer = runtime.answer(space.id, session, round.id, randomUUID(), { answers: [{ questionId: round.questions[0]!.id, optionIds: [round.questions[0]!.options[0]!.id], customText: '' }] });
        await runtime.idle(answer.run.id);
        assert.equal(learning.session(space.id, session).questions![0]!.state, 'answered');
      }
      const plans = learning.space(space.id).runs.filter((r) => r.kind === 'roadmap');
      assert.equal(plans.length, 1); await runtime.idle(plans[0]!.id);
      assert.equal(learning.space(space.id).requirement.confirmed, true);
      assert.equal(learning.space(space.id).route.content!.stages[0]!.units[0]!.title, 'Read input');
    } finally { await runtime.close(); db.close(); }
  }
});

test('the opening request starts intake once, and only its tool fills the editable requirement', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const opening = `学习 Rust；只会 Python；做字数统计，3 小时/周共6周。${'希望处理不同编码的文件。'.repeat(20)}`;
  const input = { name: 'intake', goal: opening }, key = randomUUID();
  const expected = { rows: [
    { question: '想做什么？', answer: '制作字数统计工具' },
    { question: '已经会什么？', answer: '只会 Python' },
    { question: '怎样算完成？', answer: '处理三个文件' },
    { question: '什么时候学习？', answer: '每周 3 小时，6 周' },
  ] };
  let turns = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    assert.ok(context.messages.some((m) => m.role === 'user' &&
      (typeof m.content === 'string' ? m.content : m.content.filter((part) => part.type === 'text').map((part) => part.text).join('')) === opening));
    return turns++ === 0 ? response(reply([{ type: 'toolCall', name: 'submit_requirement_draft', id: 'draft', arguments: expected }], 'toolUse')) : response(reply([{ type: 'text', text: '请确认时间。' }]));
  } });
  try {
    const space = runtime.createSpace(key, input), session = space.sessions[0]!.id, run = space.runs[0]!;
    assert.deepEqual(space.requirement, { revision: 0, confirmed: false, value: { rows: [] } });
    assert.equal(runtime.createSpace(key, input).id, space.id);
    assert.equal(learning.list().length, 1);
    assert.deepEqual(learning.session(space.id, session).messages.filter((m) => m.role === 'user').map((m) => m.text), [opening]);
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.deepEqual(learning.space(space.id).requirement, { value: expected, revision: 1, confirmed: false });
    assert.equal(runtime.createSpace(key, input).runs.length, 1);
    assert.equal(turns, 2);
    assert.throws(() => runtime.submit(space.id, space.sessions[1]!.id, randomUUID(), { text: 'plan', quote: null, draftRevision: 0 }), { message: 'REQUIREMENT_UNCONFIRMED' });
    const edited = learning.saveRequirement(space.id, { revision: 1, value: { rows: [...expected.rows.slice(0, 3), { question: '什么时候学习？', answer: '每周 7 小时' }] }, intake: conceptIntake, confirmed: false });
    assert.equal(edited.value.rows[3]!.answer, '每周 7 小时');
    assert.equal(learning.saveRequirement(space.id, { ...edited, confirmed: true }).confirmed, true);
    assert.equal(learning.space(space.id).route.content, null);
  } finally { await runtime.close(); db.close(); }
});

test('opening submission rolls back creation on failure and preserves the message when the model is unavailable', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  let calls = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => { calls++; return response(reply([])); } });
  const offline = new TeachingRuntime(learning, null);
  const key = randomUUID(), input = { name: 'opening', goal: '学习 SQL，每周两小时' };
  try {
    db.exec("CREATE TRIGGER fail_opening BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected opening failure'); END");
    assert.throws(() => runtime.createSpace(key, input), /injected opening failure/);
    for (const table of ['spaces', 'sessions', 'messages', 'requests']) assert.equal(db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    db.exec('DROP TRIGGER fail_opening');
    const space = offline.createSpace(key, input), session = space.sessions[0]!.id;
    assert.equal(offline.createSpace(key, input).id, space.id);
    assert.deepEqual(learning.session(space.id, session).messages.map((m) => [m.role, m.text]), [['user', input.goal]]);
    assert.deepEqual(space.requirement.value, { rows: [] });
    assert.equal(space.runs.length, 0);
    assert.equal(calls, 0);
    assert.throws(() => learning.saveRequirement(space.id, { ...space.requirement, confirmed: true }));
    assert.deepEqual(learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: '想理解什么？', answer: '理解 SQL 查询' }] }, confirmed: false }).value.rows,
      [{ question: '想理解什么？', answer: '理解 SQL 查询' }]);
  } finally { await runtime.close(); await offline.close(); db.close(); }
});

test('rejected intake submissions preserve saved drafts, while truncation and version conflicts still prevent publication', async () => {
  for (const variant of ['invalid', 'truncated', 'late'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const created = learning.create({ name: variant, goal: 'initial request' });
    learning.saveRequirement(created.id, { ...created.requirement, value: { rows: [{ question: 'Goal?', answer: 'keep goal' }] }, intake: conceptIntake });
    const space = learning.space(created.id), session = space.sessions[0]!.id;
    let calls = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
      if (calls++ === 0) return response(reply([{ type: 'toolCall', name: 'submit_requirement_draft', id: 'draft', arguments:
        variant === 'invalid' ? { rows: [{ question: 'Goal?' }] } : { rows: [{ question: 'Goal?', answer: 'new model goal' }] },
      }], 'toolUse'));
      if (variant === 'late') learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [...space.requirement.value.rows, { question: 'Schedule?', answer: 'new user value' }] }, confirmed: true });
      return response(reply([{ type: 'text', text: 'partial' }], variant === 'truncated' ? 'length' : 'stop'));
    } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'update', quote: null, draftRevision: 0 });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, variant === 'invalid' ? 'succeeded' : 'failed', variant);
      const saved = learning.space(space.id).requirement;
      assert.equal(saved.value.rows[0]!.answer, 'keep goal');
      assert.equal(saved.confirmed, variant === 'late');
      assert.deepEqual(saved.value.rows.slice(1), variant === 'late' ? [{ question: 'Schedule?', answer: 'new user value' }] : []);
    } finally { await runtime.close(); db.close(); }
  }
});

test('retry reuses the fixed original input, does not duplicate users or clear a newer composer', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const space = learning.create({ name: 'retry', goal: 'retry' }), session = space.sessions[0]!.id;
  let fail = true;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    const last = context.messages.at(-1);
    assert.equal(typeof last?.content === 'string' ? last.content : last?.content.filter((part) => part.type === 'text').map((part) => part.text).join(''), 'original question');
    return response(reply([{ type: 'text', text: 'answer' }], fail ? 'error' : 'stop'));
  } });
  try {
    const first = runtime.submit(space.id, session, randomUUID(), { text: 'original question', quote: null, draftRevision: 0 });
    await runtime.idle(first.run.id);
    learning.saveSessionDraft(space.id, session, { revision: 1, text: 'new draft', quote: null, routeSuggestion: '' });
    fail = false;
    const key = randomUUID(), retried = runtime.retry(space.id, first.run.id, key);
    assert.equal(runtime.retry(space.id, first.run.id, key).run.id, retried.run.id);
    await runtime.idle(retried.run.id);
    assert.equal(runtime.get(space.id, retried.run.id).state, 'succeeded');
    assert.equal(learning.session(space.id, session).messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(learning.session(space.id, session).draft.text, 'new draft');
  } finally { await runtime.close(); db.close(); }
});

test('initial roadmap applies on success while adjustments require confirmation and preserve both baselines', async () => {
  for (const change of ['none', 'requirement', 'route'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const space = learning.create({ name: change, goal: 'learn A not B' }), session = space.sessions[1]!.id;
    learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: 'Goal?', answer: 'learn A not B' }] }, intake: conceptIntake, confirmed: true });
    let content: RouteContent = { note: 'plan', stages: [{ id: randomUUID(), title: 'stage', units: [{ id: randomUUID(), title: 'unit', summary: '', goals: ['A'] }] }] };
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      assert.match(JSON.stringify(context), /learn A not B/);
      const adjustment = !!learning.space(space.id).route.content;
      const next = routeReply(context.messages, { ...content, note: adjustment ? 'adjusted' : 'plan' }, adjustment);
      if (next) return response(next);
      if (change === 'requirement') learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
      if (change === 'route') learning.applyProposal(space.id, learning.proposeRoute(space.id, session, content, undefined, learning.space(space.id).runs.at(-1)!.id).id);
      return response(reply([{ type: 'text', text: '请确认提案' }]));
    } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'plan', quote: null, draftRevision: 0 });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, change === 'none' ? 'succeeded' : 'failed');
      if (change !== 'none') continue;
      const saved = learning.space(space.id).route.content!;
      assert.equal(saved.note, 'plan');
      assert.equal(saved.stages[0]!.title, 'stage');
      assert.deepEqual(saved.stages[0]!.units.map(({ title, summary, goals }) => ({ title, summary, goals })), [{ title: 'unit', summary: '', goals: ['A'] }]);
      assert.notEqual(saved.stages[0]!.id, content.stages[0]!.id);
      content = saved;
      const p = learning.space(space.id).proposals[0]!;
      assert.equal(p.state, 'applied');
      learning.applyProposal(space.id, p.id); learning.applyProposal(space.id, p.id);
      assert.equal(learning.space(space.id).route.revision, 1);
      const old = learning.proposeRoute(space.id, session, content);
      assert.throws(() => runtime.submit(space.id, session, randomUUID(), { text: 'adjust', quote: null, draftRevision: learning.session(space.id, session).draft.revision }), { message: 'ROUTE_PROPOSAL_PENDING' });
      learning.rejectProposal(space.id, old.id, {});
      const adjustment = runtime.submit(space.id, session, randomUUID(), { text: 'adjust', quote: null, draftRevision: learning.session(space.id, session).draft.revision });
      await runtime.idle(adjustment.run.id);
      assert.equal(runtime.get(space.id, adjustment.run.id).state, 'succeeded');
      assert.deepEqual(learning.space(space.id).route.content, content);
      const pending = learning.space(space.id).proposals.at(-1)!;
      assert.equal(pending.state, 'pending');
      assert.equal(pending.runId, adjustment.run.id);
      learning.applyProposal(space.id, pending.id);
      assert.equal(learning.space(space.id).route.content!.note, 'adjusted');
      assert.throws(() => learning.applyProposal(space.id, old.id), { message: 'ROUTE_PROPOSAL_CANNOT_APPLY' });
      const unit = content.stages[0]!.units[0]!.id;
      learning.saveLesson(space.id, unit, { title: 'keep', content: 'learned' });
      const next = learning.proposeRoute(space.id, session, { ...content, note: 'adjust' });
      learning.applyProposal(space.id, next.id);
      assert.equal(learning.unit(space.id, unit).lesson!.content, 'learned');
      const late = learning.proposeRoute(space.id, session, content);
      learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
      assert.throws(() => learning.applyProposal(space.id, late.id), { message: 'CONTENT_CHANGED' });
      learning.rejectProposal(space.id, late.id, {});
      assert.throws(() => learning.proposeRoute(space.id, session, { ...content, stages: [{ ...content.stages[0]!, units: [{ ...content.stages[0]!.units[0]!, id: randomUUID() }] }] }), { message: 'ACTIVE_UNIT_REMOVAL' });
    } finally { await runtime.close(); db.close(); }
  }
});

test('one space has one roadmap round across sessions and runtimes; a published pending proposal gates all session input and retries', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
  const intake = space.sessions.find((session) => session.scope === 'intake')!.id;
  const tutor = learning.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'Tutor' }).id;
  const otherRoute = learning.createSession(space.id, { scope: 'route', unitId: null, title: 'Other route' }).id;
  let mode: 'fail' | 'hold' = 'fail', enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: async (_m, context) => {
    if (mode === 'fail') return response(reply([], 'error'));
    enter(); await held;
    const roadmap = context.messages.some((message) => message.role === 'system' && message.toolsAdded?.some((tool) => tool.name === 'submit_route_proposal'));
    return response((roadmap ? routeReply(context.messages, { ...space.route.content!, note: 'Pending adjustment' }, true) : null) ?? reply([]));
  } });
  const secondRuntime = new TeachingRuntime(learning, syntheticSource, { stream: () => response(reply([])) });
  const conflict = (code: BusinessError['detail']['code']) => (error: unknown) => error instanceof BusinessError && error.status === 409 && error.detail.code === code;
  const submit = (session: string) => runtime.submit(space.id, session, randomUUID(), { text: 'Input', quote: null, draftRevision: learning.session(space.id, session).draft.revision });
  try {
    const failed: string[] = [];
    for (const session of [intake, tutor, routeSession]) {
      const { run } = submit(session); await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'failed'); failed.push(run.id);
    }
    mode = 'hold';
    const { run } = submit(routeSession);
    assert.equal(run.state, 'pending');
    const busy = () => {
      const before = learning.space(space.id), sessionBefore = learning.session(space.id, otherRoute);
      assert.throws(() => secondRuntime.submit(space.id, otherRoute, randomUUID(), { text: 'Another adjustment', quote: null, draftRevision: 0 }), conflict('ROUTE_ADJUSTMENT_RUNNING'));
      assert.throws(() => runtime.retry(space.id, failed[2]!, randomUUID()), conflict('ROUTE_ADJUSTMENT_RUNNING'));
      assert.throws(() => learning.proposeRoute(space.id, otherRoute, space.route.content), conflict('ROUTE_ADJUSTMENT_RUNNING'));
      assert.deepEqual(learning.space(space.id), before);
      assert.deepEqual(learning.session(space.id, otherRoute), sessionBefore);
    };
    busy();
    await entered; assert.equal(runtime.get(space.id, run.id).state, 'running'); busy();
    release(); await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    const pending = learning.space(space.id).proposals.filter((proposal) => proposal.state === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.runId, run.id);
    const newlyCreated = [
      learning.createSession(space.id, { scope: 'intake', unitId: null, title: 'New intake' }),
      learning.createSession(space.id, { scope: 'route', unitId: null, title: 'New route' }),
      learning.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'New tutor' }),
    ];
    for (const session of [intake, tutor, routeSession, otherRoute, ...newlyCreated.map((session) => session.id)]) {
      const before = learning.session(space.id, session), workspace = learning.space(space.id);
      const input = { text: 'Blocked ordinary input', quote: null, draftRevision: before.draft.revision };
      assert.throws(() => runtime.submit(space.id, session, randomUUID(), input), conflict('ROUTE_PROPOSAL_PENDING'));
      assert.throws(() => learning.addMessage(space.id, session, input), conflict('ROUTE_PROPOSAL_PENDING'));
      assert.deepEqual(learning.session(space.id, session), before);
      assert.deepEqual(learning.space(space.id), workspace);
    }
    for (const id of failed) assert.throws(() => runtime.retry(space.id, id, randomUUID()), conflict('ROUTE_PROPOSAL_PENDING'));
    const beforePlan = learning.space(space.id);
    assert.throws(() => runtime.plan(space.id, randomUUID(), beforePlan.requirement), conflict('ROUTE_PROPOSAL_PENDING'));
    assert.deepEqual(learning.space(space.id), beforePlan, 'Blocked planning must not change the requirement baseline.');
    const rejected = runtime.rejectProposal(space.id, pending[0]!.id, randomUUID(), {});
    assert.equal(rejected.run, null); assert.equal(rejected.followupError, null);
    assert.equal(rejected.workspace.route.revision, space.route.revision);
    assert.equal(rejected.workspace.runs.length, beforePlan.runs.length);
    const retry = runtime.retry(space.id, failed[0]!, randomUUID()); await runtime.idle(retry.run.id);
    assert.equal(runtime.get(space.id, retry.run.id).state, 'succeeded');
  } finally { release(); await Promise.all([runtime.close(), secondRuntime.close()]); db.close(); }
});

test('feedback rejection records one terminal decision and starts B from the applied route, using A only as a reference', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
  const stageId = space.route.content!.stages[0]!.id, feedback = 'Keep the original plan; correct its summary.';
  let phase: 'A' | 'B' = 'A';
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    const turn = context.messages.slice(context.messages.findLastIndex((message) => message.role === 'user') + 1);
    const calls = turn.flatMap((message) => message.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall') : []);
    if (phase === 'A' && !calls.length) return response(reply([{ type: 'toolCall', id: 'addition', name: 'add_route_unit',
      arguments: { stageId, title: 'A-ONLY-ADDITION', summary: 'Do not use as baseline' } }], 'toolUse'));
    if (phase === 'B' && !calls.length) {
      const text = context.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string'
        ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')).find((text) => text.includes('<context schemaVersion='))!;
      const applied = text.match(/<source kind="route"[^>]*>(.*?)<\/source>/s)?.[1];
      const rejected = text.match(/<source kind="rejected-route-proposal"[^>]*>(.*?)<\/source>/s)?.[1];
      assert.ok(applied); assert.doesNotMatch(applied, /A-ONLY-ADDITION/); assert.match(applied, new RegExp(units[0]!.id));
      assert.ok(rejected); assert.match(rejected, /A-ONLY-ADDITION/); assert.match(rejected, /Keep the original plan/);
      return response(reply([{ type: 'toolCall', id: 'correction', name: 'update_route_unit',
        arguments: { unitId: units[0]!.id, summary: 'B corrected wording' } }], 'toolUse'));
    }
    if (calls.length === 1) return response(reply([{ type: 'toolCall', id: 'submit', name: 'submit_route_proposal', arguments: { note: phase } }], 'toolUse'));
    return response(reply([{ type: 'text', text: 'Please review.' }]));
  } });
  try {
    const first = runtime.submit(space.id, routeSession, randomUUID(), { text: 'Propose A', quote: null, draftRevision: 0 });
    await runtime.idle(first.run.id); assert.equal(runtime.get(space.id, first.run.id).state, 'succeeded');
    const a = learning.space(space.id).proposals.at(-1)!;
    assert.equal(a.state, 'pending'); assert.equal(a.content.stages[0]!.units.length, 3);
    const draft = learning.saveSessionDraft(space.id, routeSession, { ...learning.session(space.id, routeSession).draft, text: 'Unrelated composer', quote: null }).draft;
    phase = 'B';
    const key = randomUUID();
    db.exec("CREATE TRIGGER fail_feedback_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected feedback failure'); END");
    const before = learning.space(space.id), sessionBefore = learning.session(space.id, routeSession);
    assert.throws(() => runtime.rejectProposal(space.id, a.id, key, { feedback }), /injected feedback failure/);
    assert.deepEqual(learning.space(space.id), before); assert.deepEqual(learning.session(space.id, routeSession), sessionBefore);
    db.exec('DROP TRIGGER fail_feedback_run');
    const decision = runtime.rejectProposal(space.id, a.id, key, { feedback });
    assert.ok(decision.run); assert.equal(decision.run.kind, 'roadmap'); assert.equal(decision.followupError, null);
    assert.equal(decision.workspace.proposals.find((proposal) => proposal.id === a.id)!.state, 'rejected');
    assert.equal(decision.workspace.proposals.find((proposal) => proposal.id === a.id)!.feedback, feedback);
    assert.deepEqual(decision.session.draft, draft);
    assert.equal(runtime.rejectProposal(space.id, a.id, key, { feedback }).run!.id, decision.run.id);
    assert.equal(runtime.rejectProposal(space.id, a.id, randomUUID(), { feedback }).run, null);
    await runtime.idle(decision.run.id); assert.equal(runtime.get(space.id, decision.run.id).state, 'succeeded', JSON.stringify(runtime.get(space.id, decision.run.id).error));
    const current = learning.space(space.id), b = current.proposals.at(-1)!;
    assert.equal(current.runs.length, space.runs.length + 2);
    assert.deepEqual(current.route, space.route);
    assert.equal(b.state, 'pending'); assert.equal(b.runId, decision.run.id);
    assert.equal(b.baseRevision, space.route.revision); assert.equal(b.requirementRevision, space.requirement.revision);
    assert.deepEqual(b.content.stages[0]!.units, [{ ...units[0]!, summary: 'B corrected wording' }, units[1]!]);
    assert.equal(current.proposals.filter((proposal) => proposal.state === 'pending').length, 1);
    assert.equal(learning.session(space.id, routeSession).messages.filter((message) => message.role === 'user' && message.text === feedback).length, 1);
    assert.throws(() => learning.applyProposal(space.id, a.id), { message: 'ROUTE_PROPOSAL_CANNOT_APPLY' });
    assert.throws(() => runtime.rejectProposal(space.id, a.id, randomUUID(), { feedback: 'Different decision' }), { message: 'ROUTE_PROPOSAL_CANNOT_DECIDE' });
    assert.equal(runtime.rejectProposal(space.id, a.id, key, { feedback }).run!.id, decision.run.id);
    assert.equal(learning.space(space.id).runs.length, current.runs.length);
    learning.applyProposal(space.id, b.id); learning.applyProposal(space.id, b.id);
    assert.equal(learning.space(space.id).route.revision, space.route.revision + 1);
  } finally { await runtime.close(); db.close(); }
});

test('offline rejection saves the terminal decision and optional feedback without starting or later replaying generation', async () => {
  for (const feedback of ['', 'Saved feedback while offline']) {
    const db = openDatabase(':memory:'), learning = new Learning(db), { space, routeSession } = populated(learning);
    const offline = new TeachingRuntime(learning, null);
    const online = new TeachingRuntime(learning, syntheticSource, { stream: () => response(reply([])) });
    try {
      const proposal = learning.proposeRoute(space.id, routeSession, space.route.content);
      const saved = learning.saveSessionDraft(space.id, routeSession, { revision: 0, text: 'Keep my draft', quote: null, routeSuggestion: '' });
      const key = randomUUID(), decision = offline.rejectProposal(space.id, proposal.id, key, { feedback });
      assert.equal(decision.run, null); assert.deepEqual(decision.workspace.route, space.route);
      assert.equal(decision.workspace.runs.length, 0); assert.deepEqual(decision.session.draft, saved.draft);
      const rejected = decision.workspace.proposals.find((item) => item.id === proposal.id)!;
      assert.equal(rejected.state, 'rejected'); assert.equal(rejected.feedback, feedback);
      assert.deepEqual(decision.session.messages.map((message) => [message.role, message.text]), feedback ? [['user', feedback]] : []);
      if (feedback) assert.deepEqual(decision.followupError, { code: 'MODEL_UNAVAILABLE' });
      else assert.equal(decision.followupError, null);
      assert.equal(offline.rejectProposal(space.id, proposal.id, key, { feedback }).run, null);
      assert.equal(online.rejectProposal(space.id, proposal.id, key, { feedback }).run, null);
      assert.equal(online.rejectProposal(space.id, proposal.id, randomUUID(), { feedback }).run, null);
      assert.equal(learning.space(space.id).runs.length, 0);
      assert.deepEqual(learning.session(space.id, routeSession), decision.session);
      assert.throws(() => learning.applyProposal(space.id, proposal.id), { message: 'ROUTE_PROPOSAL_CANNOT_APPLY' });
    } finally { await Promise.all([offline.close(), online.close()]); db.close(); }
  }
});

test('pending-proposal HTTP gates preserve intake answers, permit session reads/creation, and allow offline terminal decisions', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning), other = populated(learning, 'Other');
  const intake = space.sessions.find((session) => session.scope === 'intake')!.id;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => context.messages.at(-1)?.role === 'toolResult'
    ? response(reply([])) : response(reply([{ type: 'toolCall', id: 'question', name: 'ask_user_question', arguments: { questions: [
      { prompt: 'Which exercise?', multiple: false, options: [{ label: 'Trace', description: 'Follow the state' }, { label: 'Compare', description: 'Compare alternatives' }] },
    ] } }], 'toolUse')) });
  const access = createLocalAccess({ port: 14333 }), app = createApp(access, learning, undefined, runtime), offlineApp = createApp(access, learning);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, key = randomUUID(), server = app) => server.request(`/api${path}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body),
  });
  try {
    const { run } = runtime.submit(space.id, intake, randomUUID(), { text: 'Ask about exercises', quote: null, draftRevision: 0 });
    // The already-started intake can publish its question while the route enters review.
    const proposal = learning.proposeRoute(space.id, routeSession, space.route.content);
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    const round = learning.session(space.id, intake).questions!.at(-1)!, question = round.questions[0]!;
    const base = `/spaces/${space.id}`, decisionPath = `${base}/proposals/${proposal.id}`;
    const session = await post(`${base}/sessions`, { scope: 'unit', unitId: units[0]!.id, title: 'Created during review' });
    assert.equal(session.status, 200); const created = await session.json();
    assert.equal((await app.request(`/api${base}/sessions/${created.id}`, { headers })).status, 200);
    assert.equal((await app.request(`/api${base}`, { headers })).status, 200);
    const before = learning.session(space.id, intake), workspace = learning.space(space.id);
    const answer = { answers: [{ questionId: question.id, optionIds: [question.options[0]!.id], customText: '' }] };
    assert.equal((await post(`${base}/sessions/${intake}/questions/${round.id}/answer`, answer)).status, 409);
    for (const id of [intake, routeSession, created.id]) {
      const input = { text: 'Blocked', quote: null, draftRevision: learning.session(space.id, id).draft.revision };
      for (const endpoint of ['messages', 'runs']) {
        const blocked = await post(`${base}/sessions/${id}/${endpoint}`, input);
        assert.equal(blocked.status, 409); assert.deepEqual(await blocked.json(), { code: 'ROUTE_PROPOSAL_PENDING' });
      }
    }
    assert.deepEqual(learning.session(space.id, intake), before, 'Rejected answer must remain pending and must not append its text.');
    assert.deepEqual(learning.space(space.id), workspace);
    assert.equal((await post(`${decisionPath}/reject`, { feedback: 17 })).status, 400);
    assert.equal((await post(`${decisionPath}/reject`, { feedback: '', unexpected: true })).status, 400);
    assert.equal((await post(`/spaces/${other.space.id}/proposals/${proposal.id}/reject`, {})).status, 404);
    assert.equal((await app.request(`/api${decisionPath}/reject`, { method: 'POST', headers: { ...headers, 'X-TMC-Token': '' }, body: '{}' })).status, 401);
    const key = randomUUID(), rejected = await post(`${decisionPath}/reject`, { feedback: '  Offline feedback  ' }, key, offlineApp);
    assert.equal(rejected.status, 200); const receipt = await rejected.json();
    assert.equal(receipt.run, null); assert.deepEqual(receipt.followupError, { code: 'MODEL_UNAVAILABLE' });
    assert.equal(receipt.workspace.proposals.find((item: { id: string }) => item.id === proposal.id).feedback, 'Offline feedback');
    assert.equal((await post(`${decisionPath}/reject`, { feedback: 'Offline feedback' }, key, offlineApp)).status, 200);
    assert.equal((await post(`${decisionPath}/reject`, { feedback: 'Changed feedback' }, key)).status, 409);
    assert.equal((await post(`${decisionPath}/apply`, {})).status, 409);
    assert.equal(learning.space(space.id).runs.length, workspace.runs.length);
    assert.deepEqual(learning.space(space.id).route, workspace.route);
  } finally { await runtime.close(); db.close(); }
});

test('pending and running lesson activity protects IDs and goals at publication and acceptance without re-locking retained units', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning), unit = units[0]!;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: async () => { enter(); await held; return response(reply([], 'error')); } });
  try {
    const removed = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [units[1]!] }] };
    const proposal = learning.proposeRoute(space.id, routeSession, removed);
    const before = learning.space(space.id);
    assert.throws(() => runtime.generate(space.id, unit.id, randomUUID(), { kind: 'lesson', revision: 0 }), { message: 'ROUTE_PROPOSAL_PENDING' });
    assert.deepEqual(learning.space(space.id), before, 'Pending review prevents starting an independent task.');
    const reviewSession = learning.createSession(space.id, { scope: 'unit', unitId: unit.id, title: 'Review' });
    learning.saveSessionDraft(space.id, reviewSession.id, { revision: 0, text: 'Saved learning activity during review', quote: null, routeSuggestion: '' });
    assert.throws(() => learning.applyProposal(space.id, proposal.id), { message: 'ACTIVE_UNIT_REMOVAL' });
    learning.saveSessionDraft(space.id, reviewSession.id, { revision: 1, text: '', quote: null, routeSuggestion: '' });
    learning.rejectProposal(space.id, proposal.id, {});
    const task = runtime.generate(space.id, unit.id, randomUUID(), { kind: 'lesson', revision: 0 });
    assert.equal(task.state, 'pending');
    assert.equal(learning.unit(space.id, unit.id).started, false, 'An empty active task is protected but has not yet saved learning content.');
    assert.equal(learning.progress(space.id).find((progress) => progress.id === unit.id)!.active, true);
    assert.throws(() => learning.proposeRoute(space.id, routeSession, removed), { message: 'ACTIVE_UNIT_REMOVAL' });
    await entered; assert.equal(runtime.get(space.id, task.id).state, 'running');
    const retargeted = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [{ ...unit, goals: ['Replacement objective'] }, units[1]!] }] };
    assert.throws(() => learning.proposeRoute(space.id, routeSession, retargeted), { message: 'ACTIVE_UNIT_GOALS_CHANGED' });
    const supplement = { id: randomUUID(), title: 'Inserted prerequisite', summary: '', goals: [] };
    const retained = { note: 'Supplement before active learning', stages: [
      { id: randomUUID(), title: 'Supplement', units: [supplement] },
      { ...space.route.content!.stages[0]!, units: [{ ...unit, title: 'Corrected title' }, units[1]!] },
    ] };
    learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, retained).id);
    assert.doesNotThrow(() => learning.assertUnitUnlocked(space.id, unit.id));
    assert.equal(learning.progress(space.id).find((progress) => progress.id === unit.id)!.active, true);
    release(); await runtime.idle(task.id); assert.equal(runtime.get(space.id, task.id).state, 'failed');
    assert.equal(learning.unit(space.id, unit.id).started, false, 'Failed generation alone is not saved learning progress.');
    assert.equal(learning.progress(space.id).find((progress) => progress.id === unit.id)!.active, false);
  } finally { release(); await runtime.close(); db.close(); }
});

test('confirmation and planning commit atomically, retry once, and persist the initial route without a subscriber', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const space = learning.create({ name: 'Atomic plan', goal: 'learn' });
  const input = { ...space.requirement, value: { rows: [{ question: 'Goal?', answer: 'learn A' }] }, intake: conceptIntake, confirmed: true }, key = randomUUID();
  const content = { note: 'A before B', stages: [{ id: randomUUID(), title: 'first', units: [{ id: randomUUID(), title: 'A', summary: 'intro', goals: ['A'] }] }] };
  let calls = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    calls++;
    return response(routeReply(context.messages, content) ?? reply([]));
  } });
  try {
    db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected planning failure'); END");
    assert.throws(() => runtime.plan(space.id, key, input), /injected planning failure/);
    assert.deepEqual(learning.space(space.id).requirement, space.requirement);
    assert.equal(learning.space(space.id).runs.length, 0);
    assert.equal(db.prepare<[], { n: number }>('SELECT count(*) n FROM requests').get()!.n, 0);
    assert.equal(calls, 0);
    db.exec('DROP TRIGGER fail_plan');
    const { run } = runtime.plan(space.id, key, input);
    assert.equal(runtime.plan(space.id, key, input).run.id, run.id);
    assert.equal(learning.space(space.id).requirement.confirmed, true);
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.equal(runtime.plan(space.id, key, input).run.id, run.id);
    const saved = learning.space(space.id).route.content!;
    assert.equal(saved.note, 'A before B');
    assert.deepEqual(saved.stages.map((s) => ({ title: s.title, units: s.units.map(({ title, summary, goals }) => ({ title, summary, goals })) })),
      [{ title: 'first', units: [{ title: 'A', summary: 'intro', goals: ['A'] }] }]);
    assert.equal(learning.space(space.id).route.revision, 1);
    assert.equal(learning.session(space.id, run.sessionId!).messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(calls, 2);
  } finally { await runtime.close(); db.close(); }
});

test('missing, invalid, truncated and cancelled initial routes cannot be published; explicit retry can recover', async () => {
  for (const variant of ['missing', 'invalid', 'truncated', 'cancelled', 'cancelled-after-submit', 'commit-failed'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const space = learning.create({ name: variant, goal: 'learn' });
    const content = { note: 'retry', stages: [{ id: randomUUID(), title: 'stage', units: [{ id: randomUUID(), title: 'unit', summary: '', goals: ['A'] }] }] };
    let retrying = false;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      if (!retrying && variant === 'missing') return response(reply([{ type: 'text', text: 'I made a plan without submitting it' }]));
      if (!retrying && variant === 'invalid') return response(context.messages.at(-1)?.role === 'toolResult' ? reply([])
        : reply([{ type: 'toolCall', id: 'invalid', name: 'submit_route', arguments: { stages: [] } }], 'toolUse'));
      if (!retrying && variant === 'cancelled-after-submit' && context.messages.at(-1)?.role === 'toolResult') {
        runtime.stop(space.id, learning.space(space.id).runs.at(-1)!.id);
      }
      return response(routeReply(context.messages, content) ?? reply([], !retrying && variant === 'truncated' ? 'length' : 'stop'));
    } });
    try {
      if (variant === 'commit-failed') db.exec("CREATE TRIGGER fail_route BEFORE UPDATE ON routes BEGIN SELECT RAISE(ABORT, 'injected route save failure'); END");
      const { run } = runtime.plan(space.id, randomUUID(), { ...space.requirement, value: { rows: [{ question: 'Goal?', answer: 'A' }] }, intake: conceptIntake, confirmed: true });
      if (variant === 'cancelled') runtime.stop(space.id, run.id);
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, variant.startsWith('cancelled') ? 'interrupted' : 'failed');
      assert.equal(learning.space(space.id).route.content, null);
      assert.equal(learning.space(space.id).proposals.length, 0);
      if (variant === 'commit-failed') db.exec('DROP TRIGGER fail_route');
      retrying = true;
      const next = runtime.retry(space.id, run.id, randomUUID());
      await runtime.idle(next.run.id);
      assert.equal(runtime.get(space.id, next.run.id).state, 'succeeded');
      const saved = learning.space(space.id).route.content!;
      assert.equal(saved.note, 'retry');
      assert.equal(saved.stages[0]!.title, 'stage');
      assert.deepEqual(saved.stages[0]!.units.map((u) => u.goals), [['A']]);
      assert.equal(learning.session(space.id, run.sessionId!).messages.filter((m) => m.role === 'user').length, 1);
    } finally { await runtime.close(); db.close(); }
  }
});

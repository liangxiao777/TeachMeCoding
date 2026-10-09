import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { RouteContent } from '@teach-me-coding/contracts';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { TeachingRuntime } from './runtime.js';
import { conceptIntake, reply, response, routeReply, syntheticSource } from './test-support.js';

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
    assert.ok(context.messages.some((m) => m.role === 'user' && m.content === opening));
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
    assert.throws(() => runtime.submit(space.id, space.sessions[1]!.id, randomUUID(), { text: 'plan', quote: null, draftRevision: 0 }), /先确认/);
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
    assert.equal(context.messages.at(-1)?.content, 'original question');
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
      if (change === 'route') learning.applyProposal(space.id, learning.proposeRoute(space.id, session, content).id);
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
      const adjustment = runtime.submit(space.id, session, randomUUID(), { text: 'adjust', quote: null, draftRevision: learning.session(space.id, session).draft.revision });
      await runtime.idle(adjustment.run.id);
      assert.equal(runtime.get(space.id, adjustment.run.id).state, 'succeeded');
      assert.deepEqual(learning.space(space.id).route.content, content);
      const pending = learning.space(space.id).proposals.at(-1)!;
      assert.equal(pending.state, 'pending');
      learning.applyProposal(space.id, pending.id);
      assert.equal(learning.space(space.id).route.content!.note, 'adjusted');
      assert.throws(() => learning.applyProposal(space.id, old.id), /内容已改变/);
      const unit = content.stages[0]!.units[0]!.id;
      learning.saveLesson(space.id, unit, { title: 'keep', content: 'learned' });
      const next = learning.proposeRoute(space.id, session, { ...content, note: 'adjust' });
      learning.applyProposal(space.id, next.id);
      assert.equal(learning.unit(space.id, unit).lesson!.content, 'learned');
      const late = learning.proposeRoute(space.id, session, content);
      learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
      assert.throws(() => learning.applyProposal(space.id, late.id), /内容已改变/);
      const remove = learning.proposeRoute(space.id, session, { ...content, stages: [{ ...content.stages[0]!, units: [{ ...content.stages[0]!.units[0]!, id: randomUUID() }] }] });
      assert.throws(() => learning.applyProposal(space.id, remove.id), /不能移除/);
    } finally { await runtime.close(); db.close(); }
  }
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

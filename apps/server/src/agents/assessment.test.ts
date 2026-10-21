import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type JsonObject } from '@earendil-works/pi-ai';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { Assessments } from '../modules/assessments.js';
import { TeachingRuntime } from './runtime.js';
import { approveLesson, populated, reply, response, syntheticSource } from './test-support.js';

const spec = { public: { q1: '解释参数的来源', q2: '读取参数并显示数量', starter: '', q2Kind: 'code' as const },
  rubric: { q1: { answer: 'PRIVATE-RUBRIC-ONE', criteria: ['明确调用者'] }, q2: { answer: 'PRIVATE-RUBRIC-TWO', criteria: ['排除程序名'] } } };
const execution = { language: 'javascript' as const, cases: [{ args: ['red', 'blue'], expected: '2' }, { args: [], expected: '0' }] };
const grade = { result: 'pass', summary: '已说明参数来源', mastered: ['参数读取'], concerns: [], evidence: ['回答提到调用者'], toVerify: [] };
function fixture() {
  const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l), unit = units[0]!.id;
  l.saveLesson(space.id, unit, { title: '参数', content: '公开课件' });
  return { db, l, space, unit, a: new Assessments(l), sources: { requirement: space.requirement.revision, route: space.route.revision, lesson: 1 } };
}

test('private rubric is separated from public unit, tutor context and task event text; stale generation preserves versions', async () => {
  const { db, l, space, unit } = fixture(); let late = false, tutor = false;
  const generated = { ...spec, public: { ...spec.public, execution } };
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    if (tutor) {
      const value = JSON.stringify(context);
      assert.match(value, /解释参数的来源/); assert.doesNotMatch(value, /PRIVATE-RUBRIC/);
      assert.match(value, /只给提示/);
      return response(reply([{ type: 'text', text: '先想一想调用者传入什么。' }]));
    }
    if (context.messages.at(-1)?.role !== 'toolResult') {
      const tool = { type: 'toolCall' as const, id: 'questions', name: 'submit_assessment', arguments: generated };
      const partial = reply([tool], 'toolUse'), stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: reply([], 'pending') });
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial });
      stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(generated), partial });
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: tool, partial });
      stream.push({ type: 'done', reason: 'toolUse', message: partial });
      return stream;
    }
    if (late) approveLesson(l, space.id, unit, { title: 'updated', content: '新的课件' });
    return response(reply([
      { type: 'thinking', thinking: 'PRIVATE-RUBRIC reasoning must remain private', thinkingSignature: 'PRIVATE-SIGNATURE' },
      { type: 'text', text: 'PRIVATE-RUBRIC must never stream to browser' },
    ]));
  } });
  try {
    const run = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 0 });
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.equal(l.unit(space.id, unit).assessment?.revision, 1);
    assert.doesNotMatch(JSON.stringify(l.unit(space.id, unit)), /PRIVATE-RUBRIC/);
    assert.doesNotMatch(JSON.stringify(runtime.events(space.id, run.id)), /PRIVATE-RUBRIC/);
    assert.doesNotMatch(JSON.stringify(runtime.events(space.id, run.id)), /PRIVATE-SIGNATURE/);
    const publicTools = runtime.events(space.id, run.id).events.flatMap((e) => e.data.type === 'tool' ? [e.data] : []);
    assert.ok(publicTools.every((t) => t.inputDelta === undefined));
    assert.deepEqual(publicTools.find((t) => t.phase === 'ready')?.input, { public: generated.public });
    assert.deepEqual(runtime.events(space.id, run.id).events.flatMap((e) => e.data.type === 'reasoning' ? [e.data.phase] : []), ['start', 'end']);
    assert.match(JSON.stringify(db.prepare('SELECT rubric FROM assessment_versions').all()), /PRIVATE-RUBRIC/);
    tutor = true;
    const session = l.createSession(space.id, { scope: 'unit', unitId: unit, title: '辅导' });
    const request = runtime.submit(space.id, session.id, randomUUID(), { text: '给我答案', quote: null, draftRevision: 0 });
    await runtime.idle(request.run.id); assert.equal(runtime.get(space.id, request.run.id).state, 'succeeded');
    tutor = false; late = true;
    const stale = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 1 });
    await runtime.idle(stale.id); assert.equal(runtime.get(space.id, stale.id).state, 'failed');
    assert.equal(l.unit(space.id, unit).assessment?.revision, 1);
  } finally { await runtime.close(); db.close(); }
});

test('Pi accepts long Markdown questions and omitted assessment defaults in newly saved public specs', async () => {
  const { db, l, space, unit } = fixture();
  const prefix = '  ## 解释参数\r\n\n```js\n  console.log(process.argv)\n```\n\n';
  const q1 = prefix + '文'.repeat(100_000 - prefix.length - 2) + ' \n';
  let submission: JsonObject = { public: { q1, q2: '说明零个参数与两个参数的区别', q2Kind: 'reasoning' }, rubric: spec.rubric };
  const feedback: boolean[] = [];
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') {
      feedback.push(last.isError);
      return response(reply([]));
    }
    return response(reply([{ type: 'toolCall', id: 'questions', name: 'submit_assessment', arguments: submission }], 'toolUse'));
  } });
  try {
    const reasoning = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 0 });
    await runtime.idle(reasoning.id);
    assert.equal(runtime.get(space.id, reasoning.id).state, 'succeeded');
    assert.deepEqual(l.unit(space.id, unit).assessment, { ...submission.public as JsonObject, starter: '', revision: 1 });
    assert.equal(l.unit(space.id, unit).assessment!.q1, q1);
    assert.equal(q1.length, 100_000);
    assert.equal(l.unit(space.id, unit).assessment!.execution, undefined);
    submission = { public: { q1: spec.public.q1, q2: spec.public.q2, execution }, rubric: spec.rubric };
    const code = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 1 });
    await runtime.idle(code.id);
    assert.equal(runtime.get(space.id, code.id).state, 'succeeded');
    assert.deepEqual(l.unit(space.id, unit).assessment, { ...submission.public as JsonObject, starter: '', q2Kind: 'code', revision: 2 });
    assert.deepEqual(feedback, [false, false]);
    assert.doesNotMatch(JSON.stringify(l.unit(space.id, unit)), /PRIVATE-RUBRIC/);
    for (const run of [reasoning, code]) assert.doesNotMatch(JSON.stringify(runtime.events(space.id, run.id)), /PRIVATE-RUBRIC/);
  } finally { await runtime.close(); db.close(); }
});

test('Pi feeds invalid assessment submissions back without replacing a successful same-run artifact', async () => {
  const { db, l, space, unit } = fixture();
  const valid = { ...spec, public: { ...spec.public, starter: '  // 起始代码\r\n', execution } };
  const planless = { public: { q1: '不能覆盖原题', q2: spec.public.q2 }, rubric: spec.rubric };
  const submissions: JsonObject[] = [valid, planless, ...[
    { q1: {} }, { q1: ' \r\n\t ' }, { q1: 'x'.repeat(100_001) }, { q2: [] }, { starter: {} }, { q2Kind: [] }, { execution: [] },
  ].map((publicFields) => ({ ...valid, public: { ...valid.public, ...publicFields } }))];
  const feedback: { failed: boolean; text: string }[] = [];
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') feedback.push({ failed: last.isError, text: JSON.stringify(last.content) });
    const index = context.messages.filter((m) => m.role === 'toolResult').length;
    return response(index < submissions.length
      ? reply([{ type: 'toolCall', id: `questions-${index}`, name: 'submit_assessment', arguments: submissions[index]! }], 'toolUse')
      : reply([]));
  } });
  try {
    const run = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 0 });
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.deepEqual(feedback.map((f) => f.failed), submissions.map((_, i) => i > 0));
    assert.deepEqual(JSON.parse(feedback[1]!.text), [{ type: 'text', text: 'CODE_PLAN_UNAVAILABLE' }]);
    assert.deepEqual(l.unit(space.id, unit).assessment, { ...valid.public, revision: 1 });
    assert.doesNotMatch(JSON.stringify(runtime.events(space.id, run.id)), /PRIVATE-RUBRIC/);
    submissions.splice(0, submissions.length, planless); feedback.length = 0;
    const rejected = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 1 });
    await runtime.idle(rejected.id);
    assert.equal(runtime.get(space.id, rejected.id).state, 'failed');
    assert.equal(feedback[0]!.failed, true);
    assert.deepEqual(l.unit(space.id, unit).assessment, { ...valid.public, revision: 1 });
  } finally { await runtime.close(); db.close(); }
});

test('Pi accepts partial or omitted grade arrays, preserves supplied arrays and rejects invalid array types', async () => {
  const { db, l, space, unit, a, sources } = fixture();
  a.saveSpec(space.id, unit, { ...spec, public: { ...spec.public, q2Kind: 'reasoning' } }, sources, 0);
  const cases: Record<string, string[]>[] = [{}, { mastered: ['保留掌握项'], evidence: ['保留依据'] }, { concerns: ['保留关注点'], toVerify: ['保留待验证项'] }];
  let submissions: JsonObject[] = [];
  const feedback: boolean[] = [];
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') feedback.push(last.isError);
    const index = context.messages.filter((m) => m.role === 'toolResult').length;
    return response(index < submissions.length
      ? reply([{ type: 'toolCall', id: `grade-${index}`, name: 'submit_evaluation', arguments: submissions[index]! }], 'toolUse')
      : reply([]));
  } });
  try {
    for (const arrays of cases) {
      const proposed = { result: 'needs_work', summary: '继续练习边界', ...arrays };
      submissions = [proposed, ...['mastered', 'concerns', 'evidence', 'toVerify'].map((key) => ({ ...grade, [key]: {} })),
        { ...grade, evidence: [{}] }];
      feedback.length = 0;
      const run = runtime.generate(space.id, unit, randomUUID(), { kind: 'evaluation', revision: 0, specRevision: 1, q1: '调用者', q2: '两个字符串' });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
      assert.deepEqual(feedback, [false, true, true, true, true, true]);
      const saved = l.unit(space.id, unit).records[0]!;
      assert.equal(saved.result, 'needs_work'); assert.equal(saved.summary, proposed.summary);
      assert.equal(saved.verification, 'non-execution'); assert.equal(saved.valid, true);
      for (const key of ['mastered', 'concerns', 'evidence', 'toVerify'] as const) assert.deepEqual(saved[key], arrays[key] ?? []);
      assert.doesNotMatch(JSON.stringify(runtime.events(space.id, run.id)), /PRIVATE-RUBRIC/);
    }
    a.saveSpec(space.id, unit, spec, sources, 1);
    submissions = [{ result: 'pass', summary: '静态分析不能证明运行通过' }]; feedback.length = 0;
    const code = runtime.generate(space.id, unit, randomUUID(), { kind: 'evaluation', revision: 0, specRevision: 2, q1: '调用者', q2: 'console.log(2)' });
    await runtime.idle(code.id);
    assert.equal(runtime.get(space.id, code.id).state, 'succeeded'); assert.deepEqual(feedback, [false]);
    const saved = l.unit(space.id, unit).records[0]!;
    assert.equal(saved.result, 'unverified'); assert.equal(saved.verification, 'execution-unverified'); assert.equal(saved.valid, false);
    for (const key of ['mastered', 'concerns', 'evidence', 'toVerify'] as const) assert.deepEqual(saved[key], []);
    assert.notEqual(l.unit(space.id, unit).status, 'passed');
  } finally { await runtime.close(); db.close(); }
});

test('immutable submissions grade original answers, never clear newer drafts, and only current non-execution evidence counts', () => {
  const { db, l, space, unit, a, sources } = fixture();
  try {
    a.saveSpec(space.id, unit, { ...spec, public: { ...spec.public, q2Kind: 'reasoning' } }, sources, 0);
    const fixed = a.submit(space.id, unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '原答案：调用者', q2: '两个参数' });
    l.saveAssessmentDraft(space.id, unit, { revision: 0, q1: 'NEW-DRAFT', q2: 'new code' });
    const result = a.grade(space.id, unit, fixed, grade);
    assert.equal(result.answers.q1, '原答案：调用者'); assert.equal(result.attempt, 1); assert.equal(result.valid, true);
    assert.equal(l.unit(space.id, unit).draft.q1, 'NEW-DRAFT'); assert.equal(l.unit(space.id, unit).status, 'passed');
    assert.equal(a.grade(space.id, unit, fixed, { ...grade, result: 'needs_work' }).result, 'pass');
    const next = a.submit(space.id, unit, { kind: 'evaluation', revision: 1, specRevision: 1, q1: '第二提交', q2: '不同答案' });
    assert.equal(next.submission.attempt, 2);
    approveLesson(l, space.id, unit, { title: 'new', content: 'changed explanations' });
    assert.equal(a.grade(space.id, unit, next, grade).valid, false);
    assert.equal(l.unit(space.id, unit).draft.q1, 'NEW-DRAFT');
    assert.ok(l.unit(space.id, unit).records.every((r) => !r.valid));
    assert.notEqual(l.unit(space.id, unit).status, 'passed');
    assert.throws(() => a.submit(space.id, unit, { kind: 'evaluation', revision: 1, specRevision: 1, q1: 'new', q2: '' }), { message: 'CONTENT_CHANGED' });
  } finally { db.close(); }
});

test('missing execution and succeeded/failed execution fixtures never award code mastery or pass', () => {
  const { db, l, space, unit, a, sources } = fixture();
  try {
    a.saveSpec(space.id, unit, spec, sources, 0);
    for (const evidence of [{ kind: 'none' as const }, { kind: 'fixture' as const, status: 'succeeded' as const, output: 'pretend pass' }, { kind: 'fixture' as const, status: 'failed' as const, output: 'exit 1' }]) {
      const fixed = a.submit(space.id, unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '调用者', q2: 'print(1)' }, evidence);
      const result = a.grade(space.id, unit, fixed, grade);
      assert.equal(result.result, 'unverified'); assert.equal(result.valid, false); assert.deepEqual(result.mastered, []);
      assert.equal(result.verification, evidence.kind === 'fixture' && evidence.status === 'failed' ? 'execution-failed' : 'execution-unverified');
    }
    assert.notEqual(l.unit(space.id, unit).status, 'passed');
    assert.deepEqual(l.unit(space.id, unit).records.map((r) => r.attempt), [3, 2, 1]);
    assert.throws(() => a.submit(space.id, unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'answer', q2: '', evidence: { kind: 'real' } }));
  } finally { db.close(); }
});

test('evaluation failures create no result; retries keep one fixed submission and exclude mutable profile and draft', async () => {
  const { db, l, space, unit, a, sources } = fixture(); a.saveSpec(space.id, unit, spec, sources, 0);
  let fail = true;
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    const value = JSON.stringify(context);
    assert.match(value, /PRIVATE-RUBRIC-ONE/); assert.match(value, /FIXED-ANSWER/); assert.doesNotMatch(value, /NEW-DRAFT|学习 Rust|公开课件/);
    if (fail) return response(reply([], 'error'));
    if (context.messages.at(-1)?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'grade', name: 'submit_evaluation', arguments: grade }], 'toolUse'));
    return response(reply([
      { type: 'thinking', thinking: 'PRIVATE-RUBRIC reference answer' },
      { type: 'text', text: 'PRIVATE-RUBRIC must not appear in task activity' },
    ]));
  } });
  try {
    const input = { kind: 'evaluation', revision: 0, specRevision: 1, q1: 'FIXED-ANSWER', q2: 'print(3)' }, key = randomUUID();
    const run = runtime.generate(space.id, unit, key, input);
    assert.equal(runtime.generate(space.id, unit, key, input).id, run.id);
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'failed'); assert.deepEqual(l.unit(space.id, unit).records, []);
    l.saveAssessmentDraft(space.id, unit, { revision: 0, q1: 'NEW-DRAFT', q2: 'new code' });
    fail = false; const retryKey = randomUUID(), retry = runtime.retryTask(space.id, run.id, retryKey);
    assert.equal(runtime.retryTask(space.id, run.id, retryKey).id, retry.id);
    await runtime.idle(retry.id); assert.equal(runtime.get(space.id, retry.id).state, 'succeeded');
    assert.doesNotMatch(JSON.stringify(runtime.events(space.id, retry.id)), /PRIVATE-RUBRIC/);
    assert.deepEqual(runtime.events(space.id, retry.id).events.flatMap((e) => e.data.type === 'reasoning' ? [e.data.phase] : []), ['start', 'end']);
    assert.equal(l.unit(space.id, unit).records.length, 1); assert.equal(l.unit(space.id, unit).records[0]!.attempt, 1);
    assert.equal(l.unit(space.id, unit).draft.q1, 'NEW-DRAFT'); assert.equal(l.unit(space.id, unit).nextAttempt, 2);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM submissions').get() as { n: number }).n, 1);
  } finally { await runtime.close(); db.close(); }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { JsonObject, Message } from '@earendil-works/pi-ai';
import type { QuestionAnswer, QuestionInput, QuestionRound, ResearchInput, RouteContent } from '@teach-me-coding/contracts';
import { SearchService } from '../extensions/search.js';
import type { WebFetchOptions } from '../extensions/web-fetch.js';
import { createApp } from '../http/app.js';
import { createLocalAccess } from '../http/local-access.js';
import { workspaceApi } from '../http/workspaces.js';
import { BusinessError, Learning } from '../modules/learning.js';
import { migrate, migrations, openDatabase } from '../storage/database.js';
import type { FrozenContext } from './context.js';
import { createIntakeTools } from './intake-tools.js';
import { TeachingRuntime } from './runtime.js';
import { reply, response, routeReply, syntheticSource } from './test-support.js';

const fields = { rows: [
  { question: '想完成什么？', answer: '用 Cedar 4.7.2 写一个流式账本解析器' },
  { question: '已经会什么？', answer: '会写循环，不会解析器组合' },
  { question: '想验证哪些成果？', answer: '处理三种损坏记录' },
  { question: '什么时候练习？', answer: '每周二 35 分钟' },
] };
const conceptFields = { rows: [
  { question: '想理解什么？', answer: '理解回溯搜索并构造反例' },
  { question: '已有经验？', answer: '会循环和递归' },
  { question: '如何检查理解？', answer: '解释有限状态树的不变量与剪枝条件' },
  { question: '练习时间？', answer: '周一 40 分钟' },
] };
const url = 'https://docs.cedar.example/4.7.2/parser';
const identityExcerpt = 'Cedar is a streaming parser toolkit.';
const versionExcerpt = 'Version 4.7.2 requires Node 24.';
const page = `${identityExcerpt}\n${versionExcerpt}\nWHOLE-PAGE-ONLY: unrelated deployment instructions must not be retained.`;
const questions: QuestionInput = { questions: [
  { prompt: '选择最终产物？', multiple: false, options: [
    { label: '可视化树', description: '浏览器交互' }, { label: '终端账本', description: '离线处理文件' }, { label: '证明笔记', description: '不写应用' },
  ] },
  { prompt: '什么时候练习？', multiple: false, options: [
    { label: '周末早晨', description: '连续 90 分钟' }, { label: '工作日晚间', description: '两次各 20 分钟' },
  ] },
  { prompt: '希望练哪些技能？', multiple: true, options: [
    { label: '反例', description: '找失败输入' }, { label: '性能计数', description: '比较状态数' },
    { label: '回溯', description: '撤销选择' }, { label: '可视化', description: '展示搜索过程' },
  ] },
] };

function setup() {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const space = learning.create({ name: '独立 intake fixture', goal: '开场目标不是结构化需求' });
  learning.saveRequirement(space.id, { revision: 0, value: conceptFields, confirmed: false, intake: { researchRef: null } });
  return { db, learning, spaceId: space.id,
    sessionId: space.sessions.find((s) => s.scope === 'intake')!.id,
    routeSession: space.sessions.find((s) => s.scope === 'route')!.id };
}
function call(name: string, args: JsonObject, id = name) {
  return response(reply([{ type: 'toolCall', id, name, arguments: args }], 'toolUse'));
}
const done = () => response(reply([{ type: 'text', text: '请核对，不代表已确认。' }]));
function submit(runtime: TeachingRuntime, space: string, session: string, text = '请核对这些真实需求') {
  return runtime.submit(space, session, randomUUID(), { text, quote: null, draftRevision: runtime.learning.session(space, session).draft.revision });
}
function frozen(learning: Learning, spaceId: string, sessionId: string): FrozenContext {
  const requirement = learning.space(spaceId).requirement;
  return { spaceId, sessionId, unitId: null, scenario: 'intake', requirement, route: null, unit: null, lesson: null, references: [],
    research: requirement.intake?.researchRef ? learning.intake.research(spaceId, requirement.intake.researchRef) : null };
}
function payload(messages: Message[], name: string, index = 0) {
  const result = messages.findLast((m) => m.role === 'toolResult' && m.toolName === name);
  assert.ok(result?.role === 'toolResult', `missing ${name} result`);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const block = result.content[index];
  assert.ok(block?.type === 'text');
  return JSON.parse(block.text);
}
function answer(round: QuestionRound): QuestionAnswer {
  const [one, custom, many] = round.questions;
  assert.ok(one && custom && many);
  // IDs are host-issued; expected labels/text below are independent of the saved round.
  return { answers: [
    { questionId: many.id, optionIds: [many.options[2]!.id, many.options[0]!.id], customText: '  实际输入 <保留 & 内容>  ' },
    { questionId: one.id, optionIds: [one.options[1]!.id], customText: '' },
    { questionId: custom.id, optionIds: [], customText: '  周三午休 17 分钟  ' },
  ] };
}
const answerText = '选择最终产物？\n终端账本\n\n什么时候练习？\n周三午休 17 分钟\n\n希望练哪些技能？\n回溯；反例；实际输入 <保留 & 内容>';
function status(code: BusinessError['status'], detail?: BusinessError['detail']) {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessError);
    assert.equal(error.status, code);
    if (detail) { assert.equal(error.message, detail.code); assert.deepEqual(error.detail, detail); }
    return true;
  };
}
function snapshot(learning: Learning) {
  return Object.fromEntries(['requirements', 'intake_questions', 'research_dossiers', 'sessions', 'messages', 'runs', 'agent_runs', 'requests', 'proposals']
    .map((table) => [table, learning.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function fetchFixture(onFetch?: () => void): WebFetchOptions {
  return { lookup: async (hostname) => {
    assert.equal(hostname, 'docs.cedar.example');
    return [{ address: '8.8.8.8', family: 4 }];
  }, fetch: async (address, options) => {
    assert.equal(address.href, url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    onFetch?.();
    return new Response(page, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } };
}
const researchContent = `\n# Cedar 4.7.2\n\nCedar 用来逐块解析流水账，本次使用 4.7.2，环境是 Node 24。\n\n先处理损坏记录，再比较内存占用。\n\n[官方资料](${url})\n`;
function research(content = researchContent): ResearchInput {
  return { content };
}
async function publishResearch(learning: Learning, space: string, session: string, content = researchContent, fetch = true) {
  let requests = 0, fetchedText = '';
  const runtime = new TeachingRuntime(learning, syntheticSource, { webFetch: fetchFixture(), stream: (_m, context) => {
    const step = ++requests + (fetch ? 0 : 1);
    if (step === 1) return call('web_fetch', { url, extractMode: 'text' });
    if (step === 2) {
      if (fetch) fetchedText = payload(context.messages, 'web_fetch').text;
      return call('write_research_document', research(content));
    }
    if (step === 3) return call('submit_requirement_draft', fields);
    return done();
  } });
  try {
    const { run } = submit(runtime, space, session);
    await runtime.idle(run.id);
    assert.equal(runtime.get(space, run.id).state, 'succeeded', JSON.stringify(runtime.get(space, run.id).error));
    const ref = learning.space(space).requirement.intake!.researchRef!;
    return { ref, runId: run.id, fetchedText, dossier: learning.intake.research(space, ref) };
  } finally { await runtime.close(); }
}
function route(): RouteContent {
  return { note: '先验证坏输入，再实现流式处理', stages: [{ id: randomUUID(), title: '解析边界', units: [
    { id: randomUUID(), title: '损坏记录', summary: '识别三种独立错误', goals: ['定位非法分隔符'] },
    { id: randomUUID(), title: '流式状态', summary: '分块时维持状态', goals: ['跨块保持未完成记录', '限制内存'] },
  ] }] };
}

test('draft and questions publish only on stop, bind R+1, reject forged answers and preserve actual custom text', async () => {
  const { db, learning, spaceId, sessionId, routeSession } = setup();
  const updated = { rows: [...conceptFields.rows.slice(0, 3), { question: '练习时间？', answer: '周三午休' }] };
  let requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
    if (++requests === 1) return response(reply([
      { type: 'toolCall', id: 'questions-first', name: 'ask_user_question', arguments: questions },
      { type: 'toolCall', id: 'draft-second', name: 'submit_requirement_draft', arguments: updated },
    ], 'toolUse'));
    if (requests === 2) {
      assert.equal(learning.space(spaceId).requirement.revision, 1);
      assert.deepEqual(learning.session(spaceId, sessionId).questions, []);
    }
    return done();
  } });
  try {
    const initial = submit(runtime, spaceId, sessionId);
    await runtime.idle(initial.run.id);
    assert.equal(runtime.get(spaceId, initial.run.id).state, 'succeeded');
    const saved = learning.space(spaceId).requirement;
    assert.deepEqual(saved.value, updated); assert.equal(saved.confirmed, false); assert.equal(saved.revision, 2);
    const round = learning.session(spaceId, sessionId).questions![0]!;
    assert.equal(round.runId, initial.run.id); assert.equal(round.sessionId, sessionId);
    assert.equal(round.generationRevision, 1); assert.equal(round.requirementRevision, 2); assert.equal(round.state, 'pending');
    assert.deepEqual(round.questions.map(({ id: _id, options, ...q }) => ({ ...q, options: options.map(({ id: _id, ...o }) => o) })), questions.questions);
    const ids = [round.id, ...round.questions.flatMap((q) => [q.id, ...q.options.map((o) => o.id)])];
    assert.equal(new Set(ids).size, 13); ids.forEach((id) => assert.match(id, /^[0-9a-f-]{36}$/));
    const api = workspaceApi(learning, undefined, runtime);
    const refreshed = await api.request(`/spaces/${spaceId}/sessions/${sessionId}`);
    assert.equal(refreshed.status, 200); assert.deepEqual((await refreshed.json()).questions, [round]);
    const valid = answer(round), before = snapshot(learning);
    const invalid: unknown[] = [
      { answers: valid.answers.slice(1) },
      { answers: [valid.answers[0], valid.answers[0], valid.answers[2]] },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, questionId: randomUUID() } : a) },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, optionIds: [randomUUID()] } : a) },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, optionIds: [round.questions[2]!.options[1]!.id] } : a) },
      { answers: valid.answers.map((a, i) => i === 0 ? { ...a, optionIds: [a.optionIds[0], a.optionIds[0]] } : a) },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, optionIds: round.questions[0]!.options.slice(0, 2).map((o) => o.id) } : a) },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, customText: '同时填自定义' } : a) },
      { answers: valid.answers.map((a, i) => i === 2 ? { ...a, optionIds: [], customText: '   ' } : a) },
      { answers: valid.answers.map((a, i) => i === 1 ? { ...a, label: '伪造客户端标签' } : a) },
    ];
    for (const raw of invalid) {
      assert.throws(() => runtime.answer(spaceId, sessionId, round.id, randomUUID(), raw));
      assert.deepEqual(snapshot(learning), before, 'invalid input must not accept answers, create messages/runs or consume a key');
    }
    assert.throws(() => learning.intake.acceptAnswer(spaceId, sessionId, round.id, 5, valid), status(409));
    assert.throws(() => runtime.answer(spaceId, sessionId, randomUUID(), randomUUID(), valid), status(404));
    assert.throws(() => runtime.answer(spaceId, routeSession, round.id, randomUUID(), valid), status(422));
    const otherSession = learning.createSession(spaceId, { scope: 'intake', unitId: null, title: '另一个需求会话' });
    assert.throws(() => runtime.answer(spaceId, otherSession.id, round.id, randomUUID(), valid), status(404));
    const other = learning.create({ name: '隔离空间', goal: '另一个目标' });
    assert.throws(() => runtime.answer(other.id, other.sessions[0]!.id, round.id, randomUUID(), valid), status(404));
    assert.throws(() => runtime.answer(other.id, sessionId, round.id, randomUUID(), valid), status(404));
    const accepted = runtime.answer(spaceId, sessionId, round.id, randomUUID(), valid);
    assert.equal(accepted.session.messages.filter((m) => m.role === 'user').at(-1)!.text, answerText);
    const expectedAnswers = [
      { questionId: round.questions[2]!.id, optionIds: [round.questions[2]!.options[2]!.id, round.questions[2]!.options[0]!.id], customText: '实际输入 <保留 & 内容>' },
      { questionId: round.questions[0]!.id, optionIds: [round.questions[0]!.options[1]!.id], customText: '' },
      { questionId: round.questions[1]!.id, optionIds: [], customText: '周三午休 17 分钟' },
    ];
    assert.deepEqual(accepted.session.questions![0]!.answers, expectedAnswers);
    assert.equal(accepted.session.questions![0]!.state, 'answered');
    await runtime.idle(accepted.run.id); assert.equal(runtime.get(spaceId, accepted.run.id).state, 'succeeded');
    assert.throws(() => runtime.answer(spaceId, sessionId, round.id, randomUUID(), valid), status(409));
    assert.equal(requests, 3);
  } finally { await runtime.close(); db.close(); }
});

test('answer receipt/message/run/key are atomic; failure and retry retain answers and a newer composer draft', async () => {
  const { db, learning, spaceId, sessionId } = setup();
  let phase: 'ask' | 'failure' | 'retry' = 'ask', requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
    requests++;
    if (phase === 'ask') return requests === 1 ? call('ask_user_question', questions) : done();
    return phase === 'failure' ? response(reply([], 'error')) : done();
  } });
  try {
    const asked = submit(runtime, spaceId, sessionId); await runtime.idle(asked.run.id);
    assert.equal(runtime.get(spaceId, asked.run.id).state, 'succeeded');
    const round = learning.session(spaceId, sessionId).questions![0]!, raw = answer(round);
    const composer = learning.saveSessionDraft(spaceId, sessionId, { ...learning.session(spaceId, sessionId).draft,
      text: '尚未发送的普通 composer', quote: { source: 'advice', label: '自己的笔记', text: '别清空引用' }, routeSuggestion: '每周先找反例' }).draft;
    for (const table of ['messages', 'agent_runs', 'requests']) {
      const before = snapshot(learning), key = randomUUID();
      db.exec(`CREATE TEMP TRIGGER fail_answer BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic answer storage fault'); END`);
      try {
        assert.throws(() => runtime.answer(spaceId, sessionId, round.id, key, raw), /synthetic answer storage fault/);
        assert.deepEqual(snapshot(learning), before, `rollback must undo every earlier write when ${table} fails`);
        assert.equal(db.prepare('SELECT 1 FROM requests WHERE key=?').get(key), undefined);
      } finally { db.exec('DROP TRIGGER fail_answer'); }
    }
    phase = 'failure';
    const key = randomUUID(), accepted = runtime.answer(spaceId, sessionId, round.id, key, raw);
    assert.equal(runtime.answer(spaceId, sessionId, round.id, key, raw).run.id, accepted.run.id);
    assert.deepEqual(learning.session(spaceId, sessionId).draft, composer);
    await runtime.idle(accepted.run.id); assert.equal(runtime.get(spaceId, accepted.run.id).state, 'failed');
    assert.equal(runtime.answer(spaceId, sessionId, round.id, key, raw).run.id, accepted.run.id);
    assert.throws(() => runtime.answer(spaceId, sessionId, round.id, key, { answers: raw.answers.slice(1) }), status(409, { code: 'IDEMPOTENCY_KEY_REUSED' }));
    assert.throws(() => runtime.answer(spaceId, sessionId, round.id, randomUUID(), raw), status(409));
    const newer = learning.saveSessionDraft(spaceId, sessionId, { ...composer, text: 'NEW-DRAFT <keep & untouched>', routeSuggestion: '不同的安排' }).draft;
    const answered = structuredClone(learning.session(spaceId, sessionId).questions![0]);
    assert.equal(answered!.state, 'answered');
    phase = 'retry';
    const retryKey = randomUUID(), retry = runtime.retry(spaceId, accepted.run.id, retryKey);
    assert.equal(runtime.retry(spaceId, accepted.run.id, retryKey).run.id, retry.run.id);
    await runtime.idle(retry.run.id); assert.equal(runtime.get(spaceId, retry.run.id).state, 'succeeded');
    const session = learning.session(spaceId, sessionId);
    assert.deepEqual(session.draft, newer); assert.deepEqual(session.questions, [answered]);
    assert.deepEqual(session.messages.filter((m) => m.role === 'user').map((m) => m.text), ['请核对这些真实需求', answerText]);
    assert.equal(learning.space(spaceId).runs.length, 3); assert.equal(requests, 4);
    const fixed = JSON.parse((db.prepare('SELECT input FROM agent_runs WHERE id=?').get(retry.run.id) as { input: string }).input);
    assert.equal(fixed.submitted.text, answerText); assert.equal(fixed.questions[0].state, 'answered');
  } finally { await runtime.close(); db.close(); }
});

test('cancel, length, changed requirement and publication failure never leak staged dossiers/drafts/questions', async (t) => {
  for (const mode of ['cancel', 'length', 'late-edit', 'question-storage-fault'] as const) await t.test(mode, async () => {
    const { db, learning, spaceId, sessionId } = setup();
    let requests = 0, entered!: () => void, release!: (stream: ReturnType<typeof response>) => void;
    let stagedResults: { name: string; isError: boolean }[] = [], publication: { revision: number; dossiers: number } | undefined;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<ReturnType<typeof response>>((resolve) => { release = resolve; });
    const runtime = new TeachingRuntime(learning, syntheticSource, { webFetch: fetchFixture(), stream: async (_m, context) => {
      if (++requests === 1) return call('web_fetch', { url });
      if (requests === 2) return call('write_research_document', research());
      if (requests === 3) return response(reply([
        { type: 'toolCall', id: 'stage-draft', name: 'submit_requirement_draft', arguments: fields },
        { type: 'toolCall', id: 'stage-question', name: 'ask_user_question', arguments: questions },
      ], 'toolUse'));
      stagedResults = context.messages.flatMap((m) => m.role === 'toolResult' ? [{ name: m.toolName, isError: m.isError }] : []);
      entered(); return held;
    } });
    try {
      const baseline = learning.space(spaceId).requirement;
      const { run } = submit(runtime, spaceId, sessionId); await ready;
      assert.equal(requests, 4); assert.deepEqual(learning.space(spaceId).requirement, baseline);
      assert.deepEqual(stagedResults, ['web_fetch', 'write_research_document', 'submit_requirement_draft', 'ask_user_question'].map((name) => ({ name, isError: false })));
      assert.deepEqual(learning.session(spaceId, sessionId).questions, []);
      assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 0);
      let expected = baseline;
      if (mode === 'cancel') runtime.stop(spaceId, run.id);
      if (mode === 'late-edit') expected = learning.saveRequirement(spaceId, { ...baseline, value: { rows: [...baseline.value.rows, { question: '新目标？', answer: '用户迟到但明确的新目标' }] } });
      if (mode === 'question-storage-fault') {
        db.function('observe_publication', (revision: number, dossiers: number) => {
          publication = { revision, dossiers };
          return 1;
        });
        db.exec(`CREATE TEMP TRIGGER fail_publication BEFORE INSERT ON intake_questions BEGIN
          SELECT observe_publication((SELECT revision FROM requirements), (SELECT COUNT(*) FROM research_dossiers));
          SELECT RAISE(ABORT,'synthetic publication fault'); END`);
      }
      release(response(reply([{ type: 'text', text: '迟到的模型结尾' }], mode === 'length' ? 'length' : 'stop')));
      await runtime.idle(run.id);
      assert.equal(runtime.get(spaceId, run.id).state, mode === 'cancel' ? 'interrupted' : 'failed');
      if (mode === 'length') assert.deepEqual(runtime.get(spaceId, run.id).error, { code: 'MODEL_OUTPUT_TRUNCATED' });
      if (mode === 'late-edit') assert.deepEqual(runtime.get(spaceId, run.id).error, { code: 'CONTENT_CHANGED' });
      if (mode === 'question-storage-fault') assert.deepEqual(publication, { revision: 2, dossiers: 1 }, 'the fault must occur after both earlier writes, not fail incidentally before publication');
      assert.deepEqual(learning.space(spaceId).requirement, expected);
      assert.deepEqual(learning.session(spaceId, sessionId).questions, []);
      assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 0, 'dossier insert must roll back even when the later question insert fails');
    } finally { release(done()); await runtime.close(); db.close(); }
  });
});

test('free-text clarification and manually edited summary supersede pending questions', async (t) => {
  for (const mode of ['free-text', 'summary'] as const) await t.test(mode, async () => {
    const { db, learning, spaceId, sessionId } = setup(); let requests = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => ++requests === 1 ? call('ask_user_question', questions) : done() });
    try {
      const asked = submit(runtime, spaceId, sessionId); await runtime.idle(asked.run.id);
      const round = learning.session(spaceId, sessionId).questions![0]!;
      if (mode === 'summary') {
        const current = learning.space(spaceId).requirement;
        learning.saveRequirement(spaceId, { ...current, value: { rows: [...current.value.rows, { question: '纠正基础？', answer: '用户纠正：没学过循环' }] } });
      } else {
        const next = submit(runtime, spaceId, sessionId, '不用账本了，只想证明搜索的完备性');
        assert.equal(next.session.questions![0]!.state, 'superseded'); await runtime.idle(next.run.id);
      }
      const stale = learning.session(spaceId, sessionId).questions![0]!;
      assert.equal(stale.state, 'superseded'); assert.equal(stale.answers, null);
      const before = snapshot(learning);
      assert.throws(() => runtime.answer(spaceId, sessionId, round.id, randomUUID(), answer(round)), status(409));
      assert.deepEqual(snapshot(learning), before);
    } finally { await runtime.close(); db.close(); }
  });
});

test('confirmation needs an answered row, not a fixed checklist, classification or mandatory research', async (t) => {
  for (const value of [{ rows: [] }, { rows: [{ question: '想做什么？', answer: '' }] }]) await t.test('no answered row', async () => {
    const { db, learning, spaceId } = setup();
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => { assert.fail('blocked planning must not ask a model'); } });
    try {
      learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, value });
      const current = learning.space(spaceId), before = snapshot(learning);
      assert.equal(current.readiness!.ready, false);
      assert.equal('reasons' in current.readiness!, false);
      assert.deepEqual(current.readiness!.issues, [{ code: 'REQUIREMENT_EMPTY' }]);
      assert.throws(() => learning.saveRequirement(spaceId, { ...current.requirement, confirmed: true }), status(422));
      assert.throws(() => runtime.plan(spaceId, randomUUID(), current.requirement), status(422));
      assert.deepEqual(snapshot(learning), before); assert.equal(current.route.content, null);
    } finally { await runtime.close(); db.close(); }
  });
  for (const value of [conceptFields, fields]) await t.test('no forced network or target object', async () => {
    const { db, learning, spaceId } = setup(); let network = 0;
    learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, value });
    const runtime = new TeachingRuntime(learning, syntheticSource, { webFetch: fetchFixture(() => { network++; }), stream: (_m, context) => {
      assert.doesNotMatch(JSON.stringify(context.messages.filter((m) => m.role === 'user')), /research-dossier/);
      return response(routeReply(context.messages, { note: '概念目标先理解不变量', stages: [{ title: '状态树', units: [
        { title: '撤销选择', summary: '保留不变量', goals: ['解释栈状态'] },
      ] }] }) ?? reply([{ type: 'text', text: '路线已整理' }]));
    } });
    try {
      const planned = runtime.plan(spaceId, randomUUID(), learning.space(spaceId).requirement); await runtime.idle(planned.run.id);
      assert.equal(runtime.get(spaceId, planned.run.id).state, 'succeeded', JSON.stringify(runtime.get(spaceId, planned.run.id).error));
      const result = learning.space(spaceId);
      assert.equal(result.requirement.confirmed, true); assert.equal(result.readiness!.ready, true);
      assert.deepEqual(result.requirement.value, value);
      assert.deepEqual(result.route.intake, { researchRef: null });
      assert.equal(result.route.content!.stages[0]!.units[0]!.title, '撤销选择'); assert.equal(network, 0);
    } finally { await runtime.close(); db.close(); }
  });
});

test('pending questions gate confirmation, route freeze, propose and apply without modifying route state', async () => {
  const { db, learning, spaceId, sessionId, routeSession } = setup(); let requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => ++requests === 1 ? call('ask_user_question', questions) : done() });
  try {
    learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, confirmed: true });
    const content = route(), asked = submit(runtime, spaceId, sessionId);
    // Already-running intake may finish while a route proposal enters review.
    const proposal = learning.proposeRoute(spaceId, routeSession, content);
    await runtime.idle(asked.run.id);
    assert.equal(runtime.get(spaceId, asked.run.id).state, 'succeeded');
    const before = snapshot(learning), current = learning.space(spaceId);
    assert.equal(current.requirement.confirmed, true); assert.equal(current.readiness!.ready, false);
    assert.throws(() => learning.saveRequirement(spaceId, { ...current.requirement, confirmed: true }), status(422, { code: 'INTAKE_QUESTIONS_PENDING' }));
    assert.throws(() => submit(runtime, spaceId, routeSession, '绕过 plan 入口'), status(409, { code: 'ROUTE_PROPOSAL_PENDING' }));
    assert.throws(() => learning.proposeRoute(spaceId, routeSession, content), status(422, { code: 'INTAKE_QUESTIONS_PENDING' }));
    assert.throws(() => learning.applyProposal(spaceId, proposal.id), status(422, { code: 'INTAKE_QUESTIONS_PENDING' }));
    assert.deepEqual(snapshot(learning), before); assert.equal(learning.space(spaceId).route.content, null); assert.equal(requests, 2);
    learning.rejectProposal(spaceId, proposal.id, {});
    assert.throws(() => submit(runtime, spaceId, routeSession, '拒绝提案后仍需回答问题'), status(422, { code: 'INTAKE_QUESTIONS_PENDING' }));
  } finally { await runtime.close(); db.close(); }
});

test('research writing only needs Markdown, accepts paraphrases and preserves content without source receipts', async () => {
  const { db, learning, spaceId, sessionId } = setup();
  learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, value: fields });
  const scene = createIntakeTools(learning, frozen(learning, spaceId, sessionId), randomUUID());
  const content = '\r\nCedar 可在 Node 24 中处理分块输入。无需与英文原文或 Markdown 符号一致。\r\n\r\n```ts\r\n  parse("a");\r\n```\r\n';
  let requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    if (++requests === 1) return call('write_research_document', research('先写一个尚未定稿的摘要。'));
    const staged = context.messages.at(-1);
    assert.ok(staged?.role === 'toolResult' && !staged.isError);
    assert.doesNotMatch(JSON.stringify(staged.content), /researchRef|sourceId|[0-9a-f]{8}-[0-9a-f-]{27}/);
    assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 0);
    return requests === 2 ? call('write_research_document', { content }) : done();
  } });
  try {
    const tool = scene.tools.find((t) => t.name === 'write_research_document')!;
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    assert.deepEqual(Object.keys(schema.properties), ['content']);
    assert.deepEqual(schema.required, ['content']);
    assert.doesNotMatch(JSON.stringify(scene.tools.find((t) => t.name === 'submit_requirement_draft')!.parameters), /researchRef|sourceId/);
    await assert.rejects(tool.execute('empty', { content: ' \n\t' }), /non-empty Markdown/);
    const { run } = submit(runtime, spaceId, sessionId);
    await runtime.idle(run.id);
    assert.equal(runtime.get(spaceId, run.id).state, 'succeeded', JSON.stringify(runtime.get(spaceId, run.id).error));
    const saved = learning.space(spaceId);
    assert.equal(saved.requirement.confirmed, false); assert.equal(saved.readiness!.ready, true);
    const dossier = learning.intake.research(spaceId, saved.requirement.intake!.researchRef!);
    assert.equal(dossier.content, content); assert.equal('target' in dossier, false);
    assert.equal(dossier.hash, createHash('sha256').update(content).digest('hex'));
    assert.equal(dossier.runId, run.id);
    assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 1, 'only the final staged document becomes a version');
  } finally { await runtime.close(); db.close(); }
});

test('Markdown research preserves route/lesson pins, source diagnostics and exact downloads without retaining whole fetched pages', async () => {
  const { db, learning, spaceId, sessionId, routeSession } = setup();
  // Missing config + no environment credentials: read-only, never creates a settings file.
  const search = new SearchService(new URL(`./.absent-search-${randomUUID()}.json`, import.meta.url).pathname, { env: () => undefined });
  let requests = 0, pages = 0, fetchedText = '';
  const runtime = new TeachingRuntime(learning, syntheticSource, { search, webFetch: fetchFixture(() => { pages++; }), stream: (_m, context) => {
    const system = context.messages.find((m) => m.role === 'system'); assert.ok(system?.role === 'system');
    assert.ok(system.toolsAdded?.some((tool) => tool.name === 'web_fetch'));
    assert.ok(!system.toolsAdded?.some((tool) => tool.name === 'web_search'));
    if (++requests === 1) return call('web_fetch', { url, extractMode: 'text' });
    if (requests === 2) {
      const fetched = payload(context.messages, 'web_fetch'); fetchedText = fetched.text;
      assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /researchSources|sourceId/);
      return call('write_research_document', research());
    }
    if (requests === 3) return call('submit_requirement_draft', fields);
    return done();
  } });
  let lessonRuntime: TeachingRuntime | undefined;
  try {
    assert.equal((await search.settings()).enabled, false);
    const { run } = submit(runtime, spaceId, sessionId); await runtime.idle(run.id);
    assert.equal(runtime.get(spaceId, run.id).state, 'succeeded', JSON.stringify(runtime.get(spaceId, run.id).error));
    assert.equal(pages, 1); assert.equal(requests, 4);
    const original = learning.space(spaceId).requirement.intake!.researchRef!, dossier = learning.intake.research(spaceId, original);
    assert.equal(original.revision, 1); assert.equal(dossier.content, researchContent);
    assert.doesNotMatch(JSON.stringify(dossier), /WHOLE-PAGE-ONLY|UNTRUSTED_WEB_CONTENT/);
    const confirmed = learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, confirmed: true });
    const scheduled = learning.saveRequirement(spaceId, { revision: confirmed.revision,
      value: { rows: [...confirmed.value.rows.slice(0, 3), { question: '什么时候练习？', answer: '周五 50 分钟，周日 10 分钟' }] }, confirmed: true });
    assert.deepEqual(scheduled.intake!.researchRef, original); assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 1);
    const content = route(), proposal = learning.proposeRoute(spaceId, routeSession, content);
    assert.deepEqual(proposal.intake, { researchRef: original });
    learning.applyProposal(spaceId, proposal.id);
    assert.deepEqual(learning.space(spaceId).route.intake, { researchRef: original });

    const updated = await publishResearch(learning, spaceId, sessionId, `${researchContent}\nREVISION-TWO-ONLY: 改为分块测试优先`, false);
    assert.deepEqual(updated.ref, { id: original.id, revision: 2 });
    learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, confirmed: true });
    assert.deepEqual(learning.intake.research(spaceId, original), dossier, 'old versions remain immutable');
    assert.deepEqual(learning.space(spaceId).route.intake!.researchRef, original);
    let lessonCalls = 0, lessonContext = '';
    lessonRuntime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      lessonContext = JSON.stringify(context);
      assert.match(lessonContext, /research-dossier/); assert.match(lessonContext, /先处理损坏记录/);
      assert.doesNotMatch(lessonContext, /REVISION-TWO-ONLY|WHOLE-PAGE-ONLY/);
      return ++lessonCalls === 1 ? call('submit_lesson', { title: '三种损坏记录', content: '依据路线固定的 Cedar 4.7.2\n\n## 分隔符边界\n\n对比合法与损坏记录。' }) : done();
    } });
    const unit = content.stages[0]!.units[0]!.id;
    const task = lessonRuntime.generate(spaceId, unit, randomUUID(), { kind: 'lesson', revision: 0 }); await lessonRuntime.idle(task.id);
    assert.equal(lessonRuntime.get(spaceId, task.id).state, 'succeeded', JSON.stringify(lessonRuntime.get(spaceId, task.id).error));
    assert.equal(learning.unit(spaceId, unit).lesson!.title, '三种损坏记录'); assert.equal(lessonCalls, 2);
    const fixed = JSON.parse((db.prepare('SELECT input FROM task_runs WHERE id=?').get(task.id) as { input: string }).input);
    assert.equal(fixed.research.id, original.id); assert.equal(fixed.research.revision, 1);
    assert.deepEqual(fixed.route.intake.researchRef, original); assert.deepEqual(fixed.requirement.intake.researchRef, updated.ref);
    const manifests = (db.prepare('SELECT value FROM task_manifests WHERE run_id=? ORDER BY request').all(task.id) as { value: string }[]).map((r) => JSON.parse(r.value));
    for (const manifest of manifests) assert.deepEqual(manifest.sources.find((s: { kind: string }) => s.kind === 'research-dossier'),
      { kind: 'research-dossier', id: original.id, revision: 1, hash: createHash('sha256').update(JSON.stringify(dossier)).digest('hex') });
    const intakeManifest = JSON.parse((db.prepare('SELECT value FROM context_manifests WHERE run_id=? AND request=4').get(run.id) as { value: string }).value);
    const source = intakeManifest.toolSources[0].sources[0];
    assert.equal(source.url, url); assert.equal(source.provider, 'web_fetch'); assert.equal(source.kind, 'web');
    assert.equal(source.hash, createHash('sha256').update(fetchedText).digest('hex'));
    assert.ok(!('id' in source)); assert.equal(intakeManifest.toolSources[0].retention, 'body omitted');
    for (const [table, column] of [['research_dossiers', 'value'], ['agent_messages', 'value'], ['context_manifests', 'value'], ['task_runs', 'input'], ['task_manifests', 'value']]) {
      assert.doesNotMatch(JSON.stringify(db.prepare(`SELECT ${column} FROM ${table}`).all()), /WHOLE-PAGE-ONLY|UNTRUSTED_WEB_CONTENT/, `${table} must not retain entire web pages`);
    }
    const api = workspaceApi(learning), path = `/spaces/${spaceId}/research/${original.id}/1`;
    const read = await api.request(path); assert.equal(read.status, 200); assert.deepEqual(await read.json(), dossier);
    const markdown = await api.request(`${path}?format=markdown`);
    assert.equal(markdown.status, 200); assert.match(markdown.headers.get('content-type')!, /^text\/markdown/);
    assert.equal(markdown.headers.get('content-disposition'), `attachment; filename="research-${original.id}-v1.md"`);
    const md = await markdown.text(); assert.equal(md, researchContent);
    assert.doesNotMatch(md, /WHOLE-PAGE-ONLY|REVISION-TWO-ONLY/);
    const other = learning.create({ name: '另一个 Cedar 空间', goal: '不能偷用资料' });
    assert.equal((await api.request(`/spaces/${other.id}/research/${original.id}/1`)).status, 404);
    assert.equal((await api.request(`/spaces/${spaceId}/research/${original.id}/99?format=markdown`)).status, 404);
    assert.throws(() => learning.saveRequirement(other.id, { revision: 0, value: fields, confirmed: true, intake: { researchRef: original } }), status(404));
  } finally { await Promise.all([runtime.close(), lessonRuntime?.close()]); search.close(); db.close(); }
});

test('the host associates documents with the whole table in either tool order and preserves references through rewording', async (t) => {
  for (const order of ['document-first', 'draft-first'] as const) await t.test(order, async () => {
    const { db, learning, spaceId, sessionId } = setup();
    let requests = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
      requests++;
      if (requests === (order === 'document-first' ? 1 : 2)) return call('write_research_document', research());
      if (requests === (order === 'draft-first' ? 1 : 2)) return call('submit_requirement_draft', fields);
      return done();
    } });
    try {
      const { run } = submit(runtime, spaceId, sessionId);
      await runtime.idle(run.id);
      assert.equal(runtime.get(spaceId, run.id).state, 'succeeded');
      const saved = learning.space(spaceId);
      assert.deepEqual(saved.requirement.value, fields);
      const ref = saved.requirement.intake!.researchRef!;
      assert.equal(learning.intake.research(spaceId, ref).content, researchContent);
      assert.equal(saved.readiness!.ready, true);
      assert.equal(requests, 3);
      const scene = createIntakeTools(learning, frozen(learning, spaceId, sessionId), randomUUID());
      const value = { rows: [...fields.rows.slice(1).reverse(), { question: '产物和版本？', answer: 'Cedar 4.7.2 的离线账本解析器' }] };
      await scene.tools.find((t) => t.name === 'submit_requirement_draft')!.execute('reworded-table', value);
      scene.commit();
      assert.deepEqual(learning.space(spaceId).requirement.value, value);
      assert.deepEqual(learning.space(spaceId).requirement.intake!.researchRef, ref);
      assert.equal(learning.space(spaceId).requirement.confirmed, false);
      assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 1);
    } finally { await runtime.close(); db.close(); }
  });
});

test('requirement tools accept arbitrary questions, incomplete answers and Markdown without row identities or classifications', async () => {
  const { db, learning, spaceId, sessionId } = setup();
  const scene = createIntakeTools(learning, frozen(learning, spaceId, sessionId), randomUUID());
  const tool = scene.tools.find((t) => t.name === 'submit_requirement_draft')!;
  const value = { rows: [
    { question: '为什么想学？', answer: '  改善自己的工具，不是为了考试。\r\n' },
    { question: '哪些还没想好？', answer: '' },
    { question: '喜欢怎样练习？', answer: '先用 `例子`，再解释 <边界 & 限制>。' },
  ] };
  try {
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    assert.deepEqual(Object.keys(schema.properties), ['rows']);
    assert.deepEqual(Object.keys(schema.properties.rows.items.properties), ['question', 'answer']);
    await tool.execute('table', value);
    assert.deepEqual(learning.space(spaceId).requirement.value, conceptFields, 'staging is not publication');
    scene.commit();
    const saved = learning.space(spaceId);
    assert.deepEqual(saved.requirement.value, value);
    assert.deepEqual(saved.requirement.intake, { researchRef: null });
    assert.equal(saved.requirement.confirmed, false);
    assert.equal(saved.readiness!.ready, true);
  } finally { db.close(); }
});

test('migration converts legacy fields to ordinary rows without changing confirmed routes or lesson history', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  migrate(db, migrations.slice(0, 8));
  const space = randomUUID(), session = randomUUID(), content = route(), unit = content.stages[0]!.units[0]!.id;
  const lesson = { title: '历史课件', content: '保持原文，不添加不存在的历史核验说明。' };
  const legacy = { goal: '  写一个流式账本解析器\r\n', background: '', outcome: '处理三种损坏记录\n', schedule: '   ' };
  db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(space, '历史学习空间', 17);
  db.prepare('INSERT INTO requirements(space_id,revision,confirmed,value) VALUES (?,3,1,?)').run(space, JSON.stringify(legacy));
  db.prepare('INSERT INTO routes(space_id,revision,content) VALUES (?,2,?)').run(space, JSON.stringify(content));
  for (const u of content.stages.flatMap((s) => s.units)) db.prepare('INSERT INTO units(space_id,id) VALUES (?,?)').run(space, u.id);
  db.prepare("INSERT INTO sessions(space_id,id,scope,unit_id,title) VALUES (?,?,'unit',?,'历史辅导')").run(space, session, unit);
  db.prepare('INSERT INTO lessons(space_id,unit_id,content) VALUES (?,?,?)').run(space, unit, JSON.stringify(lesson));
  db.prepare('INSERT INTO lesson_versions VALUES (?,?,1,?)').run(space, unit, JSON.stringify(lesson));
  migrate(db);
  const learning = new Learning(db);
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    assert.doesNotMatch(JSON.stringify(context), /research-dossier/);
    return done();
  } });
  try {
    const saved = learning.space(space);
    assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
    assert.deepEqual(saved.route, { revision: 2, content });
    assert.deepEqual(saved.requirement, { revision: 3, confirmed: true, value: { rows: [
      { question: '学习目标', answer: '  写一个流式账本解析器\r\n' }, { question: '期望达成', answer: '处理三种损坏记录\n' },
    ] } });
    assert.deepEqual(learning.unit(space, unit).lesson, { ...lesson, revision: 1 });
    assert.deepEqual(db.prepare('SELECT * FROM research_dossiers').all(), []);
    assert.equal(saved.readiness!.ready, true);
    const tutoring = submit(runtime, space, session, '继续讨论历史课件，不声称已核验技术。');
    await runtime.idle(tutoring.run.id);
    assert.equal(runtime.get(space, tutoring.run.id).state, 'succeeded');
    assert.deepEqual(learning.unit(space, unit).lesson, { ...lesson, revision: 1 });
  } finally { await runtime.close(); db.close(); }
});

test('manual Markdown saves are protected, atomic and idempotent; stale edits cannot change pinned documents', async () => {
  const { db, learning, spaceId, sessionId, routeSession } = setup();
  const access = createLocalAccess({ port: 14333 }), app = createApp(access, learning);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Content-Type': 'application/json' };
  const post = (path: string, input: unknown, extra = {}) => app.request(`/api${path}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID(), ...extra }, body: JSON.stringify(input),
  });
  try {
    const original = await publishResearch(learning, spaceId, sessionId, researchContent, false);
    learning.saveRequirement(spaceId, { ...learning.space(spaceId).requirement, confirmed: true });
    const proposal = learning.proposeRoute(spaceId, routeSession, route());
    const pinned = learning.applyProposal(spaceId, proposal.id).route;
    const baseline = learning.space(spaceId).requirement;
    const path = `/spaces/${spaceId}/research/${original.ref.id}/1`;
    const content = '\r\n# 人工补充\r\n\r\n保留原始空白与 <普通正文>。\r\n\r\n```ts\r\n  parse("中文");\r\n```\r\n  ';
    const other = learning.create({ name: '人工修改隔离空间', goal: '另一个目标' });
    const input = { content }, before = snapshot(learning);
    assert.equal((await post(path, input, { 'X-TMC-Token': '' })).status, 401);
    assert.equal((await post(path, input, { Origin: 'http://evil.test' })).status, 403);
    assert.equal((await post(path, input, { 'Idempotency-Key': '' })).status, 400);
    for (const invalid of [{}, { content: ' \t\r\n' }, { content: null }, { content: 3 }, { content, runId: original.runId }]) {
      assert.equal((await post(path, invalid)).status, 400);
    }
    assert.equal((await post(`/spaces/${other.id}/research/${original.ref.id}/1`, input)).status, 404);
    assert.equal((await post(`/spaces/${spaceId}/research/${original.ref.id}/99`, input)).status, 404);
    assert.deepEqual(snapshot(learning), before);

    // A later storage failure must undo the document, reference, confirmation and receipt together.
    for (const [table, operation] of [['requirements', 'UPDATE'], ['requests', 'INSERT']] as const) {
      const snapshotBefore = snapshot(learning);
      db.exec(`CREATE TEMP TRIGGER fail_manual_save BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'manual save storage fault'); END`);
      try {
        assert.equal((await post(path, input)).status, 503);
        assert.deepEqual(snapshot(learning), snapshotBefore);
      } finally { db.exec('DROP TRIGGER fail_manual_save'); }
    }
    const key = randomUUID(), saved = await post(path, input, { 'Idempotency-Key': key });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.document.revision, 2); assert.equal(result.document.runId, null);
    assert.equal(result.document.content, content);
    assert.equal(result.document.hash, createHash('sha256').update(content).digest('hex'));
    assert.equal('target' in result.document, false);
    assert.deepEqual(result.workspace.requirement, { ...baseline, revision: baseline.revision + 1, confirmed: false,
      intake: { researchRef: { id: original.ref.id, revision: 2 } } });
    assert.deepEqual(await (await post(path, input, { 'Idempotency-Key': key })).json(), result);
    assert.equal((await post(path, { content: '不同输入' }, { 'Idempotency-Key': key })).status, 409);
    assert.equal((await post(path, { content: '另一个窗口的旧稿' })).status, 409);
    assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 2);
    assert.deepEqual(learning.space(spaceId).route, pinned);
    assert.deepEqual(learning.intake.research(spaceId, original.ref), original.dossier);
    assert.equal(await (await app.request(`/api${path}?format=markdown`, { headers })).text(), researchContent);
    const current = learning.saveRequirement(spaceId, { ...result.workspace.requirement, confirmed: true });
    const noOp = await post(`/spaces/${spaceId}/research/${original.ref.id}/2`, input);
    assert.equal(noOp.status, 200); assert.deepEqual((await noOp.json()).workspace.requirement, current);
    assert.equal(db.prepare('SELECT * FROM research_dossiers').all().length, 2);
    assert.deepEqual(learning.space(other.id), other);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('migration 9 to 10 preserves agent document bytes and foreign keys while allowing manual provenance', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  migrate(db, migrations.slice(0, 9));
  const learning = new Learning(db), space = { id: randomUUID() }, session = randomUUID(), run = randomUUID();
  // Seed the old wire shape directly, without calling today's workspace reader
  // against tables that intentionally predate today's proposal schema.
  db.prepare('INSERT INTO spaces VALUES (?,?,0)').run(space.id, 'schema 9 Markdown');
  db.prepare('INSERT INTO requirements VALUES (?,0,0,?,NULL)').run(space.id, JSON.stringify(conceptFields));
  db.prepare('INSERT INTO routes VALUES (?,0,NULL,NULL)').run(space.id);
  db.prepare("INSERT INTO sessions(space_id,id,scope,title) VALUES (?,?,'intake','资料')").run(space.id, session);
  db.prepare("INSERT INTO runs VALUES (?,?,NULL,?,'intake','succeeded')").run(space.id, run, session);
  db.prepare("INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,'{}',0)").run(space.id, run);
  const ref = { id: randomUUID(), revision: 1 };
  const dossier = learning.intake.prepareResearch(ref, run, { content: '\n# 已有资料\n\n```ts\n  parse("b");\n```\n' });
  learning.intake.saveResearch(space.id, dossier);
  db.prepare('UPDATE requirements SET intake=? WHERE space_id=?').run(JSON.stringify({ researchRef: ref }), space.id);
  try {
    const before = snapshot(learning);
    migrate(db, migrations.slice(0, 10));
    assert.equal(db.pragma('user_version', { simple: true }), 10);
    assert.deepEqual(snapshot(learning), before);
    assert.deepEqual(learning.intake.research(space.id, ref), dossier);
    migrate(db);
    const manual = learning.saveResearch(space.id, ref, { content: '# 用户的新资料\n\n手动说明。\n' });
    assert.equal(manual.document.runId, null); assert.equal(manual.document.revision, 2);
    assert.deepEqual(db.prepare('SELECT run_id FROM research_dossiers ORDER BY revision').all(), [{ run_id: run }, { run_id: null }]);
    const invalid = learning.intake.prepareResearch({ id: ref.id, revision: 3 }, randomUUID(), research());
    assert.throws(() => learning.intake.saveResearch(space.id, invalid), /FOREIGN KEY/);
    assert.throws(() => learning.intake.saveResearch(randomUUID(), { ...invalid, runId: null }), /FOREIGN KEY/);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

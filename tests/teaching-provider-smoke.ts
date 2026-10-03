// Explicit paid smoke command, never imported by deterministic tests. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeachingRuntime } from '../apps/server/src/agents/runtime.js';
import { loadModelConfig } from '../apps/server/src/config/model.js';
import { openDatabase } from '../apps/server/src/storage/database.js';
import { Learning } from '../apps/server/src/modules/learning.js';

const root = mkdtempSync(join(tmpdir(), 'tmc-real-teaching-'));
const db = openDatabase(join(root, 'app.db')), learning = new Learning(db), config = loadModelConfig();
const runtime = new TeachingRuntime(learning, config, { projectDirectory: () => root });
const space = learning.create({ name: '合成教学验证', goal: '学习 Python 函数参数' });
const ask = async (session: string, text: string) => {
  const { run } = runtime.submit(space.id, session, randomUUID(), { text, quote: null, draftRevision: learning.session(space.id, session).draft.revision });
  await runtime.idle(run.id);
  const final = runtime.get(space.id, run.id);
  const display = learning.session(space.id, session).messages.find((message) => message.id === run.id)!;
  const reasoningCharacters = display.parts?.reduce((sum, part) => sum + (part.type === 'reasoning' ? part.text.length : 0), 0) ?? 0;
  assert.ok(reasoningCharacters > 0, 'High reasoning must actually reach durable display parts');
  console.log(JSON.stringify({ scenario: run.kind, state: final.state, error: final.error,
    reasoningCharacters, reply: display.text }));
  assert.equal(final.state, 'succeeded');
};
try {
  console.log(JSON.stringify({ model: config.model, data: 'synthetic disposable', execution: 'disabled' }));
  await ask(space.sessions[0]!.id, '我会 Python 的变量、if 和循环，想弄懂函数默认参数，能自己写一个问候函数。什么时候学还没决定，时间先留空。');
  let w = learning.space(space.id);
  assert.ok(w.requirement.revision > 0); assert.equal(w.requirement.confirmed, false);
  assert.equal(w.requirement.value.schedule, '', 'Do not invent a schedule when the user has not chosen one');
  console.log(JSON.stringify({ requirement: w.requirement.value }));
  await ask(space.sessions[0]!.id, '今天有 30 分钟，就学前面说的默认参数，先安排一个短单元就好。');
  w = learning.space(space.id);
  assert.equal(w.requirement.confirmed, false);
  assert.match(w.requirement.value.schedule, /30|三十/);
  assert.match(w.requirement.value.background, /变量/);
  assert.match(w.requirement.value.outcome, /问候/);
  console.log(JSON.stringify({ requirement: w.requirement.value }));
  const planned = runtime.plan(space.id, randomUUID(), { ...w.requirement, confirmed: true });
  await runtime.idle(planned.run.id);
  const plannedFinal = runtime.get(space.id, planned.run.id);
  console.log(JSON.stringify({ scenario: 'initial-roadmap', state: plannedFinal.state, error: plannedFinal.error,
    reply: learning.session(space.id, planned.run.sessionId!).messages.find((message) => message.id === planned.run.id)?.text }));
  assert.equal(plannedFinal.state, 'succeeded');
  w = learning.space(space.id); assert.ok(w.route.content); assert.equal(w.proposals.at(-1)!.state, 'applied');
  assert.equal(w.route.revision, 1); assert.equal(w.tasks.length, 0);
  console.log(JSON.stringify({ route: w.route.content }));
  assert.equal(w.route.content.stages.flatMap((stage) => stage.units).length, 1, 'Respect the requested one-unit scope');
  await ask(space.sessions[1]!.id, '只改路线说明，在开头加上“先预测，再验证。”，保留现有阶段、单元和其他内容。');
  const adjustment = learning.space(space.id);
  assert.deepEqual(adjustment.route, w.route, 'An adjustment must not replace the route before approval');
  assert.equal(adjustment.proposals.at(-1)!.state, 'pending');
  assert.match(adjustment.proposals.at(-1)!.content.note, /先预测，再验证/);
  assert.deepEqual(adjustment.proposals.at(-1)!.content.stages, w.route.content.stages);
  const unit = learning.space(space.id).route.content!.stages[0]!.units[0]!.id;
  const lesson = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 0 }); await runtime.idle(lesson.id);
  const final = runtime.get(space.id, lesson.id); console.log(JSON.stringify({ scenario: 'lesson', state: final.state, error: final.error }));
  assert.equal(final.state, 'succeeded'); assert.ok(learning.unit(space.id, unit).lesson?.blocks?.length);
  writeFileSync(join(root, 'sample.py'), 'def greet(name="Ada"):\n    return "Hi " + name\n');
  const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: '合成辅导' });
  await ask(session.id, '只读取当前目录合成的 sample.py，说明无参数和传入 Lin 时返回值的区别，勿读取其他文件。不运行代码。提交一条关于默认参数的待采纳学习结论。');
  assert.ok(learning.conclusions(space.id).length);
  const reads = (db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE json_extract(value,'$.role')='toolResult' AND json_extract(value,'$.toolName')='read' AND json_extract(value,'$.isError')=0").get() as { n: number }).n;
  assert.ok(reads > 0, 'Real tutor completed a read, not just a claim in its reply');
  const questions = runtime.generate(space.id, unit, randomUUID(), { kind: 'assessment', revision: 0 });
  await runtime.idle(questions.id);
  const questionsFinal = runtime.get(space.id, questions.id);
  console.log(JSON.stringify({ scenario: 'assessment', state: questionsFinal.state, error: questionsFinal.error }));
  assert.equal(questionsFinal.state, 'succeeded');
  const spec = learning.unit(space.id, unit).assessment!;
  assert.equal(spec.revision, 1);
  const evaluation = runtime.generate(space.id, unit, randomUUID(), { kind: 'evaluation', revision: 0, specRevision: spec.revision,
    q1: '默认参数在调用时缺省实参时使用；显式传参会覆盖默认值。这里没传 name 时使用 Ada，传入 Lin 时使用 Lin。',
    q2: 'def greet(name="Ada"):\n    return "Hi " + name\n' });
  learning.saveAssessmentDraft(space.id, unit, { revision: 0, q1: '评估期间新草稿，不属于提交', q2: 'new draft' });
  await runtime.idle(evaluation.id);
  const evaluationFinal = runtime.get(space.id, evaluation.id);
  console.log(JSON.stringify({ scenario: 'evaluation', state: evaluationFinal.state, error: evaluationFinal.error }));
  assert.equal(evaluationFinal.state, 'succeeded');
  const record = learning.unit(space.id, unit).records[0]!;
  if (spec.q2Kind === 'code') { assert.equal(record.result, 'unverified'); assert.equal(record.valid, false); }
  assert.equal(learning.unit(space.id, unit).draft.q1, '评估期间新草稿，不属于提交');
  console.log(JSON.stringify({ q2Kind: spec.q2Kind, result: record.result, verification: record.verification, attempt: record.attempt }));
  console.log(JSON.stringify({ requests: (db.prepare('SELECT COUNT(*) AS n FROM context_manifests').get() as { n: number }).n,
    taskRequests: (db.prepare('SELECT COUNT(*) AS n FROM task_manifests').get() as { n: number }).n,
    lessonBlocks: learning.unit(space.id, unit).lesson!.blocks!.length, conclusions: learning.conclusions(space.id).length, reads }));
} finally { await runtime.close(); db.close(); rmSync(root, { recursive: true, force: true }); }

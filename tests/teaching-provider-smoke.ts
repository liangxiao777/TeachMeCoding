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
  console.log(JSON.stringify({ scenario: run.kind, state: final.state, error: final.error }));
  assert.equal(final.state, 'succeeded');
};
try {
  console.log(JSON.stringify({ model: config.model, data: 'synthetic disposable', execution: 'disabled' }));
  await ask(space.sessions[0]!.id, '我的目标是学习 Python 函数参数；基础是会变量、if 和循环；成果是写一个带默认参数的问候函数；时间为今天 30 分钟。四项已给全，请调用工具整理需求草稿。');
  let w = learning.space(space.id);
  assert.ok(w.requirement.revision > 0); assert.equal(w.requirement.confirmed, false);
  learning.saveRequirement(space.id, { ...w.requirement, confirmed: true });
  await ask(space.sessions[1]!.id, '请生成只含一个阶段和一个简短单元的路线，聚焦默认参数，调用路线提案工具。');
  w = learning.space(space.id); assert.equal(w.route.content, null); assert.ok(w.proposals.length > 0);
  learning.applyProposal(space.id, w.proposals.at(-1)!.id);
  const unit = learning.space(space.id).route.content!.stages[0]!.units[0]!.id;
  const lesson = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 0 }); await runtime.idle(lesson.id);
  const final = runtime.get(space.id, lesson.id); console.log(JSON.stringify({ scenario: 'lesson', state: final.state, error: final.error }));
  assert.equal(final.state, 'succeeded'); assert.ok(learning.unit(space.id, unit).lesson?.blocks?.length);
  writeFileSync(join(root, 'sample.py'), 'def greet(name="Ada"):\n    return "Hi " + name\n');
  const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: '合成辅导' });
  await ask(session.id, '只读取当前目录合成的 sample.py，说明无参数和传入 Lin 时返回值的区别，勿读取其他文件。不运行代码。提交一条关于默认参数的待采纳学习结论。');
  assert.ok(learning.conclusions(space.id).length);
  console.log(JSON.stringify({ requests: (db.prepare('SELECT COUNT(*) AS n FROM context_manifests').get() as { n: number }).n,
    taskRequests: (db.prepare('SELECT COUNT(*) AS n FROM task_manifests').get() as { n: number }).n,
    lessonBlocks: learning.unit(space.id, unit).lesson!.blocks!.length, conclusions: learning.conclusions(space.id).length }));
} finally { await runtime.close(); db.close(); rmSync(root, { recursive: true, force: true }); }

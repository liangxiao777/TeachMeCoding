import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDataDirectory } from '../storage/data-directory.js';
import { Learning } from './learning.js';
import { Assessments } from './assessments.js';
import { Executions } from './executions.js';
import { populated, reply, response, syntheticSource } from '../agents/test-support.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { executionFeedback, type CodePlan } from '@teach-me-coding/contracts';

const grade = { result: 'pass', summary: '本次全部符合要求', mastered: ['求和'], concerns: [], evidence: ['答案使用累加'], toVerify: [] };
const defaultPlan: CodePlan = { language: 'javascript', cases: [{ args: ['3', '8'], expected: '11' }, { args: [], expected: '0' }] };
function fixture(plan = defaultPlan, limits = { milliseconds: 3000, outputBytes: 4096 }) {
  const root = mkdtempSync(join(tmpdir(), 'tmc-code-test-')), data = openDataDirectory(root), l = new Learning(data.db);
  const { space, units } = populated(l), unit = units[0]!.id, a = new Assessments(l), executions = new Executions(l, limits);
  l.saveLesson(space.id, unit, { title: '求和', content: '公开材料' });
  a.saveSpec(space.id, unit, { public: { q1: '解释求和', q2: '输出参数和', q2Kind: 'code', starter: '', execution: plan },
    rubric: { q1: { answer: '累加', criteria: ['说明过程'] }, q2: { answer: 'PRIVATE', criteria: ['边界正确'] } } },
  { requirement: space.requirement.revision, route: space.route.revision, lesson: 1 }, 0);
  return { root, data, l, a, space: space.id, unit, executions, async close() { await executions.close(); data.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('fixed real submission survives new drafts and failed-model retry without repeating code', async () => {
  const f = fixture(), marker = join(f.root, 'count'); let fail = true, requestText = '';
  const runtime = new TeachingRuntime(f.l, syntheticSource, { executions: f.executions, stream: (_m, context) => {
    requestText = JSON.stringify(context);
    if (fail) return response(reply([], 'error'));
    return response(context.messages.at(-1)?.role === 'toolResult' ? reply([{ type: 'text', text: 'done' }]) : reply([{ type: 'toolCall', id: 'grade', name: 'submit_evaluation', arguments: grade }], 'toolUse'));
  } });
  try {
    const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n'); console.log(process.argv.slice(2).reduce((a,v)=>a+Number(v),0));`;
    const input = { kind: 'evaluation', revision: 0, specRevision: 1, q1: '固定解释', q2: code, execute: true }, key = randomUUID();
    const run = runtime.generate(f.space, f.unit, key, input);
    assert.equal(runtime.generate(f.space, f.unit, key, input).id, run.id);
    f.l.saveAssessmentDraft(f.space, f.unit, { revision: 0, q1: 'NEW-DRAFT', q2: 'new code not executed' });
    await runtime.idle(run.id);
    assert.equal(runtime.get(f.space, run.id).state, 'failed'); assert.equal(f.l.unit(f.space, f.unit).records.length, 0);
    assert.equal(readFileSync(marker, 'utf8'), 'once\nonce\n'); // One execution per public case.
    assert.doesNotMatch(requestText, /NEW-DRAFT|new code not executed/); assert.match(requestText, /stdout/);
    fail = false;
    const retry = runtime.retryTask(f.space, run.id, randomUUID()); await runtime.idle(retry.id);
    const result = f.l.unit(f.space, f.unit).records[0]!;
    assert.equal(result.result, 'pass'); assert.equal(result.verification, 'execution-verified'); assert.equal(result.valid, true);
    assert.equal(result.summary, '本次作答符合题目要求。');
    const stored = f.data.db.prepare('SELECT result FROM assessments WHERE id=?').get(result.id) as { result: string };
    assert.equal(JSON.parse(stored.result).summary, '本次作答符合题目要求。');
    assert.deepEqual(result.evidence, ['答案使用累加']); assert.deepEqual(result.concerns, []); assert.deepEqual(result.toVerify, []);
    assert.match(executionFeedback(result.execution!).summary, /2 项运行检查/);
    assert.equal(executionFeedback(result.execution!).nextStep, undefined);
    assert.equal(result.answers.q2, code); assert.equal(result.execution?.submissionId, result.id);
    assert.deepEqual(result.execution?.results.map((r) => r.result.stdout), ['11\n', '0\n']);
    assert.equal(f.l.unit(f.space, f.unit).draft.q2, 'new code not executed');
    assert.equal(readFileSync(marker, 'utf8'), 'once\nonce\n'); assert.equal(f.executions.list(f.space, f.unit).length, 1);
    f.l.saveLesson(f.space, f.unit, { title: '新课件', content: 'changed' });
    assert.equal(f.l.unit(f.space, f.unit).records[0]!.valid, false);
    assert.notEqual(f.l.unit(f.space, f.unit).status, 'passed');
  } finally { await runtime.close(); await f.close(); }
});

test('installed language toolchains execute complete programs and compiler errors stay unverified', async () => {
  const programs = {
    python: 'import sys\nprint(sum(int(x) for x in sys.argv[1:]))',
    typescript: 'const sum: number = process.argv.slice(2).reduce((a,v)=>a+Number(v),0); console.log(sum);',
    rust: 'fn main() { let sum: i32 = std::env::args().skip(1).map(|x| x.parse::<i32>().unwrap()).sum(); println!("{}", sum); }',
    bash: 'sum=0; for arg in "$@"; do sum=$((sum + arg)); done; printf "%s\\n" "$sum"',
  } as const;
  for (const language of Object.keys(programs) as (keyof typeof programs)[]) {
    const f = fixture({ ...defaultPlan, language }, { milliseconds: 10000, outputBytes: 4096 });
    try {
      const execution = f.executions.create(f.space, f.unit, { specRevision: 1, code: programs[language] });
      const result = await f.executions.run(f.space, execution.id);
      assert.deepEqual(result.results.map((r) => r.matches), [true, true], JSON.stringify(result));
      if (language === 'rust') {
        const code = 'fn main() { let bad: u32 = "not a number"; }';
        const fixed = f.a.submit(f.space, f.unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '解释', q2: code });
        const e = f.executions.create(f.space, f.unit, { specRevision: 1, code }, fixed.submission.id);
        fixed.submission.evidence = { kind: 'local', execution: await f.executions.run(f.space, e.id) };
        const record = f.a.grade(f.space, f.unit, fixed, grade);
        assert.equal(record.result, 'unverified');
        assert.match(record.execution!.results[0]!.result.stderr!, /mismatched types/);
      }
    } finally { await f.close(); }
  }
});

test('wrong output, syntax failure, missing tools, timeout and output limit cannot award a pass', async () => {
  for (const [code, expected, status, reason] of [
    ['console.log(11)', 'needs_work', 'succeeded', '有 1 项检查的输出与题目要求不一致。'],
    ['syntax error !', 'unverified', 'failed', '程序报错'],
    ['while(true) {}', 'unverified', 'timed-out', '超过运行时限'],
    ['console.log("x".repeat(10000))', 'unverified', 'output-limit', '输出过多'],
  ] as const) {
    const f = fixture(defaultPlan, { milliseconds: 600, outputBytes: 1024 });
    try {
      const fixed = f.a.submit(f.space, f.unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '解释', q2: code });
      const e = f.executions.create(f.space, f.unit, { specRevision: 1, code }, fixed.submission.id);
      fixed.submission.evidence = { kind: 'local', execution: await f.executions.run(f.space, e.id) };
      const result = f.a.grade(f.space, f.unit, fixed, grade);
      assert.equal(result.result, expected); assert.deepEqual(result.mastered, []);
      assert.ok(result.summary.includes(reason), result.summary);
      assert.doesNotMatch(result.summary, /全部符合要求/);
      assert.deepEqual(result.evidence, []); assert.deepEqual(result.concerns, []); assert.deepEqual(result.toVerify, []);
      assert.ok(executionFeedback(result.execution!).nextStep);
      assert.equal(result.execution?.results[0]?.result.status, status);
      assert.notEqual(f.l.unit(f.space, f.unit).status, 'passed');
      const swapped = f.a.submit(f.space, f.unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '另一次', q2: code });
      swapped.submission.evidence = fixed.submission.evidence;
      assert.equal(f.a.grade(f.space, f.unit, swapped, grade).result, 'unverified');
    } finally { await f.close(); }
  }
  const f = fixture(), path = process.env.PATH;
  try {
    process.env.PATH = '/tmc-no-toolchain';
    const code = 'console.log(11)', fixed = f.a.submit(f.space, f.unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '解释', q2: code });
    const e = f.executions.create(f.space, f.unit, { specRevision: 1, code }, fixed.submission.id);
    fixed.submission.evidence = { kind: 'local', execution: await f.executions.run(f.space, e.id) };
    const result = f.a.grade(f.space, f.unit, fixed, grade);
    assert.equal(result.result, 'unverified'); assert.match(result.summary, /本机缺少/);
    assert.doesNotMatch(result.summary, /程序报错|全部符合要求/);
    assert.match(executionFeedback(result.execution!).nextStep!, /不会自动安装/);
    assert.equal(f.executions.get(f.space, e.id).results[0]!.result.status, 'unavailable');
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; await f.close(); }
});

test('legacy feedback hides host diagnostics without rewriting evidence or erasing legitimate hash-related answers', async () => {
  const f = fixture();
  try {
    const code = 'console.log(11)', fixed = f.a.submit(f.space, f.unit, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '解释', q2: code });
    const e = f.executions.create(f.space, f.unit, { specRevision: 1, code }, fixed.submission.id);
    fixed.submission.evidence = { kind: 'local', execution: await f.executions.run(f.space, e.id) };
    const feedback = { ...grade, result: 'needs_work', summary: '代码固定输出 11，没有计算输入。',
      evidence: ['你写的 console.log(11) 不会随输入变化。'], concerns: ['读取输入，计算总和后再输出。'] };
    const record = f.a.grade(f.space, f.unit, fixed, feedback), execution = record.execution!;
    assert.equal(record.summary, feedback.summary); assert.deepEqual(record.evidence, feedback.evidence); assert.deepEqual(record.concerns, feedback.concerns);
    const diagnostic = `执行 ${execution.id}，代码 SHA-256 ${execution.codeHash}；succeeded，匹配 1/2 个公开用例。`;
    const stored = JSON.stringify({ ...record, summary: '实际输出与测试期望不符。本次全部符合要求',
      evidence: [diagnostic, '你解释了 SHA-256 如何检查文件内容变化。'], toVerify: ['需要完整的真实执行证据；缺工具链请自行配置，不自动安装。'] });
    f.data.db.prepare('UPDATE assessments SET result=? WHERE id=?').run(stored, record.id);
    const shown = f.l.record(f.space, record.id);
    assert.deepEqual(shown.evidence, ['你解释了 SHA-256 如何检查文件内容变化。']);
    assert.deepEqual(shown.toVerify, []); assert.equal(shown.summary, '有 1 项检查的输出与题目要求不一致。');
    assert.deepEqual(shown.execution, execution); assert.equal(shown.valid, true); assert.equal(shown.result, 'needs_work');
    assert.equal((f.data.db.prepare('SELECT result FROM assessments WHERE id=?').get(record.id) as { result: string }).result, stored);
  } finally { await f.close(); }
});

test('each case uses original source, quoted args stay data, and temporary directories are removed', async () => {
  const arg = "a'; touch injected; printf 'b";
  const f = fixture({ language: 'javascript', cases: [{ args: [arg], expected: arg }, { args: ['second'], expected: 'second' }] });
  try {
    const code = `console.log(process.argv[2]); console.error(process.cwd()); require('node:fs').writeFileSync('answer.js', 'throw new Error("modified")');`;
    const e = f.executions.create(f.space, f.unit, { specRevision: 1, code });
    const completed = await f.executions.run(f.space, e.id);
    assert.deepEqual(completed.results.map((r) => r.matches), [true, true]);
    for (const r of completed.results) { assert.ok(r.result.stderr?.includes('tmc-code-')); assert.equal(existsSync(r.result.stderr!.trim()), false); }
    assert.notEqual(completed.results[0]!.result.stderr, completed.results[1]!.result.stderr);
    assert.deepEqual(await f.executions.run(f.space, e.id), completed);
    assert.throws(() => f.executions.create(f.space, f.unit, { specRevision: 2, code }), /版本/);
  } finally { await f.close(); }
});

test('limits apply across cases and setup failure leaves explicit failed evidence without execution', async () => {
  const plan: CodePlan = { language: 'javascript', cases: [{ args: [], expected: 'abcd' }, { args: [], expected: 'abcd' }] };
  const f = fixture(plan, { milliseconds: 3000, outputBytes: 4 });
  const marker = join(f.root, 'once');
  try {
    const code = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'X'); process.stdout.write('abcd');`;
    const e = f.executions.create(f.space, f.unit, { specRevision: 1, code });
    const result = await f.executions.run(f.space, e.id);
    assert.deepEqual(result.results.map((r) => r.result.status), ['succeeded', 'output-limit']);
    assert.equal(readFileSync(marker, 'utf8'), 'X');
    assert.equal(result.state, 'failed');
    const original = process.env.TMPDIR;
    try {
      process.env.TMPDIR = join(f.root, 'absent');
      const missing = f.executions.create(f.space, f.unit, { specRevision: 1, code });
      const failed = await f.executions.run(f.space, missing.id);
      assert.equal(failed.state, 'failed'); assert.match(failed.error!, /临时目录权限/);
      assert.equal(failed.results.length, 0); assert.equal(readFileSync(marker, 'utf8'), 'X');
    } finally { if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original; }
  } finally { await f.close(); }
});

test('cancellation before launch and during code execution is durable; retries and reboot do not execute it again', async () => {
  const f = fixture();
  let requests = 0;
  const runtime = new TeachingRuntime(f.l, syntheticSource, { executions: f.executions, stream: (_m, context) => {
    requests++; return response(context.messages.at(-1)?.role === 'toolResult' ? reply([]) : reply([{ type: 'toolCall', id: 'grade', name: 'submit_evaluation', arguments: grade }], 'toolUse'));
  } });
  try {
    const input = { kind: 'evaluation', revision: 0, specRevision: 1, q1: '解释', q2: 'while(true) {}', execute: true };
    const early = runtime.generate(f.space, f.unit, randomUUID(), input); runtime.stop(f.space, early.id); await runtime.idle(early.id);
    assert.equal(requests, 0); assert.equal(f.executions.list(f.space, f.unit)[0]!.state, 'interrupted');
    const retry = runtime.retryTask(f.space, early.id, randomUUID()); await runtime.idle(retry.id);
    assert.equal(f.l.unit(f.space, f.unit).records[0]!.result, 'unverified');
    assert.match(f.l.unit(f.space, f.unit).records[0]!.summary, /运行已停止/);
    const active = runtime.generate(f.space, f.unit, randomUUID(), input);
    await new Promise((r) => setTimeout(r, 150)); runtime.stop(f.space, active.id); await runtime.idle(active.id);
    assert.equal(runtime.get(f.space, active.id).state, 'interrupted');
    const execution = f.executions.list(f.space, f.unit).at(-1)!;
    assert.equal(execution.state, 'interrupted'); assert.equal(execution.results[0]!.result.status, 'cancelled');
    const pending = f.executions.create(f.space, f.unit, { specRevision: 1, code: 'console.log(11)' });
    await runtime.close(); await f.executions.close(); f.data.close();
    const reopened = openDataDirectory(f.root);
    try {
      const recovered = new Executions(new Learning(reopened.db));
      assert.equal((await recovered.run(f.space, pending.id)).state, 'interrupted');
      assert.equal(recovered.get(f.space, pending.id).results.length, 0);
    } finally { reopened.close(); }
  } finally { await runtime.close(); await f.close(); }
});

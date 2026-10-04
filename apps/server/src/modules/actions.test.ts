import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDataDirectory } from '../storage/data-directory.js';
import { Learning } from './learning.js';
import { Projects } from './projects.js';
import { Actions } from './actions.js';
import { populated, reply, response, syntheticSource } from '../agents/test-support.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { runCommand } from '../runtime/commands.js';

test('immutable proposals require confirmation, fence stale files, and never replay competing decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-actions-')), data = openDataDirectory(root);
  const learning = new Learning(data.db), projects = new Projects(root), actions = new Actions(learning, projects);
  const { space, units } = populated(learning);
  const session = learning.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'Actions' }).id;
  const run = randomUUID();
  data.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,'succeeded')").run(space.id, run, units[0]!.id, session, 'tutor');
  const file = (content: string) => actions.prepare(space.id, session, run, 'file', { path: 'sample.txt', content, reason: 'Test' });
  const command = (command: string) => actions.prepare(space.id, session, run, 'command', { command, reason: 'Test' });
  const decide = (p: ReturnType<typeof file>, decision: 'confirm' | 'reject' | 'cancel') => actions.decide(space.id, p.id, { digest: p.digest, decision });
  try {
    const p = file('first'); actions.save(space.id, p);
    assert.equal(existsSync(join(projects.root(space.id), 'sample.txt')), false);
    assert.throws(() => actions.decide(space.id, p.id, { digest: 'different', decision: 'confirm' }), /不匹配/);
    decide(p, 'reject'); decide(p, 'confirm'); await actions.idle(p.id);
    assert.equal(existsSync(join(projects.root(space.id), 'sample.txt')), false);
    const saved = file('exact content'); actions.save(space.id, saved);
    decide(saved, 'confirm'); decide(saved, 'confirm'); await actions.idle(saved.id);
    assert.equal(projects.read(space.id, 'sample.txt').content, 'exact content');
    assert.equal(learning.session(space.id, session).messages.length, 2);
    const stale = file('must not overwrite'); actions.save(space.id, stale);
    writeFileSync(join(projects.root(space.id), 'sample.txt'), 'external');
    assert.throws(() => decide(stale, 'confirm'), /版本已变化/);
    assert.equal(projects.read(space.id, 'sample.txt').content, 'external');
    const expired = { ...file('too late'), expiresAt: 0 }; actions.save(space.id, expired);
    assert.equal(decide(expired, 'confirm').state, 'expired');
    const cancelled = command('echo wrong > cancelled'); actions.save(space.id, cancelled);
    const concurrent = file('concurrent'); actions.save(space.id, concurrent);
    decide(cancelled, 'confirm');
    assert.throws(() => decide(concurrent, 'confirm'), /已有本机操作/);
    decide(cancelled, 'cancel'); await actions.idle(cancelled.id);
    assert.equal(actions.get(space.id, cancelled.id).state, 'cancelled');
    assert.equal(existsSync(join(projects.root(space.id), 'cancelled')), false);
    const once = command('echo once >> count; echo actual-output; exit 7'); actions.save(space.id, once);
    decide(once, 'confirm'); decide(once, 'confirm'); await actions.idle(once.id); decide(once, 'confirm');
    assert.equal(readFileSync(join(projects.root(space.id), 'count'), 'utf8'), 'once\n');
    assert.equal(actions.get(space.id, once.id).result?.exitCode, 7);
    assert.equal(actions.get(space.id, once.id).result?.output, 'actual-output\n');
    assert.equal(actions.get(space.id, once.id).state, 'failed');
    const staleCommand = command('touch stale-command'); actions.save(space.id, staleCommand);
    writeFileSync(join(projects.root(space.id), 'sample.txt'), 'changed again');
    assert.throws(() => decide(staleCommand, 'confirm'), /项目已变化/);
    assert.equal(existsSync(join(projects.root(space.id), 'stale-command')), false);
    const other = populated(learning).space;
    assert.throws(() => actions.get(other.id, once.id), /不存在/);
    const pending = file('after reboot'); actions.save(space.id, pending);
    const interrupted = { ...command('touch should-not-replay'), state: 'running' as const }; actions.save(space.id, interrupted);
    await actions.close(); data.close();
    const reopened = openDataDirectory(root);
    try {
      const recovered = new Actions(new Learning(reopened.db), projects);
      assert.equal(recovered.get(space.id, pending.id).state, 'expired');
      assert.equal(recovered.get(space.id, interrupted.id).state, 'interrupted');
      recovered.decide(space.id, interrupted.id, { digest: interrupted.digest, decision: 'confirm' });
      assert.equal(existsSync(join(projects.root(space.id), 'should-not-replay')), false);
    } finally { reopened.close(); }
  } finally { await actions.close(); data.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Pi proposes without side effects, discards failed turns and gets original-session action evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-proposal-pi-')), data = openDataDirectory(root);
  const learning = new Learning(data.db), projects = new Projects(root), actions = new Actions(learning, projects);
  const { space, units } = populated(learning);
  const session = learning.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'Actions' }).id;
  let failed = true, evidence = '';
  const runtime = new TeachingRuntime(learning, syntheticSource, { actions, projectDirectory: (s) => projects.root(s), stream: async (_m, context) => {
    if (context.messages.at(-1)?.role === 'toolResult') return response(reply([{ type: 'text', text: '请确认。' }], failed ? 'error' : 'stop'));
    evidence = JSON.stringify(context.messages);
    return response(reply([{ type: 'toolCall', id: randomUUID(), name: 'propose_command', arguments: { command: 'echo verified > proof', reason: '验证提案' } }], 'toolUse'));
  } });
  try {
    const submit = () => runtime.submit(space.id, session, randomUUID(), { text: 'propose', quote: null, draftRevision: learning.session(space.id, session).draft.revision }).run;
    let run = submit(); await runtime.idle(run.id);
    assert.equal(actions.list(space.id, session).length, 0);
    failed = false; run = submit(); await runtime.idle(run.id);
    const p = actions.list(space.id, session)[0]!;
    assert.equal(p.state, 'pending'); assert.equal(existsSync(join(projects.root(space.id), 'proof')), false);
    actions.decide(space.id, p.id, { digest: p.digest, decision: 'confirm' }); await actions.idle(p.id);
    run = submit(); await runtime.idle(run.id);
    assert.match(evidence, /local-action/); assert.match(evidence, /succeeded/);
    assert.equal(readFileSync(join(projects.root(space.id), 'proof'), 'utf8'), 'verified\n');
  } finally { await runtime.close(); await actions.close(); data.close(); rmSync(root, { recursive: true, force: true }); }
});

test('finite local commands report failure, absence, limits and cancellation and clean owned processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-commands-'));
  const controller = new AbortController();
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'SYNTHETIC-CREDENTIAL';
  try {
    const result = await runCommand('printf "OUT:%s" "${OPENROUTER_API_KEY-unset}"; printf ERR >&2; exit 9', root, controller.signal);
    assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 9); assert.match(result.output, /OUT:unset/); assert.match(result.output, /ERR/);
    assert.equal((await runCommand('tmc_missing_tool_abcdef', root, controller.signal)).status, 'unavailable');
    const timed = await runCommand('echo $$ > parent; sleep 30 & echo $! > child; wait', root, controller.signal, { milliseconds: 200, outputBytes: 1024 });
    assert.equal(timed.status, 'timed-out');
    for (const name of ['parent', 'child']) assert.throws(() => process.kill(Number(readFileSync(join(root, name), 'utf8')), 0), { code: 'ESRCH' });
    const full = await runCommand('while :; do printf 1234567890; done', root, controller.signal, { milliseconds: 1000, outputBytes: 31 });
    assert.equal(full.status, 'output-limit'); assert.equal(Buffer.byteLength(full.output), 31);
    const work = runCommand('echo $$ > cancel-parent; sleep 30', root, controller.signal);
    await new Promise((r) => setTimeout(r, 100)); controller.abort();
    assert.equal((await work).status, 'cancelled');
    assert.throws(() => process.kill(Number(readFileSync(join(root, 'cancel-parent'), 'utf8')), 0), { code: 'ESRCH' });
    const normal = await runCommand('sleep 30 & echo $! > background; echo clean', root, new AbortController().signal);
    assert.equal(normal.status, 'succeeded');
    assert.throws(() => process.kill(Number(readFileSync(join(root, 'background'), 'utf8')), 0), { code: 'ESRCH' });
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; rmSync(root, { recursive: true, force: true }); }
});

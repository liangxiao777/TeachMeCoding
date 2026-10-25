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

test('YOLO serializes successful file approvals, preserves edits and never executes failed or stopped turns', async () => {
  for (const mode of ['enabled', 'disabled', 'failed', 'stopped', 'stale'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'tmc-yolo-actions-')), data = openDataDirectory(root);
    const learning = new Learning(data.db), projects = new Projects(root), actions = new Actions(learning, projects);
    const { space, units } = populated(learning);
    const session = learning.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'YOLO' }).id;
    learning.saveSessionSettings(space.id, session, { revision: 0, yolo: true });
    projects.newFile(space.id, 'first.txt', 'original');
    let runId = '';
    const runtime = new TeachingRuntime(learning, syntheticSource, { actions, projectDirectory: (s) => projects.root(s),
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, stream: (_m, context) => {
        if (context.messages.at(-1)?.role === 'toolResult') {
          if (mode === 'disabled') learning.saveSessionSettings(space.id, session, { revision: 1, yolo: false });
          if (mode === 'stopped') runtime.stop(space.id, runId);
          if (mode === 'stale') projects.save(space.id, { ...projects.read(space.id, 'first.txt'), content: 'new user edit' });
          return response(reply([], mode === 'failed' ? 'error' : 'stop'));
        }
        return response(reply([
          { type: 'toolCall', id: 'first', name: 'propose_file_change', arguments: { path: 'first.txt', content: 'agent edit', reason: 'Update example' } },
          { type: 'toolCall', id: 'second', name: 'propose_file_change', arguments: { path: 'second.txt', content: 'new example', reason: 'Add example' } },
        ], 'toolUse'));
      } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'Update examples', quote: null, draftRevision: 0 });
      runId = run.id; await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, mode === 'failed' ? 'failed' : mode === 'stopped' ? 'interrupted' : 'succeeded');
      assert.equal(projects.read(space.id, 'first.txt').content, mode === 'enabled' ? 'agent edit' : mode === 'stale' ? 'new user edit' : 'original');
      assert.equal(existsSync(join(projects.root(space.id), 'second.txt')), mode === 'enabled');
      const saved = actions.list(space.id, session);
      if (mode === 'enabled') {
        assert.deepEqual(saved.map((p) => p.state), ['succeeded', 'succeeded']);
        assert.equal(projects.read(space.id, 'second.txt').content, 'new example');
        assert.ok(saved.every((p) => p.receiptId && learning.session(space.id, session).messages.some((m) => m.id === p.receiptId)));
        // Historical command records use the same consent and execution path.
        const command = actions.prepare(space.id, session, run.id, 'command', { command: 'printf once >> count', reason: 'Legacy record' });
        actions.save(space.id, command);
        await runtime.approveSession(space.id, session); await runtime.approveSession(space.id, session);
        assert.equal(actions.get(space.id, command.id).state, 'succeeded');
        const receiptId = actions.get(space.id, command.id).receiptId;
        assert.ok(receiptId);
        assert.equal(learning.session(space.id, session).messages.filter((m) => m.id === receiptId).length, 1);
        await runtime.approveSession(space.id, session);
        assert.equal(actions.get(space.id, command.id).receiptId, receiptId);
        assert.equal(readFileSync(join(projects.root(space.id), 'count'), 'utf8'), 'once');
      } else if (mode === 'stale') {
        assert.deepEqual(saved.map((p) => p.state), ['expired', 'pending']);
        const warning = learning.session(space.id, session).messages.at(-1)!;
        assert.equal(warning.text, '');
        assert.deepEqual(warning.notice, { code: 'ACTION_FILE_CHANGED' });
        const notices = runtime.events(space.id, run.id).events.filter((e) => e.data.type === 'notice');
        assert.equal(notices.length, 1);
        assert.deepEqual(notices[0]!.data, { type: 'notice', messageId: warning.id, notice: warning.notice });
        assert.deepEqual(runtime.events(space.id, run.id, notices[0]!.seq - 1).events, notices);
        const receiptId = saved[0]!.receiptId;
        assert.ok(receiptId && receiptId !== warning.id);
        await runtime.close(); await actions.close(); data.close();
        const reopened = openDataDirectory(root), hydrated = new Learning(reopened.db);
        const replay = new TeachingRuntime(hydrated, syntheticSource);
        try {
          assert.deepEqual(replay.events(space.id, run.id).events.filter((e) => e.data.type === 'notice'), notices);
          assert.deepEqual(hydrated.session(space.id, session).messages.find((m) => m.id === warning.id), warning);
          assert.equal(new Actions(hydrated, projects).get(space.id, saved[0]!.id).receiptId, receiptId);
          assert.equal(hydrated.session(space.id, session).messages.filter((m) => m.id === receiptId).length, 1);
        } finally { await replay.close(); reopened.close(); }
      } else assert.deepEqual(saved.map((p) => p.state), mode === 'disabled' ? ['pending', 'pending'] : []);
    } finally { await runtime.close(); await actions.close(); data.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

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
    assert.throws(() => actions.decide(space.id, p.id, { digest: 'different', decision: 'confirm' }), { message: 'ACTION_DIGEST_MISMATCH' });
    decide(p, 'reject'); decide(p, 'confirm'); await actions.idle(p.id);
    assert.equal(existsSync(join(projects.root(space.id), 'sample.txt')), false);
    const saved = file('exact content'); actions.save(space.id, saved);
    decide(saved, 'confirm'); decide(saved, 'confirm'); await actions.idle(saved.id);
    assert.equal(projects.read(space.id, 'sample.txt').content, 'exact content');
    const receipts = learning.session(space.id, session).messages;
    assert.equal(receipts.length, 2);
    assert.equal(actions.get(space.id, p.id).receiptId, receipts[0]!.id);
    assert.equal(actions.get(space.id, saved.id).receiptId, receipts[1]!.id);
    assert.equal(receipts[0]!.text, '');
    assert.equal(receipts[1]!.text, '');
    assert.deepEqual(actions.get(space.id, saved.id).result, { status: 'succeeded', output: '', exitCode: 0, signal: null });
    assert.ok(receipts.every((m) => !m.text.includes(p.id) && !m.text.includes(saved.id) && !m.text.includes(projects.root(space.id))));
    const stale = file('must not overwrite'); actions.save(space.id, stale);
    writeFileSync(join(projects.root(space.id), 'sample.txt'), 'external');
    assert.throws(() => decide(stale, 'confirm'), { message: 'ACTION_FILE_CHANGED' });
    assert.equal(projects.read(space.id, 'sample.txt').content, 'external');
    const expired = { ...file('too late'), expiresAt: 0 }; actions.save(space.id, expired);
    assert.equal(decide(expired, 'confirm').state, 'expired');
    const cancelled = command('echo wrong > cancelled'); actions.save(space.id, cancelled);
    const concurrent = file('concurrent'); actions.save(space.id, concurrent);
    decide(cancelled, 'confirm');
    assert.throws(() => decide(concurrent, 'confirm'), { message: 'LOCAL_ACTION_RUNNING' });
    decide(cancelled, 'cancel'); await actions.idle(cancelled.id);
    assert.equal(actions.get(space.id, cancelled.id).state, 'cancelled');
    assert.equal(existsSync(join(projects.root(space.id), 'cancelled')), false);
    const once = command('echo once >> count; echo actual-output; exit 7'); actions.save(space.id, once);
    decide(once, 'confirm'); decide(once, 'confirm'); await actions.idle(once.id); decide(once, 'confirm');
    assert.equal(readFileSync(join(projects.root(space.id), 'count'), 'utf8'), 'once\n');
    assert.equal(actions.get(space.id, once.id).result?.exitCode, 7);
    assert.equal(actions.get(space.id, once.id).result?.output, 'actual-output\n');
    assert.equal(actions.get(space.id, once.id).result?.error, undefined, 'program output is not a host business failure');
    assert.equal('errorDetail' in actions.get(space.id, once.id).result!, false);
    assert.equal(actions.get(space.id, once.id).state, 'failed');
    const receiptMessage = learning.session(space.id, session).messages.at(-1)!;
    assert.equal(actions.get(space.id, once.id).receiptId, receiptMessage.id);
    const receipt = receiptMessage.text;
    assert.equal(receipt, '');
    assert.equal(receipt.includes(once.id), false);
    const staleCommand = command('touch stale-command'); actions.save(space.id, staleCommand);
    writeFileSync(join(projects.root(space.id), 'sample.txt'), 'changed again');
    assert.throws(() => decide(staleCommand, 'confirm'), { message: 'ACTION_PROJECT_CHANGED' });
    assert.equal(existsSync(join(projects.root(space.id), 'stale-command')), false);
    const other = populated(learning).space;
    assert.throws(() => actions.get(other.id, once.id), { message: 'ACTION_PROPOSAL_NOT_FOUND' });
    const pending = file('after reboot'); actions.save(space.id, pending);
    const interrupted = { ...command('touch should-not-replay'), state: 'running' as const }; actions.save(space.id, interrupted);
    await actions.close(); data.close();
    const reopened = openDataDirectory(root);
    try {
      const hydrated = new Learning(reopened.db), recovered = new Actions(hydrated, projects);
      assert.equal(recovered.get(space.id, pending.id).state, 'expired');
      assert.equal(recovered.get(space.id, interrupted.id).state, 'interrupted');
      recovered.decide(space.id, interrupted.id, { digest: interrupted.digest, decision: 'confirm' });
      assert.equal(existsSync(join(projects.root(space.id), 'should-not-replay')), false);
      recovered.decide(space.id, once.id, { digest: once.digest, decision: 'confirm' }); await recovered.idle(once.id);
      assert.equal(recovered.get(space.id, once.id).receiptId, receiptMessage.id);
      assert.deepEqual(hydrated.session(space.id, session).messages.find((m) => m.id === receiptMessage.id), receiptMessage);
      assert.equal(hydrated.session(space.id, session).messages.filter((m) => m.id === receiptMessage.id).length, 1);
      assert.equal(readFileSync(join(projects.root(space.id), 'count'), 'utf8'), 'once\n');
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
    return response(reply([{ type: 'toolCall', id: randomUUID(), name: 'propose_file_change', arguments: { path: 'proof', content: 'verified\n', reason: '验证提案' } }], 'toolUse'));
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
    writeFileSync(join(root, 'tree.cjs'), `
const fs = require('node:fs'), { spawn } = require('node:child_process');
fs.writeFileSync('parent', String(process.pid));
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
fs.writeFileSync('child', String(child.pid));
setInterval(()=>{},1000);
`);
    const timed = await runCommand('node tree.cjs', root, controller.signal, { milliseconds: 1500, outputBytes: 1024 });
    assert.equal(timed.status, 'timed-out');
    for (const name of ['parent', 'child']) assert.throws(() => process.kill(Number(readFileSync(join(root, name), 'utf8')), 0), { code: 'ESRCH' });
    const full = await runCommand('while :; do printf 1234567890; done', root, controller.signal, { milliseconds: 1000, outputBytes: 31 });
    assert.equal(full.status, 'output-limit'); assert.equal(Buffer.byteLength(full.output), 31);
    const work = runCommand(`node -e 'require("node:fs").writeFileSync("cancel-parent", String(process.pid)); setInterval(()=>{},1000)'`, root, controller.signal);
    for (let attempt = 0; attempt < 200 && !existsSync(join(root, 'cancel-parent')); attempt++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(join(root, 'cancel-parent'))); controller.abort();
    assert.equal((await work).status, 'cancelled');
    assert.throws(() => process.kill(Number(readFileSync(join(root, 'cancel-parent'), 'utf8')), 0), { code: 'ESRCH' });
    const normal = await runCommand(`node -e 'require("node:fs").writeFileSync("background", String(process.pid)); setInterval(()=>{},1000)' & while [ ! -f background ]; do sleep 0.02; done; echo clean`, root, new AbortController().signal);
    assert.equal(normal.status, 'succeeded');
    assert.throws(() => process.kill(Number(readFileSync(join(root, 'background'), 'utf8')), 0), { code: 'ESRCH' });
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; rmSync(root, { recursive: true, force: true }); }
});

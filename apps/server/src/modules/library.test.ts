import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { readTools } from '../agents/read-tools.js';
import { Library } from './library.js';

const text = (result: AgentToolResult) => result.content.map((part) => part.type === 'text' ? part.text : '').join('');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Pi Bash preserves errors and cumulative snapshots; truncated output can be read until run cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-bash-')), library = new Library(root);
  const run = randomUUID(), secret = process.env.TMC_BASH_TEST_SECRET;
  process.env.TMC_BASH_TEST_SECRET = 'DO-NOT-INHERIT';
  try {
    const tools = library.tools(run);
    assert.deepEqual(tools.map((t) => t.name), ['list_library_files', 'bash']);
    const bash = tools.find((t) => t.name === 'bash')!;
    const cwd = await bash.execute('cwd', { command: 'printf "%s\n" "$PWD" "${TMC_BASH_TEST_SECRET-unset}"' });
    assert.ok(text(cwd).endsWith('/library\nunset\n'));
    const failed = await bash.execute('failed', { command: 'printf stdout; printf stderr >&2; exit 7' });
    assert.equal(failed.isError, true); assert.match(text(failed), /stdout/); assert.match(text(failed), /stderr/);
    assert.match(text(failed), /Command exited with code 7/);
    const snapshots: string[] = [];
    const streamed = await bash.execute('stream', { command: 'printf first; sleep 0.15; printf second' }, undefined, (value) => snapshots.push(text(value)));
    assert.equal(text(streamed), 'firstsecond');
    assert.ok(snapshots.includes('first')); assert.equal(snapshots.at(-1), 'firstsecond');
    const long = await bash.execute('long', { command: 'awk \'BEGIN { for (i=1;i<=3000;i++) printf "%04d: abcdefghijklmnopqrstuvwxyz\\n", i }\'; printf complete > continued' });
    assert.equal(long.isError, undefined);
    assert.match(text(long), /3000: abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(text(long), /0001: abcdefghijklmnopqrstuvwxyz/);
    assert.equal(readFileSync(join(library.directory, 'continued'), 'utf8'), 'complete', 'Display truncation must not kill the command.');
    const path = long.details.fullOutputPath as string;
    assert.equal(resolve(path).startsWith(join(root, 'bash-output', `run-${run}`)), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, 'bash-output', `run-${run}`)).mode & 0o777, 0o700);
    const page = await readTools(library.directory)[0]!.execute('read', { path, offset: 0, limit: 100 });
    assert.match(text(page), /0001: abcdefghijklmnopqrstuvwxyz/);
    assert.equal(readFileSync(path, 'utf8').split('\n').length, 3001);
    // A missing output directory must fail this tool call, not crash the server.
    rmSync(join(root, 'bash-output', `run-${run}`), { recursive: true });
    await assert.rejects(bash.execute('spool-failure', { command: 'head -c 60000 /dev/zero; sleep 0.1' }), /ENOENT/);
    assert.equal(text(await bash.execute('still-usable', { command: 'printf alive' })), 'alive');
    library.release(run); assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(join(root, 'bash-output')), []);
  } finally {
    if (secret === undefined) delete process.env.TMC_BASH_TEST_SECRET; else process.env.TMC_BASH_TEST_SECRET = secret;
    await library.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('default Bash supports optional timeout, stopping and shutdown without escaped writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-bash-stop-')), library = new Library(root);
  try {
    const bash = library.tools().find((t) => t.name === 'bash')!;
    await assert.rejects(bash.execute('timeout', { command: 'printf timeout-ready; sleep 5; touch timeout-escaped', timeout: 0.1 }), /timeout-ready[\s\S]*timed out after 0.1 seconds/);
    assert.equal(existsSync(join(library.directory, 'timeout-escaped')), false);
    for (const cause of ['stop', 'shutdown']) {
      let started!: () => void;
      const ready = new Promise<void>((r) => { started = r; });
      const controller = new AbortController();
      const work = bash.execute(cause, { command: `printf ready; sleep 5; touch ${cause}-escaped` }, controller.signal,
        (value) => { if (text(value).includes('ready')) started(); });
      // Attach rejection handling before cancelling, so it cannot become unhandled.
      const cancelled = assert.rejects(work, /Command aborted/);
      await ready;
      if (cause === 'stop') controller.abort();
      else await library.close();
      await cancelled;
      assert.equal(existsSync(join(library.directory, `${cause}-escaped`)), false);
    }
    await assert.rejects(bash.execute('closed', { command: 'touch closed-escaped' }), { name: 'AbortError' });
    assert.equal(existsSync(join(library.directory, 'closed-escaped')), false);
  } finally { await library.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Bash reaps ordinary background jobs and stops runaway output at the disk ceiling; startup removes only transient files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-bash-limits-'));
  let library = new Library(root);
  try {
    const bash = library.tools().find((t) => t.name === 'bash')!;
    await bash.execute('background', { command: '(while [ ! -e release-background ]; do sleep 0.02; done; printf escaped > background-escaped) >/dev/null 2>&1 & printf finished' });
    // Release only after the tool settles, so cleanup cannot win by timing alone.
    writeFileSync(join(library.directory, 'release-background'), 'ready');
    await wait(500); assert.equal(existsSync(join(library.directory, 'background-escaped')), false);
    const value = await bash.execute('output-limit', { command: 'head -c 100000000 /dev/zero; touch output-escaped' });
    assert.equal(value.isError, true); assert.match(text(value), /32 MiB disk-safety limit/);
    assert.equal(existsSync(join(library.directory, 'output-escaped')), false);
    assert.ok(statSync(value.details.fullOutputPath).size < 33555000);
    const saved = await library.upload(randomUUID(), 'permanent.md', new Response('keep this').body, new AbortController().signal);
    await library.close();
    const orphan = join(root, 'bash-output', `run-${randomUUID()}`); mkdirSync(orphan); writeFileSync(join(orphan, 'log'), 'transient');
    const partial = join(library.directory, `.upload-${randomUUID()}-ABC123`); mkdirSync(partial); writeFileSync(join(partial, 'source'), 'partial');
    library = new Library(root);
    assert.equal(existsSync(orphan), false); assert.equal(existsSync(partial), false);
    assert.equal(readFileSync(library.get(saved.id).path, 'utf8'), 'keep this');
  } finally { await library.close(); rmSync(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { spawn } from 'node-pty';
import { terminalEnvironment } from '../runtime/terminal-env.js';

test('SQLite persists exact values after close and reopen in disposable storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teach-me-coding-db-'));
  let db: Database.Database | undefined;
  try {
    const path = join(directory, 'app.db');
    db = new Database(path);
    db.exec('CREATE TABLE checks (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO checks VALUES (?, ?)');
    insert.run(7, '课程\n"quoted"');
    insert.run(42, 'second value');
    db.close();
    db = new Database(path, { readonly: true, fileMustExist: true });
    assert.deepEqual(db.prepare('SELECT * FROM checks ORDER BY id DESC').all(), [
      { id: 42, value: 'second value' }, { id: 7, value: '课程\n"quoted"' },
    ]);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('terminal environment excludes credentials and Node injection settings', () => {
  assert.deepEqual(terminalEnvironment({
    PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/tmp/example',
    OPENROUTER_API_KEY: 'synthetic-secret', OTHER_PROVIDER_SECRET: 'synthetic-secret',
    NODE_OPTIONS: '--require=untrusted.js', VITE_SECRET: 'synthetic-secret',
  }), { TERM: 'xterm-256color', PATH: '/usr/bin', HOME: '/tmp/example', LANG: 'en_US.UTF-8' });
});

for (const terminate of [false, true]) {
  test(`PTY ${terminate ? 'forced cleanup' : 'input, output and nonzero exit'} leaves no process`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'teach-me-coding-pty-'));
    let pty: ReturnType<typeof spawn> | undefined;
    let exited: Promise<{ exitCode: number; signal?: number }> | undefined;
    let hasExited = false;
    t.after(async () => {
      if (!hasExited) pty?.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    const code = terminate
      ? 'console.log("READY"); setInterval(() => {}, 1000);'
      : 'console.log("READY"); process.stdin.once("data", data => { console.log(JSON.stringify({ input: data.toString().trim(), tty: process.stdout.isTTY, cwd: process.cwd(), secret: process.env.OPENROUTER_API_KEY ?? null })); process.exit(7); });';
    pty = spawn(process.execPath, ['-e', code], {
      name: 'xterm-256color', cols: 90, rows: 30, cwd: directory,
      env: terminalEnvironment({ ...process.env, OPENROUTER_API_KEY: 'synthetic-secret' }),
    });
    let output = '';
    exited = new Promise((resolve) => {
      pty!.onExit((event) => { hasExited = true; resolve(event); });
    });
    await new Promise<void>((resolve) => {
      pty!.onData((data) => {
        output += data;
        if (output.includes('READY')) resolve();
      });
    });
    if (terminate) pty.kill();
    else pty.write('answer-42\r');
    const result = await exited;
    if (terminate) assert.ok(result.signal, 'forced PTY exit must report a signal');
    else {
      assert.equal(result.exitCode, 7);
      const line = output.split(/\r?\n/).find((item) => item.startsWith('{'))!;
      // macOS /var is a symlink to /private/var; compare the actual directory.
      assert.deepEqual(JSON.parse(line), {
        input: 'answer-42', tty: true, cwd: await realpath(directory), secret: null,
      });
    }
    assert.throws(() => process.kill(pty.pid, 0), { code: 'ESRCH' });
  });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('one production service serves UI and API from an unrelated working directory', { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-me-coding-start-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/server/dist/index.js', import.meta.url))], {
    cwd, env: { PATH: process.env.PATH, PORT: '14310' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => { if (data.toString().includes('listening')) resolve(); });
      child.once('exit', (code) => reject(new Error(`Server exited early: ${code}`)));
      child.once('error', reject);
    });
    const base = 'http://127.0.0.1:14310';
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok', service: 'teach-me-coding' });
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /TeachMeCoding/);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    const js = await fetch(`${base}${asset}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(await (await fetch(`${base}/learning/example`)).text(), html);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  } finally {
    child.kill('SIGTERM');
    await exited;
    await rm(cwd, { recursive: true, force: true });
  }
});

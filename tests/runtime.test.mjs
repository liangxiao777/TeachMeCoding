import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('compiled teaching prompt assets load without a source-tree cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tmc-prompt-assets-'));
  try {
    const url = new URL('../apps/server/dist/agents/context.js', import.meta.url).href;
    const xml = execFileSync(process.execPath, ['--input-type=module', '-e', `const {systemPrompt}=await import(${JSON.stringify(url)}); console.log(systemPrompt('tutor'));`], { cwd, encoding: 'utf8' });
    assert.match(xml, /<teaching schemaVersion="1">/);
    assert.match(xml, /<scenario>tutor<\/scenario>/);
    assert.ok(!xml.includes('undefined'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

function rawRequest(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 14310, path, method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.end();
  });
}

for (const hostname of ['127.0.0.1', '0.0.0.0']) test(`production ${hostname} startup, static routing, HTTP and upgrade boundaries from an unrelated cwd`, { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-me-coding-start-'));
  const syntheticSecret = 'server-only-credential-sentinel';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/server/dist/index.js', import.meta.url))], {
    cwd, env: { PATH: process.env.PATH, HOST: hostname, PORT: '14310', TMC_DATA_DIR: join(cwd, 'data'), OPENROUTER_API_KEY: syntheticSecret }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => { if (data.toString().includes('listening')) resolve(); });
      child.once('exit', (code) => reject(new Error(`Server exited early: ${code}`)));
      child.once('error', reject);
    });
    const base = 'http://127.0.0.1:14310';
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok', service: 'teach-me-coding' });
    const lan = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
    if (hostname === '0.0.0.0' && lan) {
      const network = `http://${lan}:14310`;
      assert.equal((await fetch(`${network}/api/health`)).status, 200);
      const bootstrap = await fetch(`${network}/api/access`, { headers: { 'X-TMC-Client': 'browser', Origin: network } });
      assert.equal(bootstrap.status, 200);
      const { token } = await bootstrap.json();
      assert.equal((await fetch(`${network}/api/access/check`, { method: 'POST', headers: { 'X-TMC-Token': token, Origin: network } })).status, 200);
    }
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /TeachMeCoding/);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    const js = await fetch(`${base}${asset}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(await (await fetch(`${base}/learning/example`)).text(), html);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    const bootstrap = await rawRequest('/api/access', { 'X-TMC-Client': 'browser' });
    assert.equal(bootstrap.status, 200);
    const { token } = JSON.parse(bootstrap.body);
    const headers = { 'X-TMC-Token': token, Origin: base };
    assert.equal((await rawRequest('/api/missing', headers)).status, 404);
    assert.equal((await rawRequest('/api/missing')).status, 401);
    const checked = await rawRequest('/api/access/check', headers, 'POST');
    assert.deepEqual(JSON.parse(checked.body), { ok: true });
    assert.equal(checked.headers['access-control-allow-origin'], undefined);
    for (const [changed, expected] of [
      [{ 'X-TMC-Token': '' }, 401], [{ 'X-TMC-Token': 'f'.repeat(64) }, 401],
      [{ Origin: 'http://evil.test' }, 403], [{ Origin: 'null' }, 403],
      [{ Origin: 'http://localhost:5173' }, 403], [{ Host: 'evil.test:14310' }, 403],
    ]) {
      const response = await rawRequest('/api/access/check', { ...headers, ...changed }, 'POST');
      assert.equal(response.status, expected);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.ok(!response.body.includes(syntheticSecret));
    }
    const upgrade = {
      Connection: 'Upgrade', Upgrade: 'websocket', Origin: base,
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Protocol': `tmc-terminal, tmc-token.${token}`,
    };
    assert.equal((await rawRequest('/api/terminal/socket', upgrade)).status, 501);
    for (const [changed, expected] of [
      [{ 'Sec-WebSocket-Protocol': 'tmc-terminal' }, 401],
      [{ 'Sec-WebSocket-Protocol': `tmc-terminal, tmc-token.${'0'.repeat(64)}` }, 401],
      [{ Origin: '' }, 403], [{ Origin: 'http://evil.test' }, 403], [{ Host: 'evil.test:14310' }, 403],
    ]) {
      assert.equal((await rawRequest('/api/terminal/socket', { ...upgrade, ...changed })).status, expected);
    }
    assert.equal((await rawRequest(`/api/terminal/socket?token=${token}`, { ...upgrade, 'Sec-WebSocket-Protocol': 'tmc-terminal' })).status, 401);
    for (const path of ['/.env', '/@fs/../../.env', '/apps/server/src/config/model.ts']) {
      assert.equal((await rawRequest(path)).status, 404);
    }
    assert.ok(![html, await js.text(), bootstrap.body, checked.body, logs].some((value) => value.includes(syntheticSecret)));
  } finally {
    child.kill('SIGTERM');
    await exited;
    await rm(cwd, { recursive: true, force: true });
  }
});

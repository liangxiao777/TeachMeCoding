import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(new URL('../apps/server/package.json', import.meta.url))('ws');

test('project startup files work from unrelated directories, agree with Vite, and never supply model credentials', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmc-startup-file-'));
  const checkout = join(root, 'checkout'), cwd = join(root, 'unrelated'), data = join(root, 'configured data #31');
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '14313', OPENROUTER_API_KEY: 'synthetic-ambient-secret' };
  let child, exited, logs = '';
  try {
    await mkdir(cwd);
    await mkdir(checkout);
    await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
    for (const path of ['apps/server/dist', 'apps/web/vite.config.ts', 'packages/contracts/dist', 'packages/contracts/package.json', 'packages/contracts/src/startup.ts']) {
      await mkdir(dirname(join(checkout, path)), { recursive: true });
      await cp(new URL(`../${path}`, import.meta.url), join(checkout, path), { recursive: true });
    }
    // Only our workspace packages are copied; third-party dependencies stay installed in the real checkout.
    for (const app of ['server', 'web']) {
      const modules = join(checkout, 'apps', app, 'node_modules');
      await mkdir(join(modules, '@teach-me-coding'), { recursive: true });
      await symlink(join(checkout, 'packages/contracts'), join(modules, '@teach-me-coding/contracts'), 'dir');
      const installed = new URL(`../apps/${app}/node_modules/`, import.meta.url);
      for (const name of await readdir(installed)) {
        if (name !== '@teach-me-coding') await symlink(fileURLToPath(new URL(name, installed)), join(modules, name), 'dir');
      }
    }
    await symlink(fileURLToPath(new URL('../packages/contracts/node_modules', import.meta.url)), join(checkout, 'packages/contracts/node_modules'), 'dir');
    await symlink(fileURLToPath(new URL('../apps/web/dist', import.meta.url)), join(checkout, 'apps/web/dist'), 'dir');
    await writeFile(join(checkout, '.env'), [
      `TMC_DATA_DIR=${JSON.stringify(data)}`, 'HOST=127.0.0.1', 'PORT=14312', 'TMC_WEB_PORT=15312',
      'TMC_PREVIEW_ORIGIN=http://127.0.0.1:15412', 'TMC_AGENT_DEBUG_SNAPSHOTS=0', 'NODE_ENV=development',
      'OPENROUTER_API_KEY=synthetic-file-secret', 'OPENROUTER_MODEL=stealth/space-bunny-alpha',
      'BRAVE_API_KEY=synthetic-search-secret', 'VITE_PRIVATE_TOKEN=synthetic-browser-secret',
    ].join('\n'));
    await writeFile(join(cwd, '.env'), 'HOST=evil.test\nPORT=0\nTMC_DATA_DIR=./wrong-directory\n');
    for (const path of ['packages/contracts/src/startup.ts', 'packages/contracts/dist/startup.js']) {
      const script = `const {startupEnvironment}=await import(${JSON.stringify(pathToFileURL(join(checkout, path)).href)}); console.log(JSON.stringify(startupEnvironment()));`;
      assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' })), {
        TMC_DATA_DIR: data, HOST: '127.0.0.1', PORT: '14313', TMC_WEB_PORT: '15312',
        TMC_PREVIEW_ORIGIN: 'http://127.0.0.1:15412', TMC_AGENT_DEBUG_SNAPSHOTS: '0', NODE_ENV: 'production',
      });
    }
    const vite = `const {default:config}=await import(${JSON.stringify(pathToFileURL(join(checkout, 'apps/web/vite.config.ts')).href)}); console.log(JSON.stringify(config.server));`;
    const web = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', vite], { cwd, env, encoding: 'utf8' }));
    assert.equal(web.host, '127.0.0.1');
    assert.equal(web.port, 15312);
    assert.equal(web.proxy['/api'].target, 'http://127.0.0.1:14313');
    assert.ok(web.headers['Content-Security-Policy'].includes('http://127.0.0.1:15412'));
    child = spawn(process.execPath, [join(checkout, 'apps/server/dist/index.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
    for (let n = 0; n < 150 && !logs.includes('listening') && child.exitCode === null; n++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(logs.includes('listening'), logs);
    const base = 'http://127.0.0.1:14313';
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.ok(health.headers.get('content-security-policy').includes('http://127.0.0.1:15412'));
    assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'http://127.0.0.1:15312' } })).status, 403);
    const { token } = await (await fetch(`${base}/api/access`, { headers: { 'X-TMC-Client': 'browser' } })).json();
    const response = await fetch(`${base}/api/settings/model`, { headers: { 'X-TMC-Token': token } });
    const settings = await response.json();
    assert.equal(response.status, 200);
    assert.equal(settings.selection, null);
    assert.equal(settings.ready, false);
    assert.equal(settings.providers.find((provider) => provider.id === 'openrouter').configured, null);
    assert.ok(!JSON.stringify(settings).includes('synthetic-'));
    assert.equal((await stat(join(data, 'app.db'))).isFile(), true);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.ok(!logs.includes('synthetic-'));
  } finally {
    if (child) { child.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test('compiled teaching prompt assets load without a source-tree cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tmc-prompt-assets-'));
  try {
    const url = new URL('../apps/server/dist/agents/context.js', import.meta.url).href;
    const scenarios = ['intake', 'roadmap', 'tutor', 'lesson', 'assessment', 'evaluation'];
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const {systemPrompt}=await import(${JSON.stringify(url)}); console.log(JSON.stringify(${JSON.stringify(scenarios)}.map(systemPrompt)));`], { cwd, encoding: 'utf8' });
    const prompts = JSON.parse(output);
    assert.equal(prompts.length, scenarios.length);
    for (const [index, xml] of prompts.entries()) {
      assert.match(xml, /<teaching schemaVersion="1">/);
      assert.ok(xml.includes(`<scenario>${scenarios[index]}</scenario>`));
      assert.match(xml, /所有面向用户的内容都必须使用用户当前沟通所用的语言/);
      assert.doesNotMatch(xml, /中文课件|用简短自然的中文/);
      assert.ok(!xml.includes('undefined'));
    }
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

for (const { hostname, previewOrigin } of [
  { hostname: '127.0.0.1' },
  { hostname: '0.0.0.0' },
  { hostname: '127.0.0.1', previewOrigin: 'http://127.0.0.1:15372' },
]) test(`production ${hostname}${previewOrigin ? ' with preview' : ''} startup, static routing, HTTP and upgrade boundaries from an unrelated cwd`, { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-me-coding-start-'));
  const syntheticSecret = 'server-only-credential-sentinel';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/server/dist/index.js', import.meta.url))], {
    cwd, env: { PATH: process.env.PATH, HOST: hostname, PORT: '14310', TMC_DATA_DIR: join(cwd, 'data'), OPENROUTER_API_KEY: syntheticSecret, OPENROUTER_MODEL: 'stealth/space-bunny-alpha', ...(previewOrigin ? { TMC_PREVIEW_ORIGIN: previewOrigin } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  let terminalPid;
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => { if (data.toString().includes('listening')) resolve(); });
      child.once('exit', (code) => reject(new Error(`Server exited early: ${code}`)));
      child.once('error', reject);
    });
    const base = 'http://127.0.0.1:14310';
    const origin = previewOrigin ?? base;
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'teach-me-coding' });
    if (previewOrigin) {
      assert.equal(health.headers.get('x-frame-options'), null);
      assert.ok(health.headers.get('content-security-policy').includes(`frame-ancestors 'self' ${previewOrigin} vscode-webview: vscode-file://vscode-app`));
    } else {
      assert.equal(health.headers.get('x-frame-options'), 'DENY');
      assert.ok(health.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    }
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
    const js = await fetch(`${base}${asset}`, { headers: { Origin: origin } });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${base}${asset}`, { headers: { Origin: 'http://127.0.0.1:15373' } })).status, 403);
    assert.equal(await (await fetch(`${base}/learning/example`)).text(), html);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    const bootstrap = await rawRequest('/api/access', { 'X-TMC-Client': 'browser' });
    assert.equal(bootstrap.status, 200);
    const { token } = JSON.parse(bootstrap.body);
    const headers = { 'X-TMC-Token': token, Origin: origin };
    assert.equal((await rawRequest('/api/missing', headers)).status, 404);
    assert.equal((await rawRequest('/api/missing')).status, 401);
    const settings = await rawRequest('/api/settings/model', headers);
    assert.equal(settings.status, 200, 'a newly started production server must expose model settings');
    const modelSettings = JSON.parse(settings.body);
    assert.equal(modelSettings.selection, null);
    assert.equal(modelSettings.ready, false);
    assert.deepEqual(modelSettings.issue, { code: 'MODEL_NOT_SELECTED' });
    assert.equal(modelSettings.providers.find((provider) => provider.id === 'openrouter').configured, null);
    assert.ok(!settings.body.includes(syntheticSecret));
    assert.equal((await rawRequest('/api/settings/model')).status, 401);
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
      Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin,
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Protocol': `tmc-terminal, tmc-token.${token}`,
    };
    assert.equal((await rawRequest('/api/terminal/socket', upgrade)).status, 400);
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
    const created = await fetch(`${base}/api/spaces`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ name: 'Disposable terminal', goal: 'Synthetic local execution' }) });
    const space = await created.json();
    assert.equal(created.status, 200);
    const socket = new WebSocket(`ws://127.0.0.1:14310/api/terminal/socket?space=${space.id}`, ['tmc-terminal', `tmc-token.${token}`], { origin });
    await new Promise((resolve, reject) => {
      let output = '';
      socket.on('error', reject);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'snapshot') socket.send(JSON.stringify({ type: 'input', id: event.id, data: "printf 'OWNED_PID=%s\\n' $$; printenv OPENROUTER_API_KEY; printf 'NO_KEY=%s\\n' $?\r" }));
        if (event.type === 'data') output += event.data;
        if (/NO_KEY=1\r?\n/.test(output)) {
          terminalPid = Number(output.match(/OWNED_PID=(\d+)/)[1]);
          assert.ok(!output.includes(syntheticSecret)); socket.close(); resolve();
        }
      });
    });
    assert.ok(![html, await js.text(), bootstrap.body, checked.body, logs].some((value) => value.includes(syntheticSecret)));
  } finally {
    child.kill('SIGTERM');
    await exited;
    if (terminalPid) assert.throws(() => process.kill(terminalPid, 0), { code: 'ESRCH' });
    await rm(cwd, { recursive: true, force: true });
  }
});

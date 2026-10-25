import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryCredentialStore, type AuthResult, type Models } from '@earendil-works/pi-ai';
import { codexAuthSource, runCodexSearch, type CodexAuthSource, type CodexSearchLaunchOptions } from './codex-search.js';
import { descendants, stopProcesses } from '../runtime/processes.js';

const fixturePath = fileURLToPath(new URL('../../../../tests/fixtures/codex-search.mjs', import.meta.url));
const required = {
  project_root_markers: [], cli_auth_credentials_store: 'ephemeral',
  'features.shell_tool': false, 'features.plugins': false, 'features.remote_plugin': false,
  'features.apps': false, 'features.hooks': false, notify: [], 'features.image_generation': false,
  'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  project_doc_max_bytes: 0, web_search: 'live', 'features.standalone_web_search': false,
  'skills.include_instructions': false, include_environment_context: false,
  'history.persistence': 'none', 'analytics.enabled': false,
};
function authResult(account = 'account-one'): AuthResult {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: account }, email: 'synthetic@example.invalid', exp: 4_000_000_000 };
  return { source: 'OAuth', auth: { apiKey: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c3ludGhldGlj` } };
}
function authSource(result: AuthResult | undefined = authResult()): CodexAuthSource {
  return { checkAuth: async () => result ? { type: 'oauth' } : undefined, getAuth: async () => result };
}
type Request = { method: string; params: Record<string, unknown> };

function fixture(mode: string, onRequest?: (request: Request) => void) {
  let child: ChildProcessWithoutNullStreams | undefined, root = '', descendant: number | undefined;
  const requests: Request[] = [];
  const options: CodexSearchLaunchOptions = {
    launch(command, args, settings) {
      assert.equal(command, process.execPath);
      assert.equal(args[0], createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'));
      assert.deepEqual(args.slice(1, 4), ['app-server', '--listen', 'stdio://']);
      assert.equal(settings.detached, true);
      root = dirname(String(settings.cwd));
      const env = settings.env!;
      assert.equal(env.CODEX_HOME, join(root, 'codex-home')); assert.equal(env.HOME, env.CODEX_HOME);
      assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
      for (const path of [root, env.HOME!, String(settings.cwd)]) assert.equal(lstatSync(path).mode & 0o777, 0o700);
      assert.equal(existsSync(join(env.CODEX_HOME!, 'auth.json')), false);
      const config = new Map<string, unknown>();
      for (let i = 4; i < args.length; i += 2) {
        assert.equal(args[i], '-c');
        const entry = args[i + 1]!, position = entry.indexOf('=');
        config.set(entry.slice(0, position), JSON.parse(entry.slice(position + 1)));
      }
      for (const [key, value] of Object.entries(required)) assert.deepEqual(config.get(key), value);
      assert.ok(!config.has('features.apply_patch'));
      child = spawn(command, [fixturePath, mode, ...args.slice(1)], { ...settings, stdio: 'pipe' });
      let buffer = '', bytes = 0;
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) { buffer = ''; return; }
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.method === 'fixture/request') { requests.push(value.params); onRequest?.(value.params); }
            if (value.method === 'fixture/descendant') descendant = value.params.pid;
          } catch { /* Malformed frames are tested by the adapter. */ }
        }
      });
      return child;
    },
  };
  return { options, requests, get child() { return child; }, get root() { return root; }, get descendant() { return descendant; },
    assertClean() {
      assert.ok(child); assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(root), false, 'private directories removed only after process close');
    } };
}

test('auth factory scopes readiness/resolution/forced refresh to openai-codex, preserves account data', async () => {
  const store = new InMemoryCredentialStore();
  const credential = { type: 'oauth' as const, access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1000, accountId: 'account-one', extra: 'preserve' };
  await store.modify('openai-codex', async () => credential);
  await store.modify('teaching-provider', async () => ({ type: 'api_key', key: 'teaching-secret' }));
  const controller = new AbortController(), calls: string[] = [];
  const models = {
    async checkAuth(id: string, options: { signal?: AbortSignal }) { calls.push(id); assert.equal(options.signal, controller.signal); return { type: 'oauth' }; },
    async getAuth(id: string, options: { signal?: AbortSignal }) {
      calls.push(id); assert.equal(options.signal, controller.signal);
      assert.deepEqual(await store.read(id), { ...credential, expires: 0 }); return authResult();
    },
  } as unknown as Models;
  const auth = codexAuthSource(models, store);
  assert.deepEqual(await auth.checkAuth(controller.signal), { type: 'oauth' });
  assert.equal((await auth.getAuth(controller.signal, true))?.source, 'OAuth');
  assert.deepEqual(calls, ['openai-codex', 'openai-codex']);
  assert.deepEqual(await store.read('teaching-provider'), { type: 'api_key', key: 'teaching-secret' });
  controller.abort();
  await assert.rejects(auth.getAuth(controller.signal, true), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

test('queued expiry invalidation checks cancellation inside serialized modify, not just before entry', async () => {
  const store = new InMemoryCredentialStore();
  const credential = { type: 'oauth' as const, access: 'synthetic', refresh: 'synthetic-refresh', expires: 1000 };
  await store.modify('openai-codex', async () => credential);
  const controller = new AbortController();
  let modified = false, authCalled = false;
  const original = store.modify.bind(store);
  store.modify = async (provider, fn, options) => {
    controller.abort(); modified = true; return original(provider, fn, options);
  };
  const source = codexAuthSource({ getAuth: async () => { authCalled = true; return authResult(); } } as unknown as Models, store);
  await assert.rejects(source.getAuth(controller.signal, true), { name: 'AbortError' });
  assert.equal(modified, true); assert.equal(authCalled, false);
  assert.deepEqual(await store.read('openai-codex'), credential);
});

test('auth factory safely rejects non-OAuth and bounds auth that ignores cancellation', async () => {
  const source = codexAuthSource({ checkAuth: async () => ({ type: 'api_key' }), getAuth: async () => ({ source: 'OPENAI_API_KEY', auth: { apiKey: 'secret' } }) } as unknown as Models, new InMemoryCredentialStore());
  assert.equal(await source.checkAuth(), undefined);
  assert.equal(await source.getAuth(new AbortController().signal), undefined);
  const hanging = codexAuthSource({ getAuth: async () => new Promise(() => {}) } as unknown as Models, new InMemoryCredentialStore());
  const timer = setTimeout(() => {}, 100);
  try { await assert.rejects(hanging.getAuth(AbortSignal.timeout(20)), { name: 'TimeoutError' }); }
  finally { clearTimeout(timer); }
});

for (const mode of ['early', 'ack-first', 'wrong-ids', 'wrong-ids-post-ack', 'raw-good', 'fallback-model', 'delta', 'navigation', 'bounds', 'unsafe-urls']) {
  test(`hosted search real child: ${mode}, source projection and private cleanup`, async () => {
    const f = fixture(mode);
    const output = await runCodexSearch('Rust documentation', mode === 'navigation' ? 2 : 5, authSource(), AbortSignal.timeout(3000), f.options);
    f.assertClean();
    assert.ok(output.answer); assert.ok(output.answer.length <= 20_000);
    assert.ok(output.results.length <= 5); assert.doesNotMatch(JSON.stringify(output), /synthetic|wrong\.example|account-one/);
    for (const result of output.results) {
      assert.ok(result.title.length <= 500); assert.ok(result.snippet.length <= 2000); assert.ok(result.url.length <= 2048);
      assert.ok(!new URL(result.url).username);
    }
    if (mode === 'navigation') assert.deepEqual(output.results.map((row) => row.url), ['https://navigation.example/book', 'https://find.example/page']);
    else if (mode === 'delta') assert.equal(output.results[0]?.url, 'https://delta.example/docs');
    else if (mode === 'bounds') { assert.equal(output.answer.length, 20_000); assert.equal(output.results[0]?.title.length, 500); }
    else if (mode === 'unsafe-urls') assert.deepEqual(output.results.map((row) => row.url), ['https://safe.example/path']);
    else { assert.equal(output.results[0]?.title, 'Rust Book'); assert.equal(output.results[1]?.url, 'https://example.org/reference'); }
    assert.equal(f.requests.filter((request) => request.method === 'mcpServerStatus/list').length, 2);
    assert.equal(f.requests.some((request) => request.method === 'turn/interrupt'), false);
  });
}

for (const [mode, pattern] of [
  ['chat-only', /grounded/], ['only-wrong-ids', /grounded/], ['snapshot-search', /grounded/], ['empty-answer', /grounded/], ['no-sources', /source URLs/],
  ['invented-results', /hosted search item/], ['failed', /turn failed/], ['snapshot-tool', /tool activity/],
  ['pre-turn-tool', /tool activity before search/], ['token-reflection', /private authentication data/],
  ['raw-tool-function_call', /tool activity/], ['raw-tool-custom_tool_call', /tool activity/], ['raw-tool-local_shell_call', /tool activity/], ['tool-notification', /tool activity/],
  ['inherited-mcp', /Inherited Codex/], ['custom-provider', /Inherited Codex/], ['custom-endpoint', /Inherited Codex/],
  ['managed-hooks', /Managed Codex/], ['capability-override', /restrictions/], ['mcp-inventory', /MCP/], ['thread-mcp', /MCP/],
  ['inherited-account', /credentials/], ['old-version', /protocol/], ['network-enabled', /restrictions/], ['approval-enabled', /restrictions/],
  ['wrong-cwd', /restrictions/], ['instructions-loaded', /restrictions/], ['persistent-thread', /restrictions/],
  ['exit-initialize', /process exited/], ['exit-turn', /process exited/], ['malformed', /protocol frame/], ['rpc-error', /RPC failed/],
  ['oversize', /output exceeded/], ['early-flood', /early Codex/],
] as const) {
  test(`fails closed and cleans up real child: ${mode}`, async () => {
    const f = fixture(mode);
    await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(3000), f.options), (error: Error) => {
      assert.match(error.message, pattern); assert.doesNotMatch(error.message, /synthetic-private-token|must-not-run|not-openai/); return true;
    });
    f.assertClean();
    if (['inherited-mcp', 'custom-provider', 'custom-endpoint', 'managed-hooks', 'capability-override', 'mcp-inventory', 'inherited-account'].includes(mode)) {
      assert.equal(f.requests.some((request) => request.method === 'account/login/start'), false);
    }
  });
}

for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'imageView', 'imageGeneration', 'collabAgentToolCall', 'hookPrompt']) {
  test(`rejects unexpected tool item even with completed success: ${type}`, async () => {
    const f = fixture(`tool-${type}`);
    await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(3000), f.options), /tool activity/);
    f.assertClean();
  });
}
for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/call', 'mcpServer/elicitation/request']) {
  test(`rejects all server-initiated execution/approval requests: ${method}`, async () => {
    const f = fixture(`request-${method}`);
    await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(3000), f.options), /server request rejected/);
    f.assertClean();
  });
}

test('auth validation fails before launch, derives JWT account and cross-checks supplied headers', async () => {
  const good = authResult();
  const invalid: (AuthResult | undefined)[] = [undefined, { source: 'api key', auth: { apiKey: 'synthetic-api-key' } },
    { source: 'OAuth', auth: { apiKey: 'bad-token' } }, { ...good, auth: { ...good.auth, headers: { 'ChatGPT-Account-ID': 'different-account' } } },
    { ...good, auth: { ...good.auth, headers: { Authorization: 'Bearer different-token' } } }];
  for (const result of invalid) {
    let launched = false;
    await assert.rejects(runCodexSearch('Rust', 5, { ...authSource(), getAuth: async () => result }, AbortSignal.timeout(1000), {
      launch: () => { launched = true; throw new Error('should not launch'); },
    }), /OAuth authentication/);
    assert.equal(launched, false);
  }
  const f = fixture('early');
  await runCodexSearch('Rust', 1, authSource({ ...good, auth: { ...good.auth, headers: { 'ChatGPT-Account-ID': 'account-one' } } }), AbortSignal.timeout(3000), f.options);
  f.assertClean();
  await assert.rejects(runCodexSearch('Rust', 5, { ...authSource(), getAuth: async () => { throw new Error('Codex secret credential'); } }, AbortSignal.timeout(1000)),
    (error: Error) => { assert.doesNotMatch(error.message, /secret credential/); return true; });
});

test('bounded native refresh uses forceRefresh and enforces original account consistency', async () => {
  for (const mode of ['refresh', 'refresh-account-change', 'refresh-wrong-hint', 'refresh-loop']) {
    const f = fixture(mode), calls: boolean[] = [];
    const auth: CodexAuthSource = { ...authSource(), getAuth: async (_signal, force = false) => {
      calls.push(force); return authResult(mode === 'refresh-account-change' && force ? 'account-two' : 'account-one');
    } };
    if (mode === 'refresh') await runCodexSearch('Rust', 5, auth, AbortSignal.timeout(3000), f.options);
    else await assert.rejects(runCodexSearch('Rust', 5, auth, AbortSignal.timeout(3000), f.options), /server request rejected/);
    f.assertClean();
    assert.deepEqual(calls, mode === 'refresh-wrong-hint' ? [false] : mode === 'refresh-loop' ? [false, true, true] : [false, true]);
  }
});

for (const mode of ['cancel-before-ack', 'cancel-after-ack', 'ignore-interrupt', 'late-success', 'tree']) {
  test(`cancellation interrupts, awaits tree exit, then removes private dirs: ${mode}`, async () => {
    const controller = new AbortController();
    const f = fixture(mode, ({ method }) => { if (method === 'turn/start') setTimeout(() => controller.abort(), mode === 'tree' ? 100 : 20); });
    const started = Date.now();
    await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]), f.options), { name: 'AbortError' });
    f.assertClean();
    assert.ok(Date.now() - started < 2000);
    const interrupt = f.requests.find((request) => request.method === 'turn/interrupt');
    assert.ok(interrupt);
    assert.equal(interrupt.params.turnId, ['cancel-after-ack', 'late-success'].includes(mode) ? 'private-turn' : '');
    if (f.descendant) {
      await delay(20);
      assert.throws(() => process.kill(f.descendant!, 0), /ESRCH/);
    }
  });
}

test('cleanup waits through transient group permission errors without accepting persistent ones', async (t) => {
  for (const transient of [true, false]) {
    const controller = new AbortController();
    const f = fixture('cancel-after-ack', ({ method }) => { if (method === 'turn/start') setTimeout(() => controller.abort(), 20); });
    const kill = process.kill;
    let remaining = transient ? 2 : Infinity;
    t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
      if (pid === -f.child!.pid! && signal === 0 && remaining-- > 0) {
        throw Object.assign(new Error('synthetic group permission error'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    try {
      const search = runCodexSearch('Rust', 5, authSource(), AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]), f.options);
      if (transient) {
        await assert.rejects(search, { name: 'AbortError' });
        f.assertClean();
      } else {
        await assert.rejects(search, /process group.*(could not be verified|did not exit)/);
        assert.ok(f.child!.exitCode !== null || f.child!.signalCode !== null);
        assert.equal(existsSync(f.root), true, 'unverified process groups must retain their private directories');
      }
    } finally {
      t.mock.restoreAll();
      if (f.root) await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('deadline during startup is total; spawn errors and orphan stdio reject and clean up', async () => {
  const f = fixture('hang-initialize');
  await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(100), f.options), { name: 'TimeoutError' }); f.assertClean();
  let root = '';
  await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(3000), { launch(_command, _args, settings) {
    root = dirname(String(settings.cwd)); return spawn('/nonexistent-codex-test-executable', [], { ...settings, stdio: 'pipe' });
  } }), /could not start/);
  assert.equal(existsSync(root), false);
  for (const mode of ['orphan-exit', 'orphan-no-pipes']) {
    const orphan = fixture(mode), started = Date.now();
    await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(3000), orphan.options), /process exited/);
    orphan.assertClean(); assert.ok(Date.now() - started < 2000);
    await delay(30);
    assert.ok(orphan.descendant); assert.throws(() => process.kill(orphan.descendant!, 0), /ESRCH/);
  }
});

test('deadline cancels acknowledged turn and an auth refresh callback that ignores its signal', async () => {
  const turn = fixture('cancel-after-ack');
  await assert.rejects(runCodexSearch('Rust', 5, authSource(), AbortSignal.timeout(150), turn.options), { name: 'TimeoutError' });
  turn.assertClean();
  assert.equal(turn.requests.find((request) => request.method === 'turn/interrupt')?.params.turnId, 'private-turn');
  const refresh = fixture('refresh');
  let refreshSignal: AbortSignal | undefined;
  const auth: CodexAuthSource = { ...authSource(), getAuth: async (signal, force) => {
    if (!force) return authResult();
    refreshSignal = signal; return new Promise(() => {});
  } };
  await assert.rejects(runCodexSearch('Rust', 5, auth, AbortSignal.timeout(150), refresh.options), { name: 'TimeoutError' });
  refresh.assertClean(); assert.equal(refreshSignal?.aborted, true);
});

test('invalid input and pre-cancellation do not resolve auth or launch a process', async () => {
  const auth: CodexAuthSource = { ...authSource(), getAuth: async () => { throw new Error('must not resolve'); } };
  for (const [query, count] of [['', 5], ['x'.repeat(1001), 5], ['Rust', 0], ['Rust', 11], ['Rust', 1.5]] as const) {
    await assert.rejects(runCodexSearch(query, count, auth, new AbortController().signal), /Invalid Codex search input/);
  }
  await assert.rejects(runCodexSearch('Rust', 5, auth, AbortSignal.abort()), { name: 'AbortError' });
});

test('packaged 0.160.0 binary attests initialize, unauthenticated model/list and restricted thread/start without turn/start', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tmc-codex-protocol-'))), home = join(root, 'home'), cwd = join(root, 'workspace');
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
  const child = spawn(process.execPath, [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), 'app-server', '--listen', 'stdio://',
    ...Object.entries(required).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`])],
  { cwd, env: { HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin', TMPDIR: root, TMP: root, TEMP: root },
    detached: true, stdio: 'pipe' });
  let id = 0, buffer = '';
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stderr.resume();
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString(); let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const entry = pending.get(value.id); if (!entry) continue;
      pending.delete(value.id); value.error ? entry.reject(new Error('Packaged protocol RPC failed')) : entry.resolve(value.result);
    }
  });
  child.on('error', () => { for (const entry of pending.values()) entry.reject(new Error('Packaged binary unavailable')); });
  child.on('exit', () => { for (const entry of pending.values()) entry.reject(new Error('Packaged binary exited')); });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  const deadline = setTimeout(terminate, 8000);
  try {
    const init = await request('initialize', { clientInfo: { name: 'teachme_hosted_search', title: 'TeachMeCoding', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    assert.match(init.userAgent, /^teachme_hosted_search\/0\.160\.0 /); assert.equal(init.serverVersion, undefined); assert.equal(init.codexHome, home);
    child.stdin.write('{"method":"initialized"}\n');
    const config = (await request('config/read', { cwd, includeLayers: true })).config;
    for (const [path, expected] of Object.entries(required)) {
      let value = config; for (const key of path.split('.')) value = value[key]; assert.deepEqual(value, expected);
    }
    assert.deepEqual(config.mcp_servers, {}); assert.deepEqual(config.model_providers, {});
    assert.equal((await request('account/read', { refreshToken: false })).account, null);
    assert.deepEqual((await request('mcpServerStatus/list', { limit: null, cursor: null })).data, []);
    const models = (await request('model/list', { limit: null, cursor: null, includeHidden: false })).data;
    const model = models.find((value: any) => value.isDefault && value.inputModalities.includes('text')) ?? models.find((value: any) => value.inputModalities.includes('text'));
    assert.ok(model?.model);
    const started = await request('thread/start', { model: model.model, modelProvider: 'openai', cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
      environments: [], dynamicTools: [], experimentalRawEvents: true, developerInstructions: 'Bounded web-search worker: use hosted web_search, return concise grounded answer with source URLs, no other tools/files/follow-ups', config: required });
    assert.equal(started.thread.cliVersion, '0.160.0'); assert.equal(started.cwd, cwd); assert.equal(started.thread.cwd, cwd);
    assert.deepEqual(started.sandbox, { type: 'readOnly', networkAccess: false }); assert.equal(started.approvalPolicy, 'never');
    assert.equal(started.thread.ephemeral, true); assert.equal(started.thread.path, null); assert.deepEqual(started.thread.environments, []);
    assert.deepEqual(started.instructionSources, []); assert.equal(existsSync(join(home, 'auth.json')), false);
  } finally {
    clearTimeout(deadline); child.stdin.end();
    if (child.pid) await stopProcesses(descendants(child.pid));
    await exited; await rm(root, { recursive: true, force: true });
  }
});

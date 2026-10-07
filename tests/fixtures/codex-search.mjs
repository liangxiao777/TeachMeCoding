// Deterministic real stdio child; never uses network or real credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2], config = { mcp_servers: {}, model_providers: {} };
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] !== '-c') continue;
  const entry = process.argv[++i], split = entry.indexOf('='), keys = entry.slice(0, split).split('.');
  let parent = config;
  for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
  parent[keys.at(-1)] = JSON.parse(entry.slice(split + 1));
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const note = (method, params) => send({ method, params });
const threadId = 'private-thread', turnId = 'private-turn';
let loggedIn = false, initialized = false, pendingTurn, refreshCount = 0, suppliedAccessToken;

if (['ignore-interrupt', 'late-success', 'tree'].includes(mode)) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (mode === 'tree' || mode === 'orphan-exit') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  note('fixture/descendant', { pid: descendant.pid });
}
if (mode === 'orphan-no-pipes') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  note('fixture/descendant', { pid: descendant.pid });
}

function item(value, ids = {}) {
  note('item/completed', { threadId, turnId, item: value, ...ids });
}
function finish() {
  if (mode.startsWith('wrong-ids')) {
    item({ type: 'commandExecution', id: 'wrong-thread-tool' }, { threadId: 'other-thread' });
    item({ type: 'fileChange', id: 'wrong-turn-tool' }, { turnId: 'other-turn' });
    note('item/commandExecution/outputDelta', { threadId, turnId: 'other-turn', delta: 'wrong command' });
    note('rawResponseItem/completed', { threadId, turnId: 'other-turn', item: { type: 'function_call', name: 'exec_command' } });
    item({ type: 'agentMessage', id: 'wrong-message', text: 'Wrong https://wrong.example/' }, { turnId: 'other-turn' });
    note('turn/completed', { threadId, turn: { id: 'other-turn', status: 'failed', items: [] } });
  }
  if (mode === 'only-wrong-ids') {
    item({ type: 'webSearch', id: 'wrong-search', results: null, action: { type: 'search', query: 'wrong', queries: null } }, { turnId: 'other-turn' });
    item({ type: 'agentMessage', id: 'answer', text: 'Wrong https://wrong.example/' });
  } else {
    if (mode !== 'chat-only' && mode !== 'snapshot-search') {
      item({ type: 'webSearch', id: 'search', query: 'Rust', results: mode === 'invented-results' ? [{ url: 'https://invented.example/' }] : null,
        action: { type: 'search', query: 'Rust', queries: ['Rust', 'Rust book'] } });
    }
    if (mode === 'navigation') {
      item({ type: 'webSearch', id: 'open', query: '', results: null, action: { type: 'openPage', url: 'https://navigation.example/book' } });
      item({ type: 'webSearch', id: 'find', query: '', results: null, action: { type: 'findInPage', url: 'https://find.example/page', pattern: 'ownership' } });
    }
    let text = 'Read [Rust Book](https://doc.rust-lang.org/book/). Also https://example.org/reference.';
    if (mode === 'empty-answer') text = '   ';
    if (mode === 'no-sources') text = 'An answer without sources.';
    if (mode === 'token-reflection') text = `Private ${suppliedAccessToken} https://example.org/`;
    if (mode === 'bounds') text = `[${'T'.repeat(700)}](https://safe.example/book) ${'x'.repeat(21_000)}`;
    if (mode === 'unsafe-urls') text = 'Bad [user](https://user:password@bad.example/) [script](javascript:alert(1)) and https://user:password@bad.example/. Good [safe](https://safe.example/path).';
    if (mode === 'delta') {
      note('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: 'Read https://delta.example/docs.' });
    } else item({ type: 'agentMessage', id: 'answer', text });
  }
  if (mode.startsWith('tool-') && mode !== 'tool-notification') {
    note('item/started', { threadId, turnId, item: { type: mode.slice(5), id: 'forbidden' } });
  }
  if (mode === 'raw-good') note('rawResponseItem/completed', { threadId, turnId, item: { type: 'web_search_call', id: 'raw-search' } });
  if (mode.startsWith('raw-tool-')) note('rawResponseItem/completed', { threadId, turnId, item: { type: mode.slice(9), name: 'exec_command' } });
  if (mode === 'tool-notification') note('item/commandExecution/outputDelta', { threadId, turnId, delta: 'forbidden' });
  const items = mode === 'snapshot-search' ? [{ type: 'webSearch', id: 'snapshot', results: null, action: { type: 'search', query: 'Rust', queries: null } }]
    : mode === 'snapshot-tool' ? [{ type: 'commandExecution', id: 'hidden-command' }] : [];
  note('turn/completed', { threadId, turn: { id: turnId, status: mode === 'failed' ? 'failed' : 'completed', error: null, items } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = JSON.parse(line), { id, method, params = {} } = message;
    if (!method) {
      if (id === 'refresh-request' && message.result) {
        assert.equal(message.result.chatgptAccountId, 'account-one');
        assert.equal(message.result.chatgptPlanType, null);
        if (mode === 'refresh-loop' && ++refreshCount < 3) {
          send({ id: 'refresh-request', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: 'account-one' } });
        } else { finish(); reply(pendingTurn, { turn: { id: turnId, status: 'inProgress' } }); }
      }
      return;
    }
    // Safe, synthetic transcript. Auth tokens are never emitted, even in fixtures.
    note('fixture/request', { method, params: method === 'account/login/start' ? { type: params.type, chatgptAccountId: params.chatgptAccountId } : params });
    switch (method) {
      case 'initialize':
        assert.deepEqual(params, { clientInfo: { name: 'teachme_hosted_search', title: 'TeachMeCoding', version: '1.0.0' }, capabilities: { experimentalApi: true } });
        if (mode === 'exit-initialize') return process.exit(17);
        if (mode === 'malformed') return process.stdout.write('{not-json}\n');
        if (mode === 'hang-initialize') return;
        reply(id, { userAgent: `teachme_hosted_search/${mode === 'old-version' ? '0.159.0' : '0.160.0'} (fixture)`, codexHome: process.env.CODEX_HOME });
        break;
      case 'initialized': initialized = true; break;
      case 'config/read': {
        assert.ok(initialized);
        if (mode === 'pre-turn-tool') note('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'unexpected-startup' } });
        if (mode === 'inherited-mcp') config.mcp_servers.secret_server = { command: 'must-not-run' };
        if (mode === 'custom-provider') config.model_providers.openai = { base_url: 'https://not-openai.example/' };
        if (mode === 'capability-override') config.features.shell_tool = true;
        if (mode === 'custom-endpoint') config.openai_base_url = 'https://not-openai.example/';
        reply(id, { config }); break;
      }
      case 'configRequirements/read': reply(id, { requirements: mode === 'managed-hooks' ? { hooks: {} } : null }); break;
      case 'mcpServerStatus/list':
        reply(id, { data: mode === 'mcp-inventory' || (mode === 'thread-mcp' && params.threadId) ? [{ name: 'hidden-server' }] : [], nextCursor: null }); break;
      case 'account/read':
        assert.equal(params.refreshToken, false);
        reply(id, { account: loggedIn || mode === 'inherited-account' ? { type: 'chatgpt', email: null, planType: 'unknown' } : null, requiresOpenaiAuth: true }); break;
      case 'account/login/start':
        assert.equal(params.type, 'chatgptAuthTokens'); assert.equal(params.chatgptAccountId, 'account-one'); assert.equal(params.chatgptPlanType, null);
        assert.equal(params.accessToken.split('.').length, 3);
        assert.equal(existsSync(process.env.CODEX_HOME + '/auth.json'), false);
        suppliedAccessToken = params.accessToken;
        loggedIn = true; reply(id, { type: 'chatgptAuthTokens' }); break;
      case 'model/list':
        assert.deepEqual(params, { limit: null, cursor: null, includeHidden: false });
        reply(id, { data: [
          { id: 'image-default', model: 'image-only', inputModalities: ['image'], isDefault: true },
          { id: 'not-wire-id', model: 'hosted-text-first', inputModalities: ['text'], isDefault: false },
          { id: 'also-not-wire-id', model: 'hosted-text-default', inputModalities: ['text'], isDefault: mode !== 'fallback-model' },
        ], nextCursor: null }); break;
      case 'thread/start':
        assert.deepEqual(params.environments, []); assert.deepEqual(params.dynamicTools, []);
        assert.equal(params.ephemeral, true); assert.equal(params.approvalPolicy, 'never'); assert.equal(params.sandbox, 'read-only');
        assert.equal(params.cwd, process.cwd()); assert.equal(params.modelProvider, 'openai');
        assert.equal(params.model, mode === 'fallback-model' ? 'hosted-text-first' : 'hosted-text-default');
        assert.equal(params.experimentalRawEvents, true); assert.match(params.developerInstructions, /hosted web_search/);
        for (const key of ['userInstructions', 'baseInstructions', 'skills', 'projectId', 'selectedCapabilityRoots']) assert.equal(key in params, false);
        for (const [path, expected] of Object.entries(params.config)) {
          let value = config; for (const key of path.split('.')) value = value[key]; assert.deepEqual(value, expected);
        }
        reply(id, { thread: { id: threadId, cwd: params.cwd, cliVersion: '0.160.0', ephemeral: mode !== 'persistent-thread', path: null, modelProvider: 'openai', environments: [] },
          model: params.model, modelProvider: 'openai', cwd: mode === 'wrong-cwd' ? '/outside' : params.cwd,
          sandbox: { type: 'readOnly', networkAccess: mode === 'network-enabled' }, approvalPolicy: mode === 'approval-enabled' ? 'on-request' : 'never',
          instructionSources: mode === 'instructions-loaded' ? ['/outside/AGENTS.md'] : [] }); break;
      case 'turn/start':
        assert.deepEqual(Object.keys(params).sort(), ['approvalPolicy', 'effort', 'input', 'threadId']);
        assert.equal(params.threadId, threadId); assert.equal(params.effort, 'low'); assert.equal(params.approvalPolicy, 'never');
        assert.equal(params.input[0].type, 'text'); assert.deepEqual(params.input[0].text_elements, []);
        pendingTurn = id;
        if (mode === 'orphan-exit' || mode === 'exit-turn') return process.exit(19);
        if (mode === 'orphan-no-pipes') return setTimeout(() => process.exit(19), 100);
        if (mode === 'rpc-error') { process.stderr.write('synthetic-private-token\n'); return send({ id, error: { code: -32000, message: 'synthetic-private-token' } }); }
        if (mode === 'oversize') return process.stdout.write('x'.repeat(1024 * 1024 + 1));
        if (mode === 'early-flood') {
          for (let i = 0; i < 300; i++) note('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: 'a' });
          return;
        }
        if (mode.startsWith('request-')) return send({ id: 'forbidden-request', method: mode.slice(8), params: { threadId, turnId } });
        if (mode.startsWith('refresh')) return send({ id: 'refresh-request', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: mode === 'refresh-wrong-hint' ? 'account-two' : 'account-one' } });
        if (mode === 'cancel-before-ack' || mode === 'ignore-interrupt' || mode === 'tree') return;
        if (mode === 'cancel-after-ack' || mode === 'late-success') { reply(id, { turn: { id: turnId, status: 'inProgress' } }); return; }
        if (mode === 'ack-first' || mode === 'wrong-ids-post-ack') { reply(id, { turn: { id: turnId, status: 'inProgress' } }); return setTimeout(finish, 10); }
        // Deliberately deliver the entire completed turn BEFORE its RPC ack.
        finish(); reply(id, { turn: { id: turnId, status: 'inProgress' } }); break;
      case 'turn/interrupt':
        assert.equal(params.threadId, threadId);
        if (mode === 'ignore-interrupt') return;
        if (mode === 'late-success') finish();
        reply(id, {}); break;
      default: throw new Error('Unexpected fixture request');
    }
  } catch {
    process.stderr.write('fixture assertion failed (details intentionally private)\n');
    process.exit(41);
  }
});

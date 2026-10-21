import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioTransport } from '@earendil-works/pi-mcp';
import { Agent } from '@earendil-works/pi-agent-core';
import { McpService, mcpToolName } from './mcp.js';
import { reply, response, teachingModel, syntheticSource } from '../agents/test-support.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';

const fixture = fileURLToPath(new URL('../../../../tests/fixtures/mcp-server.mjs', import.meta.url));
const config = { command: process.execPath, args: [fixture] };
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'tmc-mcp-')));

test('failed MCP connections expose semantic status without stderr or credentials and reconnect clears the error', async () => {
  const root = temporary();
  const service = new McpService(join(root, 'mcp.json'), { cwd: root });
  try {
    await service.save({ mcpServers: { broken: { command: process.execPath,
      args: ['-e', 'process.stderr.write("PRIVATE-MCP-RESPONSE " + process.env.TOKEN); process.exit(1)'],
      env: { TOKEN: 'synthetic-private-mcp-key' } } } });
    assert.deepEqual(await service.tools(), []);
    const failed = service.settings().servers[0]!;
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.error, { code: 'MCP_CONNECTION_FAILED' });
    assert.equal('errorDetail' in failed, false);
    assert.deepEqual(failed.tools, []);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-MCP-RESPONSE|synthetic-private-mcp-key|process\.stderr/);
    assert.equal(service.settings().configuration.mcpServers.broken!.env!.TOKEN, '••••••••');
    await service.saveServer({ name: 'broken', configuration: config }, 'broken');
    assert.equal((await service.tools()).length, 4);
    const connected = service.settings().servers[0]!;
    assert.equal(connected.state, 'connected');
    assert.equal(connected.error, null);
    assert.equal('errorDetail' in connected, false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real stdio tools preserve schemas, structured content, error state and cancellation', async () => {
  const root = temporary();
  const service = new McpService(join(root, 'mcp.json'), { cwd: root });
  try {
    await service.save({ mcpServers: { arithmetic: config } });
    const tools = await service.tools();
    assert.equal(service.settings().servers[0]!.state, 'connected');
    assert.equal(tools.length, 4);
    const subtract = tools.find((tool) => tool.name === mcpToolName('arithmetic', 'subtract'))!;
    const result = await subtract.execute('a', { left: 19, right: 7 });
    assert.deepEqual(result.structuredContent, { difference: 12 });
    assert.deepEqual(result.content, [{ type: 'text', text: '12' }]);
    assert.equal(result.isError, false);
    const failure = await tools.find((tool) => tool.name === mcpToolName('arithmetic', 'fail'))!.execute('b', {});
    assert.equal(failure.isError, true);
    const controller = new AbortController();
    const waiting = tools.find((tool) => tool.name === mcpToolName('arithmetic', 'wait'))!.execute('c', {}, controller.signal);
    controller.abort();
    await assert.rejects(waiting, /取消/);
    // The server remains usable after one cancelled request.
    assert.deepEqual((await subtract.execute('d', { left: 4, right: 9 })).structuredContent, { difference: -5 });
    let requests = 0;
    const agent = new Agent({ initialState: { model: teachingModel, tools }, streamFn: () => {
      requests++;
      return response(requests === 1 ? reply([{ type: 'toolCall', id: 'invalid', name: subtract.name, arguments: { left: 'not a number', right: 7 } }], 'toolUse')
        : reply([{ type: 'text', text: 'The invalid arguments were rejected.' }]));
    } });
    await agent.prompt('invalid');
    const rejected = agent.state.messages.find((m) => m.role === 'toolResult');
    assert.ok(rejected?.role === 'toolResult' && rejected.isError, 'Pi must validate the dynamic MCP schema, not only the fixture server');
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('teaching runtime exposes MCP tools on every turn and records their native results', async () => {
  const root = temporary(), db = openDatabase(':memory:');
  const mcp = new McpService(join(root, 'mcp.json'), { cwd: root });
  let calls = 0;
  const tool = mcpToolName('arithmetic', 'subtract');
  const agents = new TeachingRuntime(new Learning(db), syntheticSource, { mcp, stream: (_model, context) => {
    const system = context.messages.find((m) => m.role === 'system'); assert.ok(system?.role === 'system');
    assert.ok(system.toolsAdded?.some((t) => t.name === tool));
    assert.ok(system.toolsAdded?.some((t) => t.name === 'submit_requirement_draft'));
    if (++calls === 1) return response(reply([{ type: 'toolCall', id: 'mcp-call', name: tool, arguments: { left: 31, right: 14 } }], 'toolUse'));
    const result = context.messages.find((m) => m.role === 'toolResult' && m.toolName === tool);
    assert.ok(result?.role === 'toolResult'); assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: 'text', text: '17' }]);
    return response(reply([{ type: 'text', text: '31 − 14 = 17' }]));
  } });
  try {
    await mcp.save({ mcpServers: { arithmetic: config } });
    const space = agents.createSpace(randomUUID(), { name: 'Arithmetic', goal: 'Use the subtract tool.' });
    const run = space.runs[0]!; await agents.idle(run.id);
    assert.equal(agents.get(space.id, run.id).state, 'succeeded');
    assert.equal(calls, 2);
    const messages = db.prepare('SELECT value FROM agent_messages WHERE run_id=?').all(run.id) as { value: string }[];
    assert.ok(messages.map((row) => JSON.parse(row.value)).some((m) => m.role === 'toolResult' && m.toolName === tool && !m.isError));
    assert.ok(agents.events(space.id, run.id).events.some((event) => event.data.type === 'tool' && event.data.name === tool && event.data.phase === 'start'));
  } finally { await Promise.all([agents.close(), mcp.close()]); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('configuration survives reopening, masks secrets, and disabled servers never spawn', async () => {
  const root = temporary(), path = join(root, 'mcp.json');
  const previousAmbient = process.env.TMC_AMBIENT_SECRET;
  process.env.TMC_AMBIENT_SECRET = 'ambient-secret-must-not-reach-child';
  let service = new McpService(path, { cwd: root });
  try {
    const saved = await service.save({ mcpServers: { local: { ...config, env: { TMC_FIXTURE_TOKEN: 'explicit-env-token' } },
      disabled: { command: '/does/not/exist', env: { KEY: 'synthetic-private-key' }, enabled: false } } });
    assert.ok(!JSON.stringify(saved).includes('synthetic-private-key'));
    assert.equal(saved.configuration.mcpServers.disabled!.env!.KEY, '••••••••');
    const environment = (await service.tools()).find((tool) => tool.name === mcpToolName('local', 'environment'))!;
    const result = await environment.execute('env', {});
    assert.equal(result.content[0]!.type, 'text');
    if (result.content[0]!.type === 'text') assert.deepEqual(JSON.parse(result.content[0]!.text), { explicit: 'explicit-env-token', ambient: null, cwd: root });
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    await service.save(service.settings().configuration);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.disabled.env.KEY, 'synthetic-private-key', 'masked round-trip must not overwrite a credential');
    await service.close();
    service = new McpService(path, { cwd: root });
    assert.equal((await service.tools()).length, 4);
    assert.equal(service.settings().servers.find((server) => server.name === 'disabled')!.state, 'disabled');
    await assert.rejects(async () => service.save({ mcpServers: { bad: { command: 'node', url: 'http://localhost/mcp' } } }));
    assert.equal((await service.tools()).length, 4, 'failed validation must preserve working configuration');
    await service.save({ mcpServers: {} });
    assert.deepEqual(await service.tools(), []);
  } finally {
    if (previousAmbient === undefined) delete process.env.TMC_AMBIENT_SECRET; else process.env.TMC_AMBIENT_SECRET = previousAmbient;
    await service.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP authentication, discovery and calls use the real Streamable HTTP transport', async () => {
  const root = temporary();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-http-key');
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end(); return; }
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body); requests.push(message.method);
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [], structuredContent: { transport: 'http' } };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = new McpService(join(root, 'mcp.json'), { cwd: root });
  try {
    await service.save({ mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer synthetic-http-key' } } } });
    const [tool] = await service.tools(); assert.ok(tool);
    const result = await tool.execute('http', {});
    assert.deepEqual(result.structuredContent, { transport: 'http' });
    assert.equal(result.content[0]?.type, 'text');
    if (result.content[0]?.type === 'text') assert.deepEqual(JSON.parse(result.content[0].text), { transport: 'http' });
    assert.ok(requests.includes('tools/call'));
  } finally { await service.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test('names remain distinct after sanitization/truncation and owned child processes exit', async () => {
  assert.notEqual(mcpToolName('same-a', 'same b'), mcpToolName('same_a', 'same-b'));
  assert.notEqual(mcpToolName('x'.repeat(100), 'a'), mcpToolName('x'.repeat(100), 'b'));
  assert.ok(mcpToolName('x'.repeat(100), 'y'.repeat(100)).length <= 64);
  const root = temporary(); let transport: StdioTransport | undefined;
  const service = new McpService(join(root, 'mcp.json'), { cwd: root,
    transport: (config) => transport = new StdioTransport({ command: config.command!, args: config.args, cwd: root, inheritEnv: false }) });
  try {
    await service.save({ mcpServers: { owned: config } }); await service.tools();
    const pid = transport!.pid!; assert.ok(pid);
    await service.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('single-server writes preserve concurrent additions and masked credentials through rename', async () => {
  const root = temporary(), path = join(root, 'mcp.json');
  const service = new McpService(path, { cwd: root });
  try {
    await Promise.all([
      service.saveServer({ name: 'docs', configuration: { url: 'https://example.invalid/mcp', enabled: false,
        headers: { Authorization: 'Bearer synthetic-rename-secret' }, timeout: 13 } }),
      service.saveServer({ name: 'files', configuration: { command: '/not-started', enabled: false, env: { TOKEN: 'synthetic-files-secret' } } }),
    ]);
    const before = service.settings().configuration.mcpServers;
    assert.deepEqual(Object.keys(before).sort(), ['docs', 'files']);
    await service.saveServer({ name: 'docs', configuration: { ...before.docs, timeout: 14 } }, 'docs');
    assert.deepEqual(service.settings().servers.map((server) => server.name), ['docs', 'files'], 'editing must not move a row to the end');
    await service.saveServer({ name: 'documentation', configuration: before.docs }, 'docs');
    const stored = JSON.parse(readFileSync(path, 'utf8')).mcpServers;
    assert.equal(stored.documentation.headers.Authorization, 'Bearer synthetic-rename-secret');
    assert.equal(stored.documentation.timeout, 13);
    assert.equal(stored.files.env.TOKEN, 'synthetic-files-secret');
    assert.equal(stored.docs, undefined);
    assert.ok(!JSON.stringify(service.settings()).includes('synthetic-rename-secret'));
    await assert.rejects(service.saveServer({ name: 'files', configuration: before.docs }, 'documentation'), { message: 'MCP_SERVER_NAME_CONFLICT' });
    await assert.rejects(service.saveServer({ name: 'new', configuration: before.docs }), { message: 'MCP_SECRET_REQUIRED' });
    await assert.rejects(service.saveServer({ name: 'missing', configuration: before.files }, 'missing'), { message: 'MCP_SERVER_NOT_FOUND' });
    await assert.rejects(service.removeServer('missing'), { message: 'MCP_SERVER_NOT_FOUND' });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers, stored, 'rejected writes must leave all servers unchanged');
    await service.removeServer('documentation');
    assert.deepEqual(Object.keys(service.settings().configuration.mcpServers), ['files']);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('reconnecting and deleting one server leaves the other live transport untouched', async () => {
  const root = temporary();
  const transports = new Map<string, StdioTransport[]>();
  const service = new McpService(join(root, 'mcp.json'), { cwd: root, transport: (entry) => {
    const name = entry.env!.FIXTURE_NAME!;
    const transport = new StdioTransport({ command: entry.command!, args: entry.args, cwd: root, inheritEnv: false });
    transports.set(name, [...transports.get(name) ?? [], transport]); return transport;
  } });
  try {
    for (const name of ['first', 'second']) await service.saveServer({ name, configuration: { ...config, env: { FIXTURE_NAME: name } } });
    await service.tools();
    const firstPid = transports.get('first')![0]!.pid!, secondPid = transports.get('second')![0]!.pid!;
    await assert.rejects(service.reconnect('missing'), { message: 'MCP_SERVER_NOT_FOUND' });
    await service.reconnect('first'); await service.tools();
    assert.equal(transports.get('first')!.length, 2);
    assert.equal(transports.get('second')!.length, 1);
    assert.equal(transports.get('second')![0]!.pid, secondPid);
    assert.throws(() => process.kill(firstPid, 0), /ESRCH/);
    const currentFirstPid = transports.get('first')![1]!.pid!;
    await service.removeServer('second');
    assert.throws(() => process.kill(secondPid, 0), /ESRCH/);
    assert.equal(transports.get('first')![1]!.pid, currentFirstPid);
    assert.equal((await service.tools()).length, 4);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stopping during MCP initialization does not wait for the connection timeout', async () => {
  const root = temporary(), db = openDatabase(':memory:');
  const mcp = new McpService(join(root, 'mcp.json'), { cwd: root });
  let calls = 0;
  const agents = new TeachingRuntime(new Learning(db), syntheticSource, { mcp, stream: () => {
    calls++; return response(reply([{ type: 'text', text: 'should not be called' }]));
  } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await mcp.save({ mcpServers: { hanging: { ...config, args: [fixture, '--hold-init'], timeout: 5 } } });
    const space = agents.createSpace(randomUUID(), { name: 'Cancel', goal: 'Do not launch a model request.' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = space.runs[0]!;
    agents.stop(space.id, run.id);
    await Promise.race([agents.idle(run.id), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Cancellation waited for MCP initialization.')), 1000); })]);
    assert.equal(agents.get(space.id, run.id).state, 'interrupted');
    assert.equal(calls, 0);
  } finally { clearTimeout(timeout); await Promise.all([agents.close(), mcp.close()]); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy environment references fail only their server, reject new references and remain removable or repairable', async () => {
  const root = temporary(), path = join(root, 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: {
    legacy: { ...config, env: { TMC_FIXTURE_TOKEN: '${SYNTHETIC_TOKEN}' } },
    healthy: config,
    disabled: { url: 'https://example.invalid/mcp', enabled: false, headers: { Authorization: 'Bearer ${HTTP_TOKEN}' } },
  } }));
  const service = new McpService(path, { cwd: root });
  try {
    assert.equal((await service.tools()).length, 4);
    const initial = service.settings();
    assert.deepEqual(initial.servers.find((server) => server.name === 'legacy')?.error, { code: 'MCP_ENV_REFERENCE_UNSUPPORTED' });
    assert.equal(initial.servers.find((server) => server.name === 'disabled')?.state, 'disabled');
    assert.doesNotMatch(JSON.stringify(initial), /SYNTHETIC_TOKEN|HTTP_TOKEN/);
    await service.save(initial.configuration);
    await service.saveServer({ name: 'healthy', configuration: { ...config, timeout: 9 } }, 'healthy');
    const before = readFileSync(path, 'utf8');
    for (const configuration of [{ ...config, env: { TOKEN: '${NEW_TOKEN}' } },
      { url: 'https://example.invalid/mcp', enabled: false, headers: { Authorization: 'Bearer ${NEW_TOKEN}' } }]) {
      await assert.rejects(service.saveServer({ name: 'new', configuration }), { message: 'MCP_ENV_REFERENCE_UNSUPPORTED' });
    }
    assert.equal(readFileSync(path, 'utf8'), before);
    await service.removeServer('disabled');
    await service.saveServer({ name: 'legacy', configuration: { ...config, env: { TMC_FIXTURE_TOKEN: 'literal-replacement' } } }, 'legacy');
    const tools = await service.tools(); assert.equal(tools.length, 8);
    const environment = tools.find((tool) => tool.name === mcpToolName('legacy', 'environment'))!;
    const result = await environment.execute('repaired', {});
    assert.ok(result.content[0]?.type === 'text');
    assert.equal(JSON.parse(result.content[0].text).explicit, 'literal-replacement');
    assert.equal(service.settings().servers.find((server) => server.name === 'legacy')?.error, null);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

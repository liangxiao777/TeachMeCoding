import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
const noenv = () => undefined;
const config = { command: process.execPath, args: [fixture] };
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'tmc-mcp-')));

test('real stdio tools preserve schemas, structured content, error state and cancellation', async () => {
  const root = temporary();
  const service = new McpService(join(root, 'mcp.json'), { env: noenv, cwd: root });
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
  const mcp = new McpService(join(root, 'mcp.json'), { env: noenv, cwd: root });
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
  let service = new McpService(path, { env: (name) => name === 'SYNTHETIC_TOKEN' ? 'explicit-env-token' : undefined, cwd: root });
  try {
    const saved = await service.save({ mcpServers: { local: { ...config, env: { TMC_FIXTURE_TOKEN: '${SYNTHETIC_TOKEN}' } },
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
    service = new McpService(path, { env: () => 'explicit-env-token', cwd: root });
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
  const service = new McpService(join(root, 'mcp.json'), { env: () => 'synthetic-http-key', cwd: root });
  try {
    await service.save({ mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer ${HTTP_TOKEN}' } } } });
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
  const service = new McpService(join(root, 'mcp.json'), { env: noenv, cwd: root,
    transport: (config) => transport = new StdioTransport({ command: config.command!, args: config.args, cwd: root, inheritEnv: false }) });
  try {
    await service.save({ mcpServers: { owned: config } }); await service.tools();
    const pid = transport!.pid!; assert.ok(pid);
    await service.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stopping during MCP initialization does not wait for the connection timeout', async () => {
  const root = temporary(), db = openDatabase(':memory:');
  const mcp = new McpService(join(root, 'mcp.json'), { env: noenv, cwd: root });
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

import { createInterface } from 'node:readline';

// Disposable protocol peer: exercise the real Pi transports without network dependencies.
const pending = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const tools = [
  { name: 'subtract', description: 'Subtract right from left.', inputSchema: { type: 'object', properties: {
    left: { type: 'number' }, right: { type: 'number' },
  }, required: ['left', 'right'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { difference: { type: 'number' } }, required: ['difference'] } },
  { name: 'wait', description: 'Wait until cancelled.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Report a tool-level error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'environment', description: 'Inspect synthetic test environment.', inputSchema: { type: 'object', properties: {} } },
];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') {
    const timer = pending.get(message.params.requestId);
    if (timer) { clearTimeout(timer); pending.delete(message.params.requestId); }
    continue;
  }
  if (!('id' in message)) continue;
  const { id, method, params } = message;
  if (method === 'initialize' && process.argv.includes('--hold-init')) continue;
  if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'synthetic-fixture', version: '1' } } });
  else if (method === 'tools/list') send({ id, result: { tools } });
  else if (method === 'tools/call') {
    if (params.name === 'wait') { pending.set(id, setTimeout(() => send({ id, result: { content: [{ type: 'text', text: 'late' }] } }), 10000)); continue; }
    const difference = params.arguments?.left - params.arguments?.right;
    const result = params.name === 'subtract' ? { content: [{ type: 'text', text: String(difference) }], structuredContent: { difference } }
      : params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'synthetic tool failed' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ explicit: process.env.TMC_FIXTURE_TOKEN, ambient: process.env.TMC_AMBIENT_SECRET ?? null, cwd: process.cwd() }) }] };
    send({ id, result });
  } else send({ id, error: { code: -32601, message: 'Unknown fixture method' } });
}
for (const timer of pending.values()) clearTimeout(timer);

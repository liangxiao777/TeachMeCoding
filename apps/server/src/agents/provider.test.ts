import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, normalizeContext, Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { createProviderAgent } from './provider.js';
import { providerStream } from './model.js';
import type { ModelSource } from '../models/service.js';
import { syntheticSource, teachingModel } from './test-support.js';

const selection = { provider: 'openrouter', model: 'exact/configured-id', thinkingLevel: 'high' as const };
const exact = { ...teachingModel, id: selection.model, name: selection.model };
const source: ModelSource = {
  ...syntheticSource,
  current: () => ({ selection, model: exact }),
  resolve: (s) => s.provider === selection.provider && s.model === selection.model ? exact : undefined,
};
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', api: 'openai-completions', provider: 'openrouter', model: selection.model,
    content, stopReason, timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function stream(message: AssistantMessage) {
  const result = createAssistantMessageEventStream();
  result.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === 'text') {
      result.push({ type: 'text_start', contentIndex, partial: { ...message, content: [{ type: 'text', text: '' }] } });
      result.push({ type: 'text_delta', contentIndex, delta: content.text, partial: message });
      result.push({ type: 'text_end', contentIndex, content: content.text, partial: message });
    }
  }
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    result.push({ type: 'error', reason: message.stopReason, error: message });
  } else {
    assert.notEqual(message.stopReason, 'pending');
    result.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
  }
  return result;
}

test('exact model and private key reach the stream; text and terminal lifecycle reach the subscriber', async () => {
  const events: AgentEvent[] = [];
  const agent = createProviderAgent(source, selection, { streamFn: (model, _context, options) => {
    assert.equal(model.id, 'exact/configured-id');
    assert.equal(model.provider, 'openrouter');
    assert.equal(options?.reasoning, 'high');
    assert.ok(options?.signal);
    return stream(message([{ type: 'text', text: 'hello 42' }]));
  } });
  agent.subscribe((event) => { events.push(event); });
  await agent.prompt('check');
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.deepEqual(last.content, [{ type: 'text', text: 'hello 42' }]);
  assert.ok(events.some((event) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta'));
  assert.equal(events[0]?.type, 'agent_start');
  assert.equal(events.at(-1)?.type, 'agent_end');
  assert.equal(agent.state.isStreaming, false);
  assert.ok(!JSON.stringify(events).includes('synthetic-private-key'));
});

test('smoke keeps selected reasoning while pi-ai applies its output ceiling before transport', async () => {
  let payload: Record<string, unknown> | undefined;
  const agent = createProviderAgent(source, selection);
  const input = 'Preserve this entire input. '.repeat(2000);
  const stream = await providerStream()({ ...agent.state.model, contextWindow: 8, maxTokens: 2 }, normalizeContext({
    messages: [{ role: 'user', content: input, timestamp: 0 }],
  }), {
    apiKey: 'synthetic-private-key', reasoning: 'high',
    onPayload(value) {
      payload = value as Record<string, unknown>;
      throw new Error('Test stops before network transport');
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'Test stops before network transport');
  assert.equal(payload?.model, 'exact/configured-id');
  // streamSimple owns the reasoning map and an output ceiling clamped to context.
  assert.ok(payload && (payload.max_tokens === 1 || payload.max_completion_tokens === 1));
  assert.ok(JSON.stringify(payload.messages).includes(input));
  assert.equal((payload?.reasoning as { effort?: string } | undefined)?.effort, 'high');
  assert.ok(!JSON.stringify(payload).includes('synthetic-private-key'));
});

test('one validated tool call returns its result to the next model turn', async () => {
  let calls = 0;
  let executions = 0;
  const events: string[] = [];
  const streamFn: StreamFn = (_model, context) => {
    if (calls++ === 0) return stream(message([
      { type: 'toolCall', id: 'call-7', name: 'sum', arguments: { left: 3, right: 11 } },
    ], 'toolUse'));
    const result = context.messages.find((item) => item.role === 'toolResult');
    assert.deepEqual(result?.content, [{ type: 'text', text: '14' }]);
    return stream(message([{ type: 'text', text: 'result:14' }]));
  };
  const parameters = Type.Object({ left: Type.Integer(), right: Type.Integer() });
  const tool: AgentTool<typeof parameters> = {
    name: 'sum', label: 'Sum', description: 'Add two test integers.',
    parameters,
    async execute(_id, args) {
      executions++;
      return { content: [{ type: 'text', text: String(args.left + args.right) }], details: {} };
    },
  };
  const agent = createProviderAgent(source, selection, { streamFn, tools: [tool] });
  agent.subscribe((event) => { events.push(event.type); });
  await agent.prompt('use the test tool');
  assert.equal(calls, 2);
  assert.equal(executions, 1);
  assert.deepEqual(events.filter((event) => event.startsWith('tool_execution')), ['tool_execution_start', 'tool_execution_end']);
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.deepEqual(last.content, [{ type: 'text', text: 'result:14' }]);
});

test('provider failure is a terminal assistant error, not a successful empty reply', async () => {
  const agent = createProviderAgent(source, selection, { streamFn: () => stream({
    ...message([], 'error'), errorMessage: 'synthetic provider unavailable',
  }) });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });
  await agent.prompt('fail');
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.equal(last.stopReason, 'error');
  assert.equal(last.errorMessage, 'synthetic provider unavailable');
  assert.equal(events.at(-1)?.type, 'agent_end');
  assert.equal(agent.state.isStreaming, false);
});

test('abort reaches the active stream, prevents concurrent prompt, and settles idle', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let signal: AbortSignal | undefined;
  const agent = createProviderAgent(source, selection, { streamFn: (_model, _context, options) => {
    const result = createAssistantMessageEventStream();
    signal = options?.signal;
    const abort = () => result.push({ type: 'error', reason: 'aborted', error: message([], 'aborted') });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    started();
    return result;
  } });
  const run = agent.prompt('wait');
  await ready;
  await assert.rejects(agent.prompt('duplicate'), /already processing/);
  agent.abort();
  await run;
  await agent.waitForIdle();
  assert.equal(signal?.aborted, true);
  const last = agent.state.messages.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.equal(last.stopReason, 'aborted');
  assert.equal(agent.state.isStreaming, false);
});

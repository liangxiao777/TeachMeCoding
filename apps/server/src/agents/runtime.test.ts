import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { applyAgentEvent, type AgentDisplayPart, type AgentEventData } from '@teach-me-coding/contracts';
import { Learning } from '../modules/learning.js';
import { Library } from '../modules/library.js';
import { openDatabase } from '../storage/database.js';
import { openDataDirectory } from '../storage/data-directory.js';
import { createApp } from '../http/app.js';
import { createLocalAccess } from '../http/local-access.js';
import { serverConfig } from '../config/server.js';
import { McpService } from '../extensions/mcp.js';
import { SearchService } from '../extensions/search.js';
import { SkillService } from '../extensions/skills.js';
import { TeachingRuntime } from './runtime.js';
import { providerStream } from './model.js';
import type { ModelSelection } from '@teach-me-coding/contracts';
import type { ModelSource } from '../models/service.js';
import { reply, response, syntheticSource, teachingModel } from './test-support.js';


function setup() {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const a = learning.create({ name: 'A', goal: '独立事实 A' }), b = learning.create({ name: 'B', goal: '独立事实 B' });
  learning.saveRequirement(a.id, { ...a.requirement, value: { ...a.requirement.value, goal: '独立事实 A' } });
  learning.saveRequirement(b.id, { ...b.requirement, value: { ...b.requirement.value, goal: '独立事实 B' } });
  return { db, learning, a, b, sa: a.sessions[0]!.id, sb: b.sessions[0]!.id };
}
const message = (text: string, draftRevision = 0) => ({ text, quote: null, draftRevision });

test('runs isolate sessions, reject concurrency, replay durable cursors and deduplicate submissions', async () => {
  const { db, learning, a, b, sa, sb } = setup();
  const contexts: string[] = [];
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    contexts.push(JSON.stringify(context)); return response(reply([{ type: 'text', text: contexts.length === 1 ? 'A reply' : 'B reply' }]));
  } });
  try {
    const key = randomUUID(), first = runtime.submit(a.id, sa, key, message('A prompt'));
    assert.equal(runtime.submit(a.id, sa, key, message('A prompt')).run.id, first.run.id);
    assert.throws(() => runtime.submit(a.id, sa, randomUUID(), message('duplicate', 1)), /已有运行/);
    const second = runtime.submit(b.id, sb, randomUUID(), message('B prompt'));
    await Promise.all([runtime.idle(first.run.id), runtime.idle(second.run.id)]);
    assert.equal(runtime.get(a.id, first.run.id).state, 'succeeded');
    assert.ok(!contexts[0]!.includes('独立事实 B') && !contexts[1]!.includes('A prompt'));
    assert.throws(() => runtime.get(b.id, first.run.id), /不存在/);
    const events = runtime.events(a.id, first.run.id).events;
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(runtime.events(a.id, first.run.id, 2).events, events.slice(2));
    assert.equal(learning.session(a.id, sa).messages.length, 2);
    assert.equal(learning.session(a.id, sa).messages[1]?.text, 'A reply');
    assert.equal(runtime.submit(a.id, sa, key, message('A prompt')).run.state, 'succeeded');
    assert.equal(contexts.length, 2);
    assert.equal(runtime.stop(a.id, first.run.id).state, 'succeeded');
  } finally { await runtime.close(); db.close(); }
});

test('cancel before commit wins even if transport finishes; pending shutdown never calls provider', async () => {
  const { db, learning, a, sa, b, sb } = setup();
  let finish!: () => void, started!: () => void, commits = 0, calls = 0;
  const ready = new Promise<void>((r) => { started = r; });
  const runtime = new TeachingRuntime(learning, syntheticSource, { scenario: () => ({ tools: [], commit: () => { commits++; } }), stream: () => {
    calls++;
    const stream = createAssistantMessageEventStream();
    finish = () => stream.push({ type: 'done', reason: 'stop', message: reply([{ type: 'text', text: 'late' }]) });
    started(); return stream;
  } });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('cancel me'));
    await ready; runtime.stop(a.id, run.id); finish(); await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'interrupted'); assert.equal(commits, 0);
    const pending = runtime.submit(b.id, sb, randomUUID(), message('pending'));
    await runtime.close();
    assert.equal(runtime.get(b.id, pending.run.id).state, 'interrupted'); assert.equal(calls, 1);
  } finally { db.close(); }
});

test('large tool results reach the second request intact; persisted messages omit source body', async () => {
  for (const size of [24, 40_000]) {
    const { db, learning, a, sa } = setup(); let requests = 0;
    const source = `SOURCE-MARKER-${'x'.repeat(size)}-END`;
    const tool: AgentTool = { name: 'read', label: 'Read', description: 'Synthetic only', parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: source }], details: {} }; } };
    const runtime = new TeachingRuntime(learning, syntheticSource, { scenario: () => ({ tools: [tool], commit() {} }), stream: (_m, context) => {
      requests++;
      if (requests === 1) return response(reply([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse'));
      assert.deepEqual(context.messages.find((m) => m.role === 'toolResult')?.content, [{ type: 'text', text: source }]);
      return response(reply([{ type: 'text', text: 'finished' }]));
    } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('read'));
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
      assert.equal(requests, 2);
      const stored = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
      assert.ok(!stored.includes('SOURCE-MARKER')); assert.match(stored, /call-1/); assert.match(stored, /omitted/);
      assert.equal(db.prepare('SELECT * FROM context_manifests').all().length, 2);
    } finally { await runtime.close(); db.close(); }
  }
});

test('cancelling a multi-tool turn retains matching native results without committing or copying bodies', async () => {
  const { db, learning, a, sa } = setup();
  let entered!: () => void, release!: () => void, commits = 0;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new TeachingRuntime(learning, syntheticSource, {
    scenario: () => ({ tools: [{ name: 'read', label: 'read', description: 'synthetic only', parameters: Type.Object({}),
      async execute() { entered(); await held; return { content: [{ type: 'text', text: 'CANCELLED-SOURCE-BODY' }], details: {} }; } }], commit() { commits++; } }),
    stream: () => response(reply(['first', 'second'].map((id) => ({ type: 'toolCall', id, name: 'read', arguments: {} })), 'toolUse')),
  });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('read twice'));
    await ready; runtime.stop(a.id, run.id); release(); await runtime.idle(run.id);
    const values = db.prepare('SELECT value FROM agent_messages ORDER BY seq').all() as { value: string }[];
    const results = values.map((r) => JSON.parse(r.value)).filter((m) => m.role === 'toolResult');
    assert.deepEqual(results.map((m) => m.toolCallId), ['first', 'second']);
    assert.equal(results[1].isError, true); assert.match(JSON.stringify(results[1]), /host recovery marker/);
    assert.doesNotMatch(JSON.stringify(values), /CANCELLED-SOURCE-BODY/);
    assert.equal(commits, 0); assert.equal(runtime.get(a.id, run.id).state, 'interrupted');
    assert.deepEqual(learning.session(a.id, sa).messages.at(-1)?.parts,
      [{ type: 'tool', id: `${run.id}:1:tool:first`, name: 'read', status: 'interrupted', input: {} }]);
  } finally { release(); await runtime.close(); db.close(); }
});

test('protected SSE reconnect reads missing events and disconnect does not stop a run', async () => {
  const { db, learning, a, sa } = setup();
  let complete!: () => void;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
    const stream = createAssistantMessageEventStream();
    complete = () => {
      const partial = reply([{ type: 'text', text: 'x'.repeat(600) }]);
      stream.push({ type: 'start', partial });
      for (let i = 0; i < 600; i++) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x', partial });
      stream.push({ type: 'done', reason: 'stop', message: partial });
    };
    return stream;
  } });
  const access = createLocalAccess(serverConfig({ NODE_ENV: 'production', PORT: '14320' }));
  const app = createApp(access, learning, undefined, runtime);
  const headers = { Host: '127.0.0.1:14320', 'X-TMC-Token': access.token };
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('stream'));
    for (let i = 0; i < 100 && !complete; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(complete, 'request reached the test provider');
    const path = `/api/spaces/${a.id}/runs/${run.id}/stream`;
    assert.equal((await app.request(path, { headers: { Host: headers.Host } })).status, 401);
    const result = await app.request(path, { headers }); const reader = result.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"seq":1/);
    await reader.cancel();
    assert.equal(runtime.get(a.id, run.id).state, 'running');
    complete(); await runtime.idle(run.id);
    const replay = await app.request(`${path}?after=2`, { headers });
    const text = await replay.text();
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 601 }, (_, i) => i + 3));
    assert.equal(events.at(-1)?.data.state, 'succeeded', 'SSE must drain beyond its first 500-event page');
  } finally { complete?.(); await runtime.close(); db.close(); }
});

test('startup appends an interrupted event once and does not replay a pending request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-agent-restart-'));
  let data = openDataDirectory(root);
  try {
    const learning = new Learning(data.db), a = learning.create({ name: 'recovery', goal: 'only test' });
    const id = randomUUID();
    data.db.prepare("INSERT INTO runs VALUES (?,?,NULL,?,'intake','running')").run(a.id, id, a.sessions[0]!.id);
    data.db.prepare("INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,'{}',0)").run(a.id, id);
    const task = randomUUID();
    data.db.prepare("INSERT INTO tasks VALUES (?,?,NULL,NULL,'assessment','pending')").run(a.id, task);
    data.db.prepare("INSERT INTO task_runs(space_id,id,input,created_at) VALUES (?,?,'{}',0)").run(a.id, task);
    const call = JSON.stringify(reply([{ type: 'toolCall', id: 'unfinished', name: 'read', arguments: { path: 'synthetic.txt' } }], 'toolUse'));
    data.db.prepare('INSERT INTO agent_messages VALUES (?,?,1,1,?)').run(a.id, id, call);
    data.db.prepare('INSERT INTO task_messages VALUES (?,?,1,1,?)').run(a.id, task, call);
    data.db.prepare("INSERT INTO messages VALUES (?,?,?,'agent','',NULL,0)").run(a.id, a.sessions[0]!.id, id);
    for (const [table, runId] of [['agent_events', id], ['task_events', task]]) {
      const events: AgentEventData[] = [
        { type: 'reasoning', partId: `${runId}:1:reasoning:0`, phase: 'start' },
        { type: 'reasoning', partId: `${runId}:1:reasoning:0`, phase: 'delta', delta: 'Unfinished at shutdown' },
        { type: 'tool', callId: `${runId}:1:tool:unfinished`, name: 'read', phase: 'start' },
      ];
      events.forEach((event, index) => data.db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(a.id, runId, index + 1, JSON.stringify(event)));
    }
    data.close(); data = openDataDirectory(root);
    let runtime = new TeachingRuntime(new Learning(data.db), syntheticSource);
    assert.equal(runtime.get(a.id, id).state, 'interrupted');
    assert.equal(runtime.events(a.id, id).events.at(-1)?.data.type, 'state');
    assert.equal(runtime.get(a.id, task).state, 'interrupted');
    assert.equal(runtime.events(a.id, task).events.at(-1)?.data.type, 'state');
    data.close(); data = openDataDirectory(root); runtime = new TeachingRuntime(new Learning(data.db), syntheticSource);
    for (const runId of [id, task]) {
      const events = runtime.events(a.id, runId).events;
      assert.equal(events.length, 4);
      const parts = events.reduce<AgentDisplayPart[]>(applyAgentEvent, []);
      assert.deepEqual(parts, [
        { type: 'reasoning', id: `${runId}:1:reasoning:0`, text: 'Unfinished at shutdown', status: 'interrupted' },
        { type: 'tool', id: `${runId}:1:tool:unfinished`, name: 'read', status: 'interrupted' },
      ]);
      if (runId === id) assert.deepEqual(new Learning(data.db).session(a.id, a.sessions[0]!.id).messages.at(-1)?.parts, parts);
    }
    for (const table of ['agent_messages', 'task_messages']) {
      const rows = data.db.prepare(`SELECT value FROM ${table} ORDER BY seq`).all();
      assert.equal(rows.length, 2); assert.match(JSON.stringify(rows), /host recovery marker/);
    }
  } finally { data.close(); rmSync(root, { recursive: true, force: true }); }
});

test('teaching runtime sends high reasoning and the exact model/key through the real OpenRouter serializer', async () => {
  const { db, learning, a, sa } = setup();
  const adapter = providerStream();
  let payload: Record<string, unknown> | undefined;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (model, context, options) => {
    assert.equal(options?.reasoning, 'high');
    return adapter(model, context, { ...options, apiKey: 'synthetic-private-key', onPayload(value) {
      payload = value as Record<string, unknown>;
      throw new Error('Deterministic stop before network transport');
    } });
  } });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('serialize, do not send'));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'failed');
    assert.equal(payload?.model, 'stealth/space-bunny-alpha');
    // pi-ai's unified path applies its own output ceiling and reasoning map.
    assert.ok(payload && (typeof payload.max_tokens === 'number' || typeof payload.max_completion_tokens === 'number'));
    assert.equal((payload?.reasoning as { effort?: string } | undefined)?.effort, 'high');
    assert.ok(!JSON.stringify(payload).includes('synthetic-private-key'));
    const manifest = db.prepare('SELECT value FROM context_manifests').get() as { value: string };
    assert.equal(JSON.parse(manifest.value).budget.reasoning, 'high');
  } finally { await runtime.close(); db.close(); }
});

test('each run freezes the model and reasoning level that were selected at its creation', async () => {
  const { db, learning, a, sa } = setup();
  const other = { ...teachingModel, id: 'other/model' };
  const first: ModelSelection = { provider: 'openrouter', model: teachingModel.id, thinkingLevel: 'high' };
  const second: ModelSelection = { provider: 'openrouter', model: other.id, thinkingLevel: 'low' };
  let active = first;
  const source: ModelSource = {
    current: () => ({ selection: active, model: active.model === other.id ? other : teachingModel }),
    resolve: (s) => s.model === other.id ? other : s.model === teachingModel.id ? teachingModel : undefined,
  };
  const seen: { model: string; reasoning: unknown }[] = [];
  const runtime = new TeachingRuntime(learning, source, { stream: (model, _context, options) => {
    seen.push({ model: model.id, reasoning: options?.reasoning });
    return response(reply([{ type: 'text', text: 'ok' }]));
  } });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('first'));
    active = second; // The setting changes after the run is created.
    await runtime.idle(run.id);
    assert.deepEqual(seen[0], { model: teachingModel.id, reasoning: 'high' });
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
    const later = runtime.submit(a.id, sa, randomUUID(), message('second', learning.session(a.id, sa).draft.revision));
    await runtime.idle(later.run.id);
    assert.deepEqual(seen[1], { model: 'other/model', reasoning: 'low' });
  } finally { await runtime.close(); db.close(); }
});

test('ordered reasoning/text/tool rounds hydrate identically while native signatures stay private and survive continuation', async () => {
  const { db, learning, a, sa } = setup();
  let requests = 0;
  const first = reply([
    { type: 'thinking', thinking: 'First reasoning', thinkingSignature: 'PRIVATE-THINKING-SIGNATURE' },
    { type: 'thinking', thinking: 'REDACTED-CONTENT', thinkingSignature: 'ENCRYPTED-SIGNATURE', redacted: true },
    { type: 'text', text: 'Before tool. ', textSignature: 'PRIVATE-TEXT-SIGNATURE' },
    { type: 'toolCall', id: 'read-1', name: 'read', arguments: { marker: 'VISIBLE-ARGUMENT' } },
  ], 'toolUse');
  const tool: AgentTool = { name: 'read', label: 'Read', description: 'Synthetic only', parameters: Type.Object({ marker: Type.String() }),
    async execute() { return { content: [{ type: 'text', text: 'PRIVATE-TOOL-BODY' }], details: {} }; } };
  const runtime = new TeachingRuntime(learning, syntheticSource, { scenario: () => ({ tools: [tool], commit() {} }), stream: (_model, context) => {
    requests++;
    if (requests === 1) return response(first);
    const saved = context.messages.find((m) => m.role === 'assistant');
    assert.deepEqual(saved?.content, first.content);
    if (requests === 2) return response(reply([
      { type: 'thinking', thinking: 'Second reasoning', thinkingSignature: 'SECOND-SIGNATURE' }, { type: 'text', text: 'After tool.' },
    ]));
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE-TOOL-BODY/);
    return response(reply([{ type: 'text', text: 'Continued.' }]));
  } });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('two rounds'));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
    const events = runtime.events(a.id, run.id).events;
    let parts: AgentDisplayPart[] = [];
    for (const event of events) {
      const previous = structuredClone(parts);
      Object.freeze(parts); parts.forEach(Object.freeze);
      const next = applyAgentEvent(parts, event);
      assert.deepEqual(parts, previous, 'Reducer must not mutate prior render state');
      parts = next;
    }
    assert.deepEqual(parts, [
      { type: 'reasoning', id: `${run.id}:1:reasoning:0`, text: 'First reasoning', status: 'done' },
      { type: 'text', id: `${run.id}:1:text:2`, text: 'Before tool. ' },
      { type: 'tool', id: `${run.id}:1:tool:read-1`, name: 'read', status: 'done', input: { marker: 'VISIBLE-ARGUMENT' } },
      { type: 'reasoning', id: `${run.id}:2:reasoning:0`, text: 'Second reasoning', status: 'done' },
      { type: 'text', id: `${run.id}:2:text:1`, text: 'After tool.' },
    ]);
    assert.equal(new Set(parts.map((part) => part.id)).size, parts.length);
    const hydrated = new Learning(db).session(a.id, sa).messages.at(-1)!;
    assert.deepEqual(hydrated.parts, parts);
    assert.equal(hydrated.text, 'Before tool. After tool.');
    assert.equal(hydrated.sequence, events.at(-1)?.seq);
    assert.doesNotMatch(JSON.stringify({ events, hydrated }), /SIGNATURE|REDACTED-CONTENT|PRIVATE-ARGUMENT|PRIVATE-TOOL-BODY/);
    const native = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
    assert.match(native, /PRIVATE-THINKING-SIGNATURE/); assert.match(native, /ENCRYPTED-SIGNATURE/);
    assert.doesNotMatch(native, /PRIVATE-TOOL-BODY/);
    const followup = runtime.submit(a.id, sa, randomUUID(), message('continue saved history', 1));
    await runtime.idle(followup.run.id);
    assert.equal(runtime.get(a.id, followup.run.id).state, 'succeeded');
    assert.equal(requests, 3);
  } finally { await runtime.close(); db.close(); }
});

test('hydrating unfinished reasoning and replaying from the saved cursor never duplicates text or reasoning', async () => {
  const { db, learning, a, sa } = setup();
  const stream = createAssistantMessageEventStream();
  const partial = reply([{ type: 'text', text: 'Preface. ' }, { type: 'thinking', thinking: 'Consider ' }], 'pending');
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => stream });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('reconnect'));
    stream.push({ type: 'start', partial });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Preface. ', partial });
    stream.push({ type: 'thinking_start', contentIndex: 1, partial });
    stream.push({ type: 'thinking_delta', contentIndex: 1, delta: 'Consider ', partial });
    for (let i = 0; i < 100 && runtime.events(a.id, run.id).events.length < 5; i++) await new Promise((r) => setTimeout(r, 1));
    const saved = new Learning(db).session(a.id, sa).messages.at(-1)!;
    assert.deepEqual(saved.parts?.at(-1), { type: 'reasoning', id: `${run.id}:1:reasoning:1`, text: 'Consider ', status: 'streaming' });
    assert.equal(saved.text, 'Preface. ');
    assert.equal(saved.sequence, 5);
    stream.push({ type: 'thinking_delta', contentIndex: 1, delta: 'the result.', partial });
    stream.push({ type: 'thinking_end', contentIndex: 1, content: 'Consider the result.', partial });
    stream.push({ type: 'text_delta', contentIndex: 2, delta: 'Answer.', partial });
    stream.push({ type: 'done', reason: 'stop', message: reply([
      { type: 'text', text: 'Preface. ' }, { type: 'thinking', thinking: 'Consider the result.' }, { type: 'text', text: 'Answer.' },
    ]) });
    await runtime.idle(run.id);
    const missing = runtime.events(a.id, run.id, saved.sequence).events;
    let parts = saved.parts!, text = saved.text, sequence = saved.sequence!;
    // Simulate duplicate SSE delivery around a reconnect; the cursor owns dedup.
    for (const event of [...runtime.events(a.id, run.id).events, ...missing]) {
      if (event.seq <= sequence) continue;
      parts = applyAgentEvent(parts, event);
      if (event.data.type === 'text') text += event.data.delta;
      sequence = event.seq;
    }
    const hydrated = new Learning(db).session(a.id, sa).messages.at(-1)!;
    assert.deepEqual(parts, hydrated.parts);
    assert.equal(text, 'Preface. Answer.'); assert.equal(text, hydrated.text);
    assert.equal(sequence, hydrated.sequence);
    assert.equal(parts[1]?.type === 'reasoning' && parts[1].text, 'Consider the result.');
    assert.equal(parts[1]?.type === 'reasoning' && parts[1].status, 'done');
    assert.deepEqual(runtime.events(a.id, run.id, sequence).events, []);
  } finally { stream.push({ type: 'error', reason: 'aborted', error: reply([], 'aborted') }); await runtime.close(); db.close(); }
});

test('stop or provider failure before reasoning_end preserves unfinished display state, never marks it done', async () => {
  for (const mode of ['stop', 'failure'] as const) {
    const { db, learning, a, sa } = setup();
    const stream = createAssistantMessageEventStream();
    const partial = reply([{ type: 'thinking', thinking: 'Unfinished', thinkingSignature: 'PRIVATE-SIGNATURE' }], 'pending');
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => stream });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(mode));
      stream.push({ type: 'start', partial });
      stream.push({ type: 'thinking_start', contentIndex: 0, partial });
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'Unfinished', partial });
      for (let i = 0; i < 100 && runtime.events(a.id, run.id).events.length < 4; i++) await new Promise((r) => setTimeout(r, 1));
      assert.equal(learning.session(a.id, sa).messages.at(-1)?.parts?.[0]?.type, 'reasoning');
      if (mode === 'stop') {
        runtime.stop(a.id, run.id);
        stream.push({ type: 'thinking_end', contentIndex: 0, content: 'Unfinished', partial });
      }
      const reason = mode === 'stop' ? 'aborted' : 'error';
      stream.push({ type: 'error', reason, error: { ...partial, stopReason: reason } });
      await runtime.idle(run.id);
      const hydrated = learning.session(a.id, sa).messages.at(-1)!;
      assert.deepEqual(hydrated.parts, [{ type: 'reasoning', id: `${run.id}:1:reasoning:0`, text: 'Unfinished', status: 'interrupted' }]);
      assert.equal(hydrated.status, mode === 'stop' ? 'stopped' : 'error');
      assert.ok(!runtime.events(a.id, run.id).events.some((e) => e.data.type === 'reasoning' && e.data.phase === 'end'));
      assert.doesNotMatch(JSON.stringify(hydrated), /PRIVATE-SIGNATURE/);
    } finally { stream.push({ type: 'error', reason: 'aborted', error: reply([], 'aborted') }); await runtime.close(); db.close(); }
  }
});

test('legacy display events reduce immutably in order and terminal states do not invent tool success', () => {
  const data: AgentEventData[] = [
    { type: 'text', delta: 'Old ' }, { type: 'text', delta: 'reply' },
    { type: 'tool', name: 'read', phase: 'start' }, { type: 'tool', name: 'read', phase: 'end' },
    { type: 'text', delta: ' then ' }, { type: 'tool', name: 'read', phase: 'start' },
    { type: 'state', state: 'failed', error: 'Failed before tool end' },
  ];
  const parts = data.reduce<AgentDisplayPart[]>((p, d, index) => applyAgentEvent(p, { runId: 'legacy', seq: index + 1, data: d }), []);
  assert.deepEqual(parts, [
    { type: 'text', id: 'legacy:legacy-text:1', text: 'Old reply' },
    { type: 'tool', id: 'legacy:legacy-tool:3', name: 'read', status: 'done' },
    { type: 'text', id: 'legacy:legacy-text:5', text: ' then ' },
    { type: 'tool', id: 'legacy:legacy-tool:6', name: 'read', status: 'interrupted' },
  ]);
  assert.deepEqual(applyAgentEvent([], { runId: 'legacy', seq: 1, data: { type: 'tool', name: 'read', phase: 'end', failed: true } }),
    [{ type: 'tool', id: 'legacy:legacy-tool:1', name: 'read', status: 'error' }]);
});

test('real Pi adapter streams tool arguments, replays them exactly, and never executes a failed stream', async () => {
  for (const mode of ['success', 'failure', 'cancel', 'length'] as const) {
    const { db, learning, a, sa } = setup();
    const adapter = providerStream();
    let requests = 0, executions = 0, commits = 0, chunks = 0;
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'gen-synthetic-stream', object: 'chat.completion.chunk', created: 1,
      model: teachingModel.id, choices: [{ index: 0, delta, finish_reason }] });
    const runtime = new TeachingRuntime(learning, syntheticSource, {
      scenario: () => ({ tools: [{ name: 'read', label: 'read', description: 'Synthetic only', parameters: Type.Object({ marker: Type.String() }),
        async execute() { executions++; return { content: [{ type: 'text', text: 'tool result' }], details: {} }; } }], commit() { commits++; } }),
      stream: (model, context, options) => adapter(model, context, { ...options, apiKey: 'synthetic-private-key',
        onProviderStreamEvent: (...args) => { chunks++; options?.onProviderStreamEvent?.(...args); },
        fetch: async () => {
          requests++;
          const body = requests === 1 ? new ReadableStream<Uint8Array>({ start(controller) { wire = controller; } })
            : new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(chunk({ content: 'Finished.' }, 'stop'))); controller.close(); } });
          return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-private': 'PRIVATE-HEADER' } });
        } }),
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(mode));
      for (let i = 0; i < 100 && !wire; i++) await new Promise((r) => setTimeout(r, 1));
      assert.ok(wire);
      wire.enqueue(encode(chunk({ reasoning: 'Analyse the request.' })));
      wire.enqueue(encode(chunk({ tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'read', arguments: '{"marker":' } }] })));
      wire.enqueue(encode(chunk({ tool_calls: [{ index: 0, function: { arguments: '"VISIBLE-ARGUMENT"}' } }] })));
      for (let i = 0; i < 100 && chunks < 3; i++) await new Promise((r) => setTimeout(r, 1));
      assert.equal(chunks, 3);
      const before = learning.session(a.id, sa).messages.at(-1)!;
      assert.deepEqual(before.parts, [
        { type: 'reasoning', id: `${run.id}:1:reasoning:0`, text: 'Analyse the request.', status: 'streaming' },
        { type: 'tool', id: `${run.id}:1:tool-input:1`, name: 'read', status: 'generating', inputText: '{"marker":"VISIBLE-ARGUMENT"}' },
      ]);
      assert.equal(executions, 0, 'Even complete-looking JSON is not permission to execute before normal stream termination');
      if (mode === 'failure') wire.enqueue(encode({ error: { code: 502, message: 'PRIVATE-PROVIDER-ERROR', metadata: { raw: 'PRIVATE-ERROR-BODY' } } }));
      else if (mode === 'cancel') runtime.stop(a.id, run.id);
      else wire.enqueue(encode(chunk({}, mode === 'length' ? 'length' : 'tool_calls')));
      wire.close();
      await runtime.idle(run.id);
      const events = runtime.events(a.id, run.id).events;
      const toolEvents = events.flatMap((e) => e.data.type === 'tool' ? [e.data] : []);
      assert.deepEqual(toolEvents.slice(0, 3).map((e) => e.phase), ['input', 'input', 'input']);
      if (mode !== 'length') assert.deepEqual(toolEvents.slice(3).map((e) => e.phase), mode === 'success' ? ['ready', 'start', 'end'] : []);
      assert.ok(toolEvents.every((e) => !('inputCharacters' in e)));
      assert.equal(new Set(toolEvents.map((e) => e.callId)).size, 1);
      assert.equal(executions, mode === 'success' ? 1 : 0);
      assert.equal(commits, mode === 'success' ? 1 : 0);
      assert.equal(requests, mode === 'success' ? 2 : 1, 'No automatic retry on a failed stream');
      assert.equal(runtime.get(a.id, run.id).state, mode === 'success' ? 'succeeded' : mode === 'cancel' ? 'interrupted' : 'failed');
      if (mode === 'length') assert.match(runtime.get(a.id, run.id).error!, /截断/);
      const hydrated = learning.session(a.id, sa).messages.at(-1)!;
      assert.deepEqual(hydrated.parts, events.reduce<AgentDisplayPart[]>(applyAgentEvent, []));
      const tool = hydrated.parts?.find((p) => p.type === 'tool');
      if (mode !== 'length') assert.equal(tool?.type === 'tool' && tool.status, mode === 'success' ? 'done' : 'interrupted');
      if (tool?.type === 'tool' && mode !== 'length') {
        assert.deepEqual(tool.input, mode === 'success' ? { marker: 'VISIBLE-ARGUMENT' } : undefined);
        assert.equal(tool.inputText, mode === 'success' ? undefined : '{"marker":"VISIBLE-ARGUMENT"}');
      }
      assert.doesNotMatch(JSON.stringify({ events, hydrated }), /PRIVATE-/);
      const retained = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
      assert.doesNotMatch(retained, /PRIVATE-PROVIDER-ERROR|PRIVATE-ERROR-BODY|PRIVATE-HEADER/);
      const manifest = JSON.parse((db.prepare('SELECT value FROM context_manifests WHERE request=1').get() as { value: string }).value);
      assert.equal(manifest.transport.httpStatus, 200, 'An SSE error is not an HTTP response status');
      assert.equal(manifest.transport.responseId, 'gen-synthetic-stream');
      assert.ok(manifest.transport.eventCount >= 3);
      assert.ok(manifest.transport.lastEventAt >= manifest.transport.startedAt);
      assert.ok(manifest.transport.elapsedMs >= 0);
      if (mode === 'length') assert.equal(manifest.transport.rawStopReason, 'length');
      if (mode === 'failure') {
        assert.equal(manifest.actualUsage, null);
        assert.match(manifest.transport.errorFingerprint, /^[a-f0-9]{64}$/);
      }
      assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE-/);
    } finally {
      try { wire?.close(); } catch { /* Already closed by the fixture or adapter. */ }
      await runtime.close(); db.close();
    }
  }
});

test('tool name conflicts fail before requesting a model, executing tools or committing a scene', async () => {
  for (const source of ['scenario', 'web-fetch'] as const) {
    const { db, learning, a, sa } = setup();
    const requirement = structuredClone(learning.space(a.id).requirement);
    let requests = 0, executions = 0, commits = 0;
    const first: AgentTool = { name: source === 'scenario' ? 'duplicate_scene' : 'web_fetch', label: 'First',
      description: 'PRIVATE-FIRST-DESCRIPTION', parameters: Type.Object({ path: Type.String() }),
      async execute() { executions++; return { content: [], details: {} }; } };
    const second: AgentTool = { ...first, label: 'Second', parameters: Type.Object({ count: Type.Integer() }) };
    const runtime = new TeachingRuntime(learning, syntheticSource, {
      scenario: () => ({ tools: source === 'scenario' ? [first, second] : [first], commit() { commits++; } }),
      projectDirectory: () => { assert.fail('Without Skills, assembly must not resolve a project directory.'); },
      stream: () => { requests++; return response(reply([{ type: 'text', text: 'Must not start.' }])); },
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('assemble conflicting tools'));
      await runtime.idle(run.id);
      const failed = runtime.get(a.id, run.id);
      assert.equal(failed.state, 'failed');
      assert.ok(failed.error?.includes(first.name) && failed.error.includes(`scenario / ${source}`));
      assert.doesNotMatch(failed.error!, /PRIVATE-FIRST-DESCRIPTION/);
      assert.deepEqual({ requests, executions, commits }, { requests: 0, executions: 0, commits: 0 });
      assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM context_manifests').get()!.n, 0);
      assert.deepEqual(learning.space(a.id).requirement, requirement);
    } finally { await runtime.close(); db.close(); }
  }
});

test('each request records the same run tool inventory while provider selection happens only once', async () => {
  const { db, learning, a, sa } = setup(), root = mkdtempSync(join(tmpdir(), 'tmc-tool-inventory-'));
  const mcp = new McpService(join(root, 'mcp.json'), { env: () => undefined, cwd: root });
  const search = new SearchService(join(root, 'search.json'), { env: () => undefined });
  const skills = new SkillService(db, root), skill = join(skills.directory, 'inventory-fixture');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: inventory-fixture\ndescription: Inspect the fixture tools.\n---\nPRIVATE-SKILL-BODY');
  let mcpSelections = 0, searchSelections = 0, requests = 0, executions = 0, commits = 0;
  const read: AgentTool = { name: 'read', label: 'Fixture read', description: 'PRIVATE-READ-DESCRIPTION', parameters: Type.Object({ path: Type.String() }),
    async execute() { assert.fail('The fixture never requests read.'); } };
  const mcpTool: AgentTool = { name: 'mcp__fixture__subtract', label: 'Subtract', description: 'PRIVATE-MCP-DESCRIPTION',
    parameters: Type.Object({ left: Type.Number(), right: Type.Number() }), outputSchema: Type.Object({ difference: Type.Number() }),
    async execute() { executions++; return { content: [{ type: 'text', text: 'PRIVATE-MCP-BODY' }], structuredContent: { difference: 17 },
      details: { sources: [{ kind: 'mcp', server: 'fixture', tool: 'subtract' }] } }; } };
  const searchTool: AgentTool = { name: 'web_search', label: 'Search', description: 'PRIVATE-SEARCH-DESCRIPTION', parameters: Type.Object({ query: Type.String() }),
    async execute() { executions++; return { content: [{ type: 'text', text: 'PRIVATE-SEARCH-BODY' }],
      details: { sources: [{ kind: 'web', provider: 'fixture', url: 'https://example.com/docs' }] } }; } };
  let selectedMcp = [mcpTool], selectedSearch = [searchTool];
  mcp.tools = async () => { mcpSelections++; return selectedMcp; };
  search.tools = async () => { searchSelections++; return selectedSearch; };
  const inventory = [
    { name: 'read', source: 'scenario' },
    { name: 'ls', source: 'skills-read' }, { name: 'find', source: 'skills-read' }, { name: 'grep', source: 'skills-read' },
    { name: 'mcp__fixture__subtract', source: 'mcp' }, { name: 'web_search', source: 'search' }, { name: 'web_fetch', source: 'web-fetch' },
  ];
  const runtime = new TeachingRuntime(learning, syntheticSource, { mcp, search, skills,
    projectDirectory: () => { assert.equal(mcpSelections, 1, 'Resolve the Skills cwd only after MCP selection.'); return root; },
    scenario: () => ({ tools: [read], commit() { commits++; } }), stream: (_model, context) => {
      const system = context.messages.find((m) => m.role === 'system'); assert.ok(system?.role === 'system');
      assert.deepEqual(system.toolsAdded?.map((t) => t.name), inventory.map((t) => t.name));
      assert.deepEqual(system.toolsAdded?.find((t) => t.name === mcpTool.name), {
        name: mcpTool.name, description: 'PRIVATE-MCP-DESCRIPTION', parameters: mcpTool.parameters, outputSchema: mcpTool.outputSchema,
      });
      requests++;
      if (requests === 1) {
        selectedMcp = [{ ...mcpTool, name: 'mcp__fixture__replacement' }]; selectedSearch = [];
        return response(reply([{ type: 'toolCall', id: 'fixed-mcp', name: mcpTool.name, arguments: { left: 31, right: 14 } }], 'toolUse'));
      }
      if (requests === 2) return response(reply([{ type: 'toolCall', id: 'fixed-search', name: 'web_search', arguments: { query: 'public documentation' } }], 'toolUse'));
      return response(reply([{ type: 'text', text: 'Finished.' }]));
    } });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('use the selected tools'));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
    assert.deepEqual({ mcpSelections, searchSelections, requests, executions, commits },
      { mcpSelections: 1, searchSelections: 1, requests: 3, executions: 2, commits: 1 });
    const manifests = (db.prepare('SELECT value FROM context_manifests ORDER BY request').all() as { value: string }[]).map((row) => JSON.parse(row.value));
    assert.equal(manifests.length, 3);
    for (const manifest of manifests) {
      assert.deepEqual(manifest.toolInventory, inventory);
      assert.deepEqual(manifest.extensions.mcpTools, ['mcp__fixture__subtract']);
      assert.equal(typeof manifest.extensions.skills, 'string');
      assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE-|replacement/);
    }
    assert.deepEqual(manifests.map((manifest) => manifest.toolSources.map((s: { callId: string }) => s.callId)),
      [[], ['fixed-mcp'], ['fixed-mcp', 'fixed-search']]);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM agent_messages').all()), /PRIVATE-MCP-BODY|PRIVATE-SEARCH-BODY|PRIVATE-SKILL-BODY/);
  } finally { await Promise.all([runtime.close(), mcp.close(), skills.close()]); search.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stopping during search tool selection rejects late tools without a model request or commit', async () => {
  const { db, learning, a, sa } = setup(), root = mkdtempSync(join(tmpdir(), 'tmc-tool-selection-'));
  const search = new SearchService(join(root, 'search.json'), { env: () => undefined });
  let enter!: () => void, release!: () => void, requests = 0, commits = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  search.tools = async () => { enter(); await held; return []; };
  const runtime = new TeachingRuntime(learning, syntheticSource, { search,
    scenario: () => ({ tools: [], commit() { commits++; } }),
    stream: () => { requests++; return response(reply([{ type: 'text', text: 'Must not start.' }])); },
  });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('cancel selection'));
    await entered; runtime.stop(a.id, run.id); release(); await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'interrupted');
    assert.deepEqual({ requests, commits }, { requests: 0, commits: 0 });
    assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM context_manifests').get()!.n, 0);
  } finally { release(); await runtime.close(); search.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a bare teaching Agent discovers global references and reads Pi Bash continuation without persisting bodies', async () => {
  const { db, learning, a, sa, b, sb } = setup(), root = mkdtempSync(join(tmpdir(), 'tmc-library-agent-'));
  const library = new Library(root);
  const file = await library.upload(randomUUID(), 'shared.md', new Response('PRIVATE-REFERENCE-BODY').body, new AbortController().signal);
  const paths: string[] = [], seen = new Set<string>();
  const runtime = new TeachingRuntime(learning, syntheticSource, { library, stream: (_model, context) => {
    const results = context.messages.filter((m) => m.role === 'toolResult');
    const call = (name: string, args: Record<string, string | number>) => response(reply([{ type: 'toolCall', id: `call-${results.length}`, name, arguments: args }], 'toolUse'));
    if (!results.length) {
      assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE-REFERENCE-BODY/);
      return call('list_library_files', {});
    }
    const last = results.at(-1)!;
    const output = last.content.map((p) => p.type === 'text' ? p.text : '').join('');
    assert.equal(last.isError, false, output);
    if (results.length === 1) {
      const listing = JSON.parse(output);
      assert.equal(listing.files[0].id, file.id); assert.equal(listing.files[0].name, file.name);
      assert.equal(listing.untrusted, true);
      return call('read', { path: listing.files[0].path });
    }
    if (results.length === 2) {
      assert.equal(JSON.parse(output).text, 'PRIVATE-REFERENCE-BODY');
      return call('bash', { command: 'awk \'BEGIN { for (i=1;i<=2200;i++) print "continuation-" i }\'' });
    }
    if (results.length === 3) {
      assert.match(output, /continuation-2200/);
      assert.doesNotMatch(output, /continuation-1\n/);
      const path = output.match(/Full output: (.+)\]/)![1]!; paths.push(path);
      return call('read', { path, limit: 100 });
    }
    assert.match(JSON.parse(output).text, /^continuation-1\ncontinuation-2\n/);
    seen.add(file.id);
    return response(reply([{ type: 'text', text: '引用已按需读取。' }]));
  } });
  try {
    for (const [space, session] of [[a.id, sa], [b.id, sb]]) {
      const { run } = runtime.submit(space!, session!, randomUUID(), message('参考 shared.md'));
      await runtime.idle(run.id); assert.equal(runtime.get(space!, run.id).state, 'succeeded');
      assert.equal(existsSync(paths.at(-1)!), false, 'Run settlement must clean its output files.');
    }
    assert.equal(seen.size, 1); assert.equal(paths.length, 2);
    assert.deepEqual(readdirSync(join(root, 'bash-output')), []);
    const retained = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
    assert.doesNotMatch(retained, /PRIVATE-REFERENCE-BODY|continuation-2200/);
  } finally { await runtime.close(); await library.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

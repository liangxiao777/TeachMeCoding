import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
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
  learning.saveRequirement(a.id, { ...a.requirement, value: { rows: [{ question: '想学习什么？', answer: '独立事实 A' }] } });
  learning.saveRequirement(b.id, { ...b.requirement, value: { rows: [{ question: '想学习什么？', answer: '独立事实 B' }] } });
  return { db, learning, a, b, sa: a.sessions[0]!.id, sb: b.sessions[0]!.id };
}
const message = (text: string, draftRevision = 0) => ({ text, quote: null, draftRevision });

test('runs isolate sessions, replay durable cursors and deduplicate submissions', async () => {
  const { db, learning, a, b, sa, sb } = setup();
  const contexts: string[] = [];
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    contexts.push(JSON.stringify(context)); return response(reply([{ type: 'text', text: contexts.length === 1 ? 'A reply' : 'B reply' }]));
  } });
  try {
    const key = randomUUID(), first = runtime.submit(a.id, sa, key, message('A prompt'));
    assert.equal(runtime.submit(a.id, sa, key, message('A prompt')).run.id, first.run.id);
    const second = runtime.submit(b.id, sb, randomUUID(), message('B prompt'));
    await Promise.all([runtime.idle(first.run.id), runtime.idle(second.run.id)]);
    assert.equal(runtime.get(a.id, first.run.id).state, 'succeeded');
    assert.ok(!contexts[0]!.includes('独立事实 B') && !contexts[1]!.includes('A prompt'));
    assert.throws(() => runtime.get(b.id, first.run.id), { message: 'RUN_NOT_FOUND' });
    const events = runtime.events(a.id, first.run.id).events;
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: events.length }, (_, i) => i + 1));
    assert.deepEqual(events.filter((e) => e.data.type !== 'context').map((e) => e.data.type), ['state', 'state', 'text', 'state']);
    assert.deepEqual(runtime.events(a.id, first.run.id, 2).events, events.slice(2));
    assert.equal(learning.session(a.id, sa).messages.length, 2);
    assert.equal(learning.session(a.id, sa).messages[1]?.text, 'A reply');
    assert.equal(runtime.submit(a.id, sa, key, message('A prompt')).run.state, 'succeeded');
    assert.equal(contexts.length, 2);
    assert.equal(runtime.stop(a.id, first.run.id).state, 'succeeded');
  } finally { await runtime.close(); db.close(); }
});

test('follow-ups wait for the whole tool chain, consume FIFO and project separate replies', async () => {
  const { db, learning, a, sa } = setup();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const inputs: string[] = [];
  const runtime = new TeachingRuntime(learning, syntheticSource, {
    scenario: () => ({ tools: [{ name: 'read', label: 'read', description: 'synthetic', parameters: Type.Object({}),
      async execute() { entered(); await held; return { content: [{ type: 'text', text: 'tool result' }], details: {} }; } }], commit() {} }),
    stream: (_model, context) => {
      const last = context.messages.at(-1)!;
      const text = last.role === 'user' ? JSON.stringify(last.content) : last.role;
      inputs.push(text);
      if (inputs.length === 1) return response(reply([{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }], 'toolUse'));
      return response(reply([{ type: 'text', text: `reply ${inputs.length}` }]));
    },
  });
  try {
    const first = runtime.submit(a.id, sa, randomUUID(), message('initial'));
    const key = randomUUID();
    const queued = runtime.submit(a.id, sa, key, message('same prompt', 1)); // Before AgentSession exists.
    assert.equal(queued.run.id, first.run.id);
    assert.equal(runtime.submit(a.id, sa, key, message('same prompt', 1)).session.draft.revision, 2);
    await ready;
    runtime.submit(a.id, sa, randomUUID(), message('same prompt', 2)); // Identical text must keep its own identity.
    const quote = { source: 'code' as const, label: 'quoted.py', text: 'print(37)' };
    const last = runtime.submit(a.id, sa, randomUUID(), { ...message('quoted follow-up', 3), quote });
    const pending = last.session.messages[1]!.queuedPrompts!;
    assert.deepEqual(pending.map((p) => p.text), ['same prompt', 'same prompt', 'quoted follow-up']);
    assert.equal(new Set(pending.map((p) => p.id)).size, 3);
    assert.equal(last.session.messages.length, 2, 'queued prompts are not delivered chat messages');
    assert.equal(inputs.length, 1, 'a follow-up must not interrupt a running tool');
    assert.throws(() => runtime.submit(a.id, sa, randomUUID(), message('stale', 2)), { message: 'CONTENT_CHANGED' });
    release(); await runtime.idle(first.run.id);
    assert.equal(runtime.get(a.id, first.run.id).state, 'succeeded');
    assert.equal(inputs[1], 'toolResult', 'finish the initial tool chain before consuming follow-ups');
    assert.match(inputs[2]!, /same prompt/); assert.match(inputs[3]!, /same prompt/);
    assert.match(inputs[4]!, /quoted follow-up/); assert.match(inputs[4]!, /print\(37\)/);
    const saved = learning.session(a.id, sa);
    assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'agent', 'user', 'agent', 'user', 'agent', 'user', 'agent']);
    assert.deepEqual(saved.messages.filter((m) => m.role === 'agent').map((m) => m.text), ['reply 2', 'reply 3', 'reply 4', 'reply 5']);
    assert.deepEqual(saved.messages.find((m) => m.text === 'quoted follow-up')?.quote, quote);
    assert.ok(saved.messages.every((m) => m.status === 'done'));
    assert.deepEqual(saved.messages[1]!.queuedPrompts, []);
    assert.equal(learning.space(a.id).runs.length, 1, 'all follow-ups use the same native Pi run');
  } finally { release(); await runtime.close(); db.close(); }
});

test('queued prompts can be withdrawn by ID and remain recoverable after stop or model failure', async () => {
  for (const end of ['stop', 'error', 'length', 'retry'] as const) {
    const { db, learning, a, sa, b, sb } = setup();
    let finish!: () => void, entered!: () => void, calls = 0;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = new TeachingRuntime(learning, syntheticSource, { retry: { enabled: end === 'retry', maxRetries: 1, baseDelayMs: 0 }, stream: () => {
      calls++;
      const result = { ...reply([{ type: 'text', text: 'first reply' }], end === 'stop' ? 'stop' : end === 'length' ? 'length' : 'error'),
        ...(end === 'retry' ? { errorMessage: '503 Service unavailable' } : {}) };
      if (calls > 1) return response(result);
      const stream = createAssistantMessageEventStream();
      finish = () => {
        if (end === 'error' || end === 'retry') stream.push({ type: 'error', reason: 'error', error: result });
        else stream.push({ type: 'done', reason: end, message: result });
      };
      entered(); return stream;
    } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('initial'));
      await ready;
      runtime.submit(a.id, sa, randomUUID(), message('withdraw me', 1));
      const queued = runtime.submit(a.id, sa, randomUUID(), message('keep me', 2));
      const prompts = queued.session.messages[1]!.queuedPrompts!;
      assert.throws(() => runtime.dequeue(b.id, sb, prompts[0]!.id, randomUUID()), { message: 'QUEUED_PROMPT_NOT_FOUND' });
      const key = randomUUID();
      runtime.dequeue(a.id, sa, prompts[0]!.id, key);
      runtime.dequeue(a.id, sa, prompts[0]!.id, key);
      assert.deepEqual(learning.session(a.id, sa).messages[1]!.queuedPrompts?.map((p) => p.text), ['keep me']);
      if (end === 'stop') runtime.stop(a.id, run.id);
      finish(); await runtime.idle(run.id);
      assert.equal(calls, end === 'retry' ? 2 : 1, `${end} must not silently consume remaining prompts`);
      assert.equal(runtime.get(a.id, run.id).state, end === 'stop' ? 'interrupted' : 'failed');
      assert.deepEqual(learning.session(a.id, sa).messages[1]!.queuedPrompts?.map((p) => p.text), ['keep me']);
      runtime.dequeue(a.id, sa, prompts[1]!.id, randomUUID());
      assert.deepEqual(learning.session(a.id, sa).messages[1]!.queuedPrompts, []);
    } finally { finish?.(); await runtime.close(); db.close(); }
  }
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
    assert.deepEqual(runtime.get(a.id, run.id).error, { code: 'RUN_STOPPED' });
    const pending = runtime.submit(b.id, sb, randomUUID(), message('pending'));
    await runtime.close();
    assert.equal(runtime.get(b.id, pending.run.id).state, 'interrupted'); assert.equal(calls, 1);
    assert.deepEqual(runtime.get(b.id, pending.run.id).error, { code: 'RUN_SHUTDOWN' });
  } finally { db.close(); }
});

test('a missing Skill fails asynchronously and retains its semantic error through events, session hydration and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-failure-'));
  let data = openDataDirectory(root), learning = new Learning(data.db);
  const space = learning.create({ name: 'Missing Skill', goal: 'Test a missing Skill' }), session = space.sessions[0]!.id;
  const skills = new SkillService(data.db, root);
  let requests = 0;
  let runtime = new TeachingRuntime(learning, syntheticSource, { skills,
    stream: () => { requests++; return response(reply([{ type: 'text', text: 'Must not start.' }])); } });
  try {
    const { run } = runtime.submit(space.id, session, randomUUID(), message('/skill:missing-fixture explain'));
    assert.equal(run.state, 'pending');
    await runtime.idle(run.id);
    const events = runtime.events(space.id, run.id).events;
    for (const reload of [false, true]) {
      if (reload) {
        await runtime.close(); await skills.close(); data.close();
        data = openDataDirectory(root); learning = new Learning(data.db);
        runtime = new TeachingRuntime(learning, syntheticSource);
      }
      const failed = runtime.get(space.id, run.id);
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.error, { code: 'SKILL_DISABLED_OR_MISSING' });
      assert.deepEqual(runtime.events(space.id, run.id).events, events);
      assert.deepEqual(events.at(-1)?.data, { type: 'state', state: 'failed', error: failed.error });
      const hydrated = learning.session(space.id, session).messages.find((m) => m.id === run.id)!;
      assert.equal(hydrated.status, 'error');
      assert.deepEqual(hydrated.error, failed.error);
      assert.equal(hydrated.sequence, events.at(-1)?.seq);
    }
    assert.equal(requests, 0);
  } finally { await runtime.close(); await skills.close(); data.close(); rmSync(root, { recursive: true, force: true }); }
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
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: events.length }, (_, i) => i + 3));
    assert.equal(events.filter((event) => event.data.type === 'text').length, 600);
    assert.equal(events.at(-1)?.data.state, 'succeeded', 'SSE must drain beyond its first 500-event page');
  } finally { complete?.(); await runtime.close(); db.close(); }
});

test('startup appends an interrupted event once and does not replay a pending request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-agent-restart-'));
  let data = openDataDirectory(root);
  try {
    const learning = new Learning(data.db), a = learning.create({ name: 'recovery', goal: 'only test' });
    const id = randomUUID();
    const prompt = { id: randomUUID(), text: 'keep this queued prompt', quote: null, createdAt: 1 };
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
      if (runId === id) events.push({ type: 'prompt_queued', prompt });
      events.forEach((event, index) => data.db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(a.id, runId, index + 1, JSON.stringify(event)));
    }
    data.close(); data = openDataDirectory(root);
    let runtime = new TeachingRuntime(new Learning(data.db), syntheticSource);
    assert.equal(runtime.get(a.id, id).state, 'interrupted');
    assert.deepEqual(runtime.get(a.id, id).error, { code: 'RUN_RESTARTED' });
    assert.equal(runtime.events(a.id, id).events.at(-1)?.data.type, 'state');
    assert.equal(runtime.get(a.id, task).state, 'interrupted');
    assert.deepEqual(runtime.get(a.id, task).error, { code: 'RUN_RESTARTED' });
    assert.equal(runtime.events(a.id, task).events.at(-1)?.data.type, 'state');
    data.close(); data = openDataDirectory(root); runtime = new TeachingRuntime(new Learning(data.db), syntheticSource);
    for (const runId of [id, task]) {
      const events = runtime.events(a.id, runId).events;
      assert.equal(events.length, runId === id ? 5 : 4);
      const recovered = runtime.get(a.id, runId);
      assert.deepEqual(recovered.error, { code: 'RUN_RESTARTED' });
      assert.deepEqual(events.at(-1)?.data, { type: 'state', state: 'interrupted', error: recovered.error });
      const parts = events.reduce<AgentDisplayPart[]>(applyAgentEvent, []);
      assert.deepEqual(parts, [
        { type: 'reasoning', id: `${runId}:1:reasoning:0`, text: 'Unfinished at shutdown', status: 'interrupted' },
        { type: 'tool', id: `${runId}:1:tool:unfinished`, name: 'read', status: 'interrupted' },
      ]);
      if (runId === id) {
        const saved = new Learning(data.db).session(a.id, a.sessions[0]!.id);
        assert.deepEqual(saved.messages.at(-1)?.parts, parts);
        assert.deepEqual(saved.messages.at(-1)?.error, recovered.error);
        assert.deepEqual(saved.messages.at(-1)?.queuedPrompts, [prompt]);
        runtime.dequeue(a.id, saved.id, prompt.id, randomUUID());
        assert.deepEqual(new Learning(data.db).session(a.id, saved.id).messages.at(-1)?.queuedPrompts, []);
      }
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
    assert.equal(options?.timeoutMs, 300_000);
    assert.equal(options?.maxRetryDelayMs, undefined, 'Use Pi provider defaults, not the former one-second cap');
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
    assert.deepEqual(JSON.parse(manifest.value).modelExecution.retry, { enabled: true, maxRetries: 3, baseDelayMs: 2000 });
    assert.equal(JSON.parse(manifest.value).budget.milliseconds, undefined);
  } finally { await runtime.close(); db.close(); }
});

test('each run freezes the model and reasoning level that were selected at its creation', async () => {
  const { db, learning, a, sa } = setup();
  const other = { ...teachingModel, id: 'other/model' };
  const first: ModelSelection = { provider: 'openrouter', model: teachingModel.id, thinkingLevel: 'high' };
  const second: ModelSelection = { provider: 'openrouter', model: other.id, thinkingLevel: 'low' };
  let active = first;
  const source: ModelSource = {
    ...syntheticSource,
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
    for (let i = 0; i < 100 && !runtime.events(a.id, run.id).events.some((event) => event.data.type === 'reasoning' && event.data.delta === 'Consider '); i++) await new Promise((r) => setTimeout(r, 1));
    const saved = new Learning(db).session(a.id, sa).messages.at(-1)!;
    assert.deepEqual(saved.parts?.at(-1), { type: 'reasoning', id: `${run.id}:1:reasoning:1`, text: 'Consider ', status: 'streaming' });
    assert.equal(saved.text, 'Preface. ');
    assert.equal(saved.sequence, runtime.events(a.id, run.id).events.at(-1)?.seq);
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
      for (let i = 0; i < 100 && !runtime.events(a.id, run.id).events.some((event) => event.data.type === 'reasoning' && event.data.delta === 'Unfinished'); i++) await new Promise((r) => setTimeout(r, 1));
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
    { type: 'state', state: 'failed', error: { code: 'MODEL_RUN_INVALID' } },
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

test('transient failures resume completed tools once and stay out of subsequent session context', async () => {
  const { db, learning, a, sa } = setup();
  let requests = 0, executions = 0, commits = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, {
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
    scenario: () => ({ tools: [{ name: 'read', label: 'read', description: 'Synthetic only', parameters: Type.Object({}),
      async execute() { executions++; return { content: [{ type: 'text', text: 'COMPLETE-TOOL-BODY' }], details: {} }; } }], commit() { commits++; } }),
    stream: (_m, context) => {
      requests++;
      if (requests === 1) return response(reply([{ type: 'toolCall', id: 'completed-call', name: 'read', arguments: {} }], 'toolUse'));
      if (requests === 2) return response({ ...reply([
        { type: 'text', text: 'FAILED-ATTEMPT-TEXT' },
        { type: 'toolCall', id: 'failed-call', name: 'read', arguments: {} },
      ], 'error'), errorMessage: '502 Connection error PRIVATE-DIAGNOSTICS' });
      assert.doesNotMatch(JSON.stringify(context), /FAILED-ATTEMPT-TEXT|failed-call|PRIVATE-DIAGNOSTICS/);
      const completed = context.messages.filter((m) => m.role === 'toolResult');
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.toolCallId, 'completed-call');
      if (requests === 3) assert.deepEqual(completed[0]?.content, [{ type: 'text', text: 'COMPLETE-TOOL-BODY' }]);
      else assert.match(JSON.stringify(completed[0]), /tool body omitted/);
      return response(reply([{ type: 'text', text: 'Recovered answer.' }]));
    },
  });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('read and recover'));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
    assert.equal(requests, 3); assert.equal(executions, 1); assert.equal(commits, 1);
    const raw = JSON.stringify(db.prepare('SELECT value FROM agent_messages WHERE run_id=?').all(run.id));
    assert.match(raw, /FAILED-ATTEMPT-TEXT|failed-call/);
    assert.doesNotMatch(raw, /PRIVATE-DIAGNOSTICS|COMPLETE-TOOL-BODY/);
    assert.equal(db.prepare('SELECT * FROM context_manifests WHERE run_id=?').all(run.id).length, 3);
    const session = learning.session(a.id, sa);
    const next = runtime.submit(a.id, sa, randomUUID(), message('continue', session.draft.revision));
    await runtime.idle(next.run.id);
    assert.equal(runtime.get(a.id, next.run.id).state, 'succeeded');
    assert.equal(requests, 4); assert.equal(executions, 1); assert.equal(commits, 2);
  } finally { await runtime.close(); db.close(); }
});

test('transient retry budgets reset after a successful assistant tool turn, including thrown transport failures', async () => {
  const { db, learning, a, sa } = setup();
  let requests = 0, executions = 0, commits = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, {
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
    scenario: () => ({ tools: [{ name: 'read', label: 'read', description: 'Synthetic only', parameters: Type.Object({}),
      async execute() { executions++; return { content: [], details: {} }; } }], commit() { commits++; } }),
    stream: () => {
      requests++;
      if (requests === 4) return response(reply([{ type: 'toolCall', id: 'recovered-call', name: 'read', arguments: {} }], 'toolUse'));
      if (requests === 8) return response(reply([{ type: 'text', text: 'Finished.' }]));
      if (requests === 2 || requests === 6) throw new Error('503 Network error');
      return response({ ...reply([], 'error'), errorMessage: '502 Connection error' });
    },
  });
  try {
    const { run } = runtime.submit(a.id, sa, randomUUID(), message('recover both turns'));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded');
    assert.equal(requests, 8); assert.equal(executions, 1); assert.equal(commits, 1);
  } finally { await runtime.close(); db.close(); }
});

test('exhausted retries, authentication, billing, context overflow and final text truncation never publish', async () => {
  for (const error of ['503 Service unavailable', '401 Invalid API key', '429 insufficient_quota billing', '503 maximum context length exceeded', 'length']) {
    const { db, learning, a, sa } = setup();
    let requests = 0, commits = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, {
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
      scenario: () => ({ tools: [], commit() { commits++; } }),
      stream: () => { requests++; return response({ ...reply([{ type: 'text', text: 'Incomplete.' }], error === 'length' ? 'length' : 'error'), errorMessage: error }); },
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(error));
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, 'failed');
      assert.equal(commits, 0); assert.equal(requests, error === '503 Service unavailable' ? 4 : 1);
    } finally { await runtime.close(); db.close(); }
  }
});

test('OAuth renewal errors give durable, actionable feedback without retaining provider bodies', async () => {
  const model = builtinModels().getModel('openai', 'gpt-6.1-sol')!;
  const selection = { provider: model.provider, model: model.id, thinkingLevel: 'high' as const };
  const source: ModelSource = { ...syntheticSource, current: () => ({ selection, model }), resolve: () => model };
  for (const [reason, expected, category] of [
    ['OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {"error":"invalid_grant","detail":"PRIVATE-REFRESH-TOKEN"}',
      { code: 'MODEL_OAUTH_REAUTH_REQUIRED', params: { provider: 'ChatGPT' } }, 'oauth_reauth_required'],
    ['OAuth refresh failed for openai: OpenAI OAuth token request failed (503): {"error":"server_error","detail":"invalid_grant PRIVATE-REFRESH-TOKEN"}',
      { code: 'MODEL_OAUTH_REFRESH_FAILED', params: { provider: 'ChatGPT' } }, 'oauth_refresh_failed'],
    ['400 {"error":"invalid_grant","detail":"PRIVATE-REFRESH-TOKEN"}',
      { code: 'MODEL_RESPONSE_INCOMPLETE' }, null],
  ] as const) {
    const { db, learning, a, sa } = setup();
    const runtime = new TeachingRuntime(learning, source, { retry: { enabled: false, maxRetries: 3, baseDelayMs: 0 },
      stream: () => response({ ...reply([], 'error'), errorMessage: reason }),
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('解释一个概念'));
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, 'failed');
      assert.deepEqual(runtime.get(a.id, run.id).error, expected);
      const events = runtime.events(a.id, run.id).events;
      assert.ok(events.some((event) => event.data.type === 'state' && event.data.error?.code === expected.code));
      const session = learning.session(a.id, sa);
      assert.deepEqual(session.messages.at(-1)?.error, expected);
      const manifest = JSON.parse((db.prepare('SELECT value FROM context_manifests WHERE request=1').get() as { value: string }).value);
      assert.equal(manifest.transport.failure?.category ?? null, category);
      if (category === 'oauth_reauth_required') {
        assert.equal(manifest.transport.failure.code, 'invalid_grant');
        assert.equal(manifest.transport.failure.status, 400);
      }
      assert.match(manifest.transport.errorFingerprint, /^[a-f0-9]{64}$/);
      const retained = db.prepare('SELECT value FROM agent_messages').all();
      const checkpoint = db.prepare('SELECT input FROM agent_runs').all();
      assert.doesNotMatch(JSON.stringify({ events, session, manifest, retained, checkpoint }), /PRIVATE-REFRESH-TOKEN|"detail"/);
    } finally { await runtime.close(); db.close(); }
  }
});

test('stop and shutdown interrupt retry backoff without another request or commit', async () => {
  for (const cause of ['stop', 'shutdown']) {
    const { db, learning, a, sa } = setup();
    let requests = 0, commits = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, {
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 },
      scenario: () => ({ tools: [], commit() { commits++; } }),
      stream: () => { requests++; return response({ ...reply([], 'error'), errorMessage: '503 Service unavailable' }); },
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(cause));
      await new Promise((r) => setImmediate(r));
      assert.equal(runtime.get(a.id, run.id).state, 'running');
      if (cause === 'stop') runtime.stop(a.id, run.id);
      else await runtime.close();
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, 'interrupted');
      const interrupted = runtime.get(a.id, run.id);
      assert.deepEqual(interrupted.error, { code: cause === 'stop' ? 'RUN_STOPPED' : 'RUN_SHUTDOWN' });
      assert.deepEqual(runtime.events(a.id, run.id).events.at(-1)?.data,
        { type: 'state', state: 'interrupted', error: interrupted.error });
      const hydrated = learning.session(a.id, sa).messages.at(-1)!;
      assert.equal(hydrated.status, 'stopped');
      assert.deepEqual(hydrated.error, interrupted.error);
      assert.equal(requests, 1); assert.equal(commits, 0);
    } finally { await runtime.close(); db.close(); }
  }
});

test('real Pi adapter streams tool arguments, replays them exactly, and never executes a failed stream', async () => {
  for (const mode of ['success', 'failure', 'retry', 'cancel', 'length'] as const) {
    const { db, learning, a, sa } = setup();
    const adapter = providerStream();
    let requests = 0, executions = 0, commits = 0, chunks = 0;
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'gen-synthetic-stream', object: 'chat.completion.chunk', created: 1,
      model: teachingModel.id, choices: [{ index: 0, delta, finish_reason }] });
    const runtime = new TeachingRuntime(learning, syntheticSource, {
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
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
      if (mode === 'failure' || mode === 'retry') wire.enqueue(encode({ error: { code: 502, message: mode === 'retry' ? '503 PRIVATE-PROVIDER-ERROR' : 'PRIVATE-PROVIDER-ERROR', metadata: { raw: 'PRIVATE-ERROR-BODY' } } }));
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
      const completed = mode === 'success' || mode === 'retry' || mode === 'length';
      assert.equal(commits, completed ? 1 : 0, mode);
      assert.equal(requests, completed ? 2 : 1, 'Only Pi-classified transient errors and truncated tool feedback may resume');
      assert.equal(runtime.get(a.id, run.id).state, mode === 'cancel' ? 'interrupted' : completed ? 'succeeded' : 'failed');
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
      if (mode === 'failure' || mode === 'retry') {
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

test('real HTTP stalls time out while continuously streaming bodies outlive the request timeout and remain cancellable', async () => {
  const globalFetch = globalThis.fetch;
  for (const mode of ['headers', 'idle', 'active', 'cancel'] as const) {
    const { db, learning, a, sa } = setup();
    let requests = 0, commits = 0, streamed!: () => void;
    const ready = new Promise<void>((resolve) => { streamed = resolve; });
    const server = createServer((req, res) => {
      requests++; req.resume();
      if (mode === 'headers') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (text: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'synthetic-http',
        choices: [{ index: 0, delta: { content: text }, finish_reason }] })}\n\n`;
      res.write(chunk('0|'));
      if (mode !== 'active') return;
      let index = 1;
      const timer = setInterval(() => {
        res.write(chunk(`${index++}|`));
        if (index === 40) { clearInterval(timer); res.end(chunk('', 'stop')); }
      }, 30);
      res.once('close', () => clearInterval(timer));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const model = { ...teachingModel, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
    const source: ModelSource = { ...syntheticSource, current: () => ({ selection: syntheticSource.current()!.selection, model }), resolve: () => model };
    const adapter = providerStream();
    const runtime = new TeachingRuntime(learning, source, {
      // Leave room for native dependency startup under concurrent CI load.
      // The active body still runs for over twice this idle timeout.
      httpIdleTimeoutMs: 500, retry: { enabled: false, maxRetries: 3, baseDelayMs: 0 },
      scenario: () => ({ tools: [], commit() { commits++; } }),
      stream: (model, context, options) => adapter(model, context, { ...options, apiKey: 'synthetic-private-key',
        onProviderStreamEvent: (...args) => { options?.onProviderStreamEvent?.(...args); streamed(); } }),
    });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(mode));
      if (mode === 'cancel') { await ready; runtime.stop(a.id, run.id); }
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, mode === 'active' ? 'succeeded' : mode === 'cancel' ? 'interrupted' : 'failed', mode);
      assert.equal(requests, 1); assert.equal(commits, mode === 'active' ? 1 : 0);
      if (mode === 'active') assert.equal(learning.session(a.id, sa).messages.at(-1)?.text, Array.from({ length: 40 }, (_, i) => `${i}|`).join(''));
      const manifest = JSON.parse((db.prepare('SELECT value FROM context_manifests').get() as { value: string }).value);
      assert.equal(manifest.modelExecution.httpIdleTimeoutMs, 500); assert.equal(manifest.modelExecution.timeoutMs, 500);
      assert.equal(manifest.transport.httpStatus, mode === 'headers' ? null : 200);
      assert.equal(globalThis.fetch, globalFetch);
    } finally { await runtime.close(); db.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('Google and native SDK transports are not given an unsupported scoped fetch', async () => {
  const models = builtinModels(), adapter = providerStream(models);
  for (const provider of ['google', 'google-vertex', 'amazon-bedrock']) {
    const { db, learning, a, sa } = setup();
    const model = models.getModels(provider)[0]!;
    const selection: ModelSelection = { provider, model: model.id, thinkingLevel: 'off' };
    const source: ModelSource = { ...syntheticSource, current: () => ({ selection, model }), resolve: () => model };
    let providerError: string | undefined;
    const runtime = new TeachingRuntime(learning, source, { scenario: () => ({ tools: [], commit() {} }), stream: async (model, context, options) => {
      const stream = await adapter(model, context, { ...options, apiKey: 'synthetic-private-key',
        onPayload() { throw new Error('Stopped before network transport'); } });
      providerError = (await stream.result()).errorMessage;
      return stream;
    } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message(provider));
      await runtime.idle(run.id);
      assert.equal(providerError, 'Stopped before network transport', 'Native adapters must reach payload construction, not reject fetch injection');
      assert.equal(runtime.get(a.id, run.id).state, 'failed');
      const manifest = JSON.parse((db.prepare('SELECT value FROM context_manifests').get() as { value: string }).value);
      assert.equal(manifest.modelExecution.httpIdleTimeoutMs, null, 'Do not claim scoped HTTP protection on native SDK paths');
    } finally { await runtime.close(); db.close(); }
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
      assert.deepEqual(failed.error, { code: 'TOOL_NAME_CONFLICT' });
      assert.doesNotMatch(JSON.stringify(failed.error), /PRIVATE-FIRST-DESCRIPTION/);
      assert.deepEqual({ requests, executions, commits }, { requests: 0, executions: 0, commits: 0 });
      assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM context_manifests').get()!.n, 0);
      assert.deepEqual(learning.space(a.id).requirement, requirement);
    } finally { await runtime.close(); db.close(); }
  }
});

test('each request records the same run tool inventory while provider selection happens only once', async () => {
  const { db, learning, a, sa } = setup(), root = mkdtempSync(join(tmpdir(), 'tmc-tool-inventory-'));
  const mcp = new McpService(join(root, 'mcp.json'), { cwd: root });
  const search = new SearchService(join(root, 'search.json'));
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
        // Pi advertises JSON input schemas; outputSchema remains on executable tools.
        name: mcpTool.name, description: 'PRIVATE-MCP-DESCRIPTION', parameters: JSON.parse(JSON.stringify(mcpTool.parameters)),
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
    // The request that issued a read retains its consumed-source receipt too,
    // even if the next request never happens (for example, on failure or stop).
    assert.deepEqual(manifests.map((manifest) => manifest.toolSources.map((s: { callId: string }) => s.callId)),
      [['fixed-mcp'], ['fixed-mcp', 'fixed-search'], ['fixed-mcp', 'fixed-search']]);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM agent_messages').all()), /PRIVATE-MCP-BODY|PRIVATE-SEARCH-BODY|PRIVATE-SKILL-BODY/);
  } finally { await Promise.all([runtime.close(), mcp.close(), skills.close()]); search.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stopping during search tool selection rejects late tools without a model request or commit', async () => {
  const { db, learning, a, sa } = setup(), root = mkdtempSync(join(tmpdir(), 'tmc-tool-selection-'));
  const search = new SearchService(join(root, 'search.json'));
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

// Real document bytes and native parsing; only the model's tool choices are scripted.
for (const sample of [
  { name: 'DOCX', fixture: 'library-reference.docx', missingParser: false,
    paragraphs: ['资料库 DOCX 正文', 'Reading reference DOCX-7319', '表达式：A&B < C', '蓝色=17', '橙色=29'] },
  { name: 'multi-page PDF', fixture: 'library-reference.pdf', missingParser: false,
    paragraphs: ['资料库 PDF 正文', 'Reference PDF-4826', '表达式：A&B < C', '第二页事实：蓝色 17，橙色 29。', 'Second-page code: PDF-PAGE2-9281'] },
  { name: 'image-only PDF without OCR', fixture: 'library-scanned.pdf', missingParser: false, paragraphs: [] },
  { name: 'PDF with a missing parser', fixture: 'library-reference.pdf', missingParser: true, paragraphs: [] },
]) test(`uploaded documents reach the teaching Agent through native tools: ${sample.name}`, async () => {
  const { db, learning, a, sa } = setup(), root = mkdtempSync(join(tmpdir(), "tmc-library docs-'"));
  const library = new Library(root), outputPath = join(root, 'extracted text.txt');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const filename = `课程参考 'A&B'.${sample.fixture.endsWith('.docx') ? 'docx' : 'pdf'}`;
  const runtime = new TeachingRuntime(learning, syntheticSource, { library, stream: (_model, context) => {
    const last = context.messages.filter((m) => m.role === 'toolResult').at(-1);
    const call = (name: string, args: Record<string, string>) => response(reply([{ type: 'toolCall', id: randomUUID(), name, arguments: args }], 'toolUse'));
    if (!last) return call('list_library_files', {});
    const output = last.content.map((p) => p.type === 'text' ? p.text : '').join('');
    if (last.toolName === 'list_library_files') {
      assert.equal(last.isError, false, output);
      const listing = JSON.parse(output);
      const file = listing.files.find((file: { name: string }) => file.name === filename);
      assert.ok(file, 'The Agent must discover the uploaded document, not a pre-supplied source body.');
      const source = quote(file.path);
      const command = sample.missingParser
        ? `PATH=${quote(join(root, 'no-parsers'))} pdftotext ${source} -`
        : sample.fixture.endsWith('.docx') ? `python3 -X utf8 - ${source} > ${quote(outputPath)} <<'PY'
import sys
from zipfile import ZipFile
from xml.etree import ElementTree
with ZipFile(sys.argv[1]) as archive:
    document = ElementTree.fromstring(archive.read('word/document.xml'))
namespace = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
for paragraph in document.findall('.//w:p', namespace):
    print(''.join(node.text or '' for node in paragraph.findall('.//w:t', namespace)))
PY` : `pdftotext -enc UTF-8 -nopgbrk ${source} ${quote(outputPath)}`;
      return call('bash', { command });
    }
    if (last.toolName === 'bash') {
      if (sample.missingParser) {
        assert.equal(last.isError, true, 'A missing parser must not produce a successful tool result.');
        assert.match(output, /pdftotext/);
        assert.match(output, /Command exited with code 127/);
        return response(reply([{ type: 'text', text: `未提取正文，解析工具不可用：\n${output}` }]));
      }
      assert.equal(last.isError, false, `Native parser failed; these tests require python3 and pdftotext:\n${output}`);
      return call('read', { path: outputPath });
    }
    assert.equal(last.toolName, 'read');
    assert.equal(last.isError, false, output);
    const body = JSON.parse(output).text as string;
    return response(reply([{ type: 'text', text: body.trim() || '未提取到文字层，需要 OCR。' }]));
  } });
  try {
    const access = createLocalAccess({ port: 14333 });
    const app = createApp(access, learning, undefined, runtime, undefined, undefined, undefined, undefined, library);
    const bytes = readFileSync(new URL(`../../../../tests/fixtures/${sample.fixture}`, import.meta.url));
    const uploaded = await app.request(`/api/library/files?name=${encodeURIComponent(filename)}`, {
      method: 'POST', headers: { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token, 'Idempotency-Key': randomUUID() },
      body: Uint8Array.from(bytes).buffer,
    });
    assert.equal(uploaded.status, 201);
    const { run } = runtime.submit(a.id, sa, randomUUID(), message(`读取资料库中的 ${filename}，只引用实际提取的正文；不能读取时说明限制。`));
    await runtime.idle(run.id);
    assert.equal(runtime.get(a.id, run.id).state, 'succeeded', JSON.stringify(runtime.get(a.id, run.id).error));
    const answer = learning.session(a.id, sa).messages.at(-1)!.text;
    if (sample.missingParser) {
      assert.match(answer, /^未提取正文，解析工具不可用：/);
      assert.match(answer, /pdftotext/);
      assert.doesNotMatch(answer, /PDF-4826|PDF-PAGE2-9281/);
    } else if (sample.paragraphs.length) {
      // Ignore layout whitespace, not content, order, XML entities, tables or later pages.
      assert.equal(answer.replace(/\s+/g, ''), sample.paragraphs.join('').replace(/\s+/g, ''));
    } else {
      assert.equal(answer, '未提取到文字层，需要 OCR。');
      assert.equal(readFileSync(outputPath, 'utf8').trim(), '');
    }
  } finally { await runtime.close(); await library.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native default compaction uses the strict reserve boundary, counts summary usage and never replays a completed reply', async () => {
  for (const total of [49_152, 49_153]) {
    const { db, learning, a, sa } = setup();
    const model = { ...teachingModel, contextWindow: 65_536 };
    const source: ModelSource = { ...syntheticSource, current: () => ({ selection: syntheticSource.current()!.selection, model }), resolve: () => model };
    let requests = 0, summaries = 0, commits = 0;
    const answer = 'Completed answer. ' + 'x'.repeat(85_000);
    const runtime = new TeachingRuntime(learning, source, { scenario: () => ({ tools: [], commit() { commits++; } }),
      stream: (_model, context, options) => {
        const summary = options?.maxTokens !== undefined;
        if (summary) {
          summaries++;
          assert.ok(!context.messages.some((m) => m.role === 'system' && m.toolsAdded?.length), 'Summary requests must not receive teaching tools');
        } else requests++;
        const result = reply([{ type: 'text', text: summary ? 'NATIVE-CHECKPOINT-ONLY' : answer }]);
        return response({ ...result, timestamp: Date.now(), usage: summary
          ? { input: 83, output: 29, cacheRead: 13, cacheWrite: 5, totalTokens: 130, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0034 } }
          : { input: total - 17, output: 17, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } } });
      } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('Check the native threshold.'));
      await runtime.idle(run.id);
      const final = runtime.get(a.id, run.id);
      assert.equal(final.state, 'succeeded', JSON.stringify(final.error));
      assert.equal(requests, 1); assert.equal(commits, 1);
      assert.equal(summaries > 0, total === 49_153);
      assert.equal(final.context?.tokens, summaries ? null : 49_152);
      assert.equal(final.context?.phase, summaries ? 'compacted' : 'ready');
      assert.deepEqual(final.context?.usage, { input: total - 17 + summaries * 83, output: 17 + summaries * 29,
        cacheRead: summaries * 13, cacheWrite: summaries * 5, cost: 0.0123 + summaries * 0.0034 });
      const hydrated = learning.session(a.id, sa).messages.at(-1)!;
      assert.equal(hydrated.text, answer); assert.deepEqual(hydrated.context, final.context);
      assert.doesNotMatch(JSON.stringify(runtime.events(a.id, run.id)), /NATIVE-CHECKPOINT-ONLY/);
      const manifests = (db.prepare('SELECT value FROM context_manifests ORDER BY request').all() as { value: string }[]).map((r) => JSON.parse(r.value));
      assert.equal(manifests[0].purpose, 'agent');
      assert.ok(manifests.slice(1).every((m) => m.purpose === 'compaction'));
      assert.deepEqual(manifests[0].modelExecution.compaction, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
    } finally { await runtime.close(); db.close(); }
  }
});

test('successive native compactions survive restart without resurrecting raw history or stale teaching baselines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-session-compaction-'));
  let data = openDataDirectory(root), learning = new Learning(data.db);
  const space = learning.create({ name: 'Persistent compaction', goal: 'Learning continuity' }), session = space.sessions[0]!.id;
  const model = { ...teachingModel, contextWindow: 65_536 };
  const source: ModelSource = { ...syntheticSource, current: () => ({ selection: syntheticSource.current()!.selection, model }), resolve: () => model };
  let requests = 0, summaries = 0;
  const runtimeOptions = { compaction: { reserveTokens: 1000, keepRecentTokens: 64 },
    scenario: () => ({ tools: [], commit() {} }),
    stream: async (_model: Parameters<NonNullable<ModelSource['stream']>>[0], context: Parameters<NonNullable<ModelSource['stream']>>[1], options?: Parameters<NonNullable<ModelSource['stream']>>[2]) => {
      await new Promise((resolve) => setTimeout(resolve, 2)); // Native responses must be newer than the previous compaction.
      if (options?.maxTokens !== undefined) {
        summaries++;
        return response({ ...reply([{ type: 'text', text: `PERSISTED-CHECKPOINT-${summaries}` }]), timestamp: Date.now() });
      }
      requests++;
      if (requests > 1) {
        assert.match(JSON.stringify(context), /PERSISTED-CHECKPOINT-/);
        assert.doesNotMatch(JSON.stringify(context), /FIRST-RAW-PROMPT/);
      }
      if (requests === 3) {
        assert.doesNotMatch(JSON.stringify(context), /SECOND-RAW-PROMPT|OLD-BASELINE/);
        assert.match(JSON.stringify(context), /LATEST-BASELINE/);
      }
      const result = reply([{ type: 'text', text: requests < 3 ? 'Retained tail. ' + 'y'.repeat(800) : 'Continue from the saved summary.' }]);
      return response({ ...result, timestamp: Date.now(), usage: { ...result.usage, input: requests < 3 ? 64_550 : 11,
        totalTokens: requests < 3 ? 64_557 : 18 } });
    } };
  let runtime = new TeachingRuntime(learning, source, runtimeOptions);
  try {
    learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: 'Goal', answer: 'OLD-BASELINE' }] } });
    for (const text of ['FIRST-RAW-PROMPT', 'SECOND-RAW-PROMPT']) {
      const { run } = runtime.submit(space.id, session, randomUUID(), message(text, learning.session(space.id, session).draft.revision));
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'succeeded', JSON.stringify(runtime.get(space.id, run.id).error));
      assert.equal(runtime.get(space.id, run.id).context?.phase, 'compacted');
      await runtime.close(); data.close();
      data = openDataDirectory(root); learning = new Learning(data.db); runtime = new TeachingRuntime(learning, source, runtimeOptions);
    }
    learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, value: { rows: [{ question: 'Goal', answer: 'LATEST-BASELINE' }] } });
    const { run } = runtime.submit(space.id, session, randomUUID(), message('Continue after restart.', learning.session(space.id, session).draft.revision));
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded', JSON.stringify(runtime.get(space.id, run.id).error));
    assert.equal(requests, 3); assert.ok(summaries >= 2);
    assert.equal(learning.session(space.id, session).messages.at(-1)?.text, 'Continue from the saved summary.');
    assert.ok(runtime.get(space.id, run.id).context?.tokens !== null);
  } finally { await runtime.close(); data.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native overflow recovery compacts and retries once without re-executing completed tools', async () => {
  for (const recovered of [true, false]) {
    const { db, learning, a, sa } = setup();
    let requests = 0, summaries = 0, executions = 0, commits = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { compaction: { keepRecentTokens: 256 },
      scenario: () => ({ tools: [{ name: 'read', label: 'Read', description: 'Read a fixture', parameters: Type.Object({}),
        async execute() { executions++; return { content: [{ type: 'text', text: 'Completed tool result: 47' }], details: {} }; } }], commit() { commits++; } }),
      stream: async (_model, context, options) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (options?.maxTokens !== undefined) { summaries++; return response({ ...reply([{ type: 'text', text: 'OVERFLOW-CHECKPOINT-ONLY' }]), timestamp: Date.now() }); }
        requests++;
        const result = requests === 1 ? reply([{ type: 'text', text: 'Prior conversation. ' + 'z'.repeat(4000) }])
          : requests === 2 ? reply([{ type: 'toolCall', id: 'once-only', name: 'read', arguments: {} }], 'toolUse')
          : requests === 3 || !recovered ? { ...reply([], 'error'), errorMessage: 'maximum context length exceeded PRIVATE-PROVIDER-BODY', usage: { ...reply([]).usage, input: 0, output: 0, totalTokens: 0 } }
          : reply([{ type: 'text', text: 'Recovered answer.' }]);
        if (requests === 4) {
          assert.match(JSON.stringify(context), /OVERFLOW-CHECKPOINT-ONLY/);
          assert.match(JSON.stringify(context), /Completed tool result: 47/);
          assert.doesNotMatch(JSON.stringify(context), /PRIVATE-PROVIDER-BODY/);
        }
        return response({ ...result, timestamp: Date.now() });
      } });
    try {
      const first = runtime.submit(a.id, sa, randomUUID(), message('Seed history.'));
      await runtime.idle(first.run.id);
      assert.equal(runtime.get(a.id, first.run.id).state, 'succeeded');
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('Use the tool and recover.', 1));
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, recovered ? 'succeeded' : 'failed');
      assert.equal(requests, 4); assert.ok(summaries > 0); assert.equal(executions, 1); assert.equal(commits, recovered ? 2 : 1);
      assert.equal(runtime.get(a.id, run.id).context?.compaction?.reason, 'overflow');
      assert.doesNotMatch(JSON.stringify({ events: runtime.events(a.id, run.id), session: learning.session(a.id, sa) }), /PRIVATE-|OVERFLOW-CHECKPOINT-ONLY/);
    } finally { await runtime.close(); db.close(); }
  }
});

test('failed or cancelled compaction keeps the original context and never exposes summary diagnostics', async () => {
  for (const cancel of [false, true]) {
    const { db, learning, a, sa } = setup();
    let entered!: () => void, summaryStream = createAssistantMessageEventStream(), requests = 0, commits = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = new TeachingRuntime(learning, syntheticSource, { compaction: { reserveTokens: 1000, keepRecentTokens: 64 },
      scenario: () => ({ tools: [], commit() { commits++; } }), stream: (_model, _context, options) => {
        if (options?.maxTokens !== undefined) {
          entered();
          if (cancel) return summaryStream;
          return response({ ...reply([], 'error'), errorMessage: '401 PRIVATE-SUMMARY-ERROR' });
        }
        requests++;
        const result = reply([{ type: 'text', text: 'Original completed answer. ' + 'a'.repeat(800) }]);
        return response({ ...result, timestamp: Date.now(), usage: { ...result.usage, input: teachingModel.contextWindow - 1000, totalTokens: teachingModel.contextWindow - 993 } });
      } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('Summarize this turn.'));
      await started;
      assert.equal(runtime.get(a.id, run.id).context?.phase, 'compacting');
      if (cancel) { runtime.stop(a.id, run.id); summaryStream.push({ type: 'error', reason: 'aborted', error: reply([], 'aborted') }); }
      await runtime.idle(run.id);
      const final = runtime.get(a.id, run.id);
      assert.equal(final.state, cancel ? 'interrupted' : 'succeeded');
      assert.equal(final.context?.phase, cancel ? 'interrupted' : 'failed');
      assert.equal(commits, cancel ? 0 : 1); assert.equal(requests, 1);
      assert.doesNotMatch(JSON.stringify({ final, session: learning.session(a.id, sa), events: runtime.events(a.id, run.id),
        manifests: db.prepare('SELECT value FROM context_manifests').all() }), /PRIVATE-SUMMARY-ERROR/);
    } finally { summaryStream.end(); await runtime.close(); db.close(); }
  }
});

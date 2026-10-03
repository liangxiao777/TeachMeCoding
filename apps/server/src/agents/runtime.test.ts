import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { openDataDirectory } from '../storage/data-directory.js';
import { createApp } from '../http/app.js';
import { createLocalAccess } from '../http/local-access.js';
import { serverConfig } from '../config/server.js';
import { TeachingRuntime } from './runtime.js';
import { reply, response, syntheticConfig } from './test-support.js';

function setup() {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const a = learning.create({ name: 'A', goal: '独立事实 A' }), b = learning.create({ name: 'B', goal: '独立事实 B' });
  return { db, learning, a, b, sa: a.sessions[0]!.id, sb: b.sessions[0]!.id };
}
const message = (text: string, draftRevision = 0) => ({ text, quote: null, draftRevision });

test('runs isolate sessions, reject concurrency, replay durable cursors and deduplicate submissions', async () => {
  const { db, learning, a, b, sa, sb } = setup();
  const contexts: string[] = [];
  const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: (_m, context) => {
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
  const runtime = new TeachingRuntime(learning, syntheticConfig, { scenario: () => ({ tools: [], commit: () => { commits++; } }), stream: () => {
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

test('tool-result second request is budgeted; persisted messages omit source body', async () => {
  for (const size of [24, 40_000]) {
    const { db, learning, a, sa } = setup(); let requests = 0;
    const tool: AgentTool = { name: 'read', label: 'Read', description: 'Synthetic only', parameters: Type.Object({}),
      async execute() { return { content: [{ type: 'text', text: `SOURCE-MARKER-${'x'.repeat(size)}` }], details: {} }; } };
    const runtime = new TeachingRuntime(learning, syntheticConfig, { scenario: () => ({ tools: [tool], commit() {} }), stream: (_m, context) => {
      requests++;
      if (requests === 1) return response(reply([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 'toolUse'));
      assert.match(JSON.stringify(context), /SOURCE-MARKER/);
      return response(reply([{ type: 'text', text: 'finished' }]));
    } });
    try {
      const { run } = runtime.submit(a.id, sa, randomUUID(), message('read'));
      await runtime.idle(run.id);
      assert.equal(runtime.get(a.id, run.id).state, size === 24 ? 'succeeded' : 'failed');
      assert.equal(requests, size === 24 ? 2 : 1);
      const stored = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
      assert.ok(!stored.includes('SOURCE-MARKER')); assert.match(stored, /call-1/); assert.match(stored, /omitted/);
      if (size === 24) assert.equal(db.prepare('SELECT * FROM context_manifests').all().length, 2);
    } finally { await runtime.close(); db.close(); }
  }
});

test('protected SSE reconnect reads missing events and disconnect does not stop a run', async () => {
  const { db, learning, a, sa } = setup();
  let complete!: () => void;
  const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: () => {
    const stream = createAssistantMessageEventStream();
    complete = () => stream.push({ type: 'done', reason: 'stop', message: reply([]) }); return stream;
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
    const text = await replay.text(); assert.match(text, /"seq":3/); assert.ok(!text.includes('"seq":1'));
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
    data.close(); data = openDataDirectory(root);
    let runtime = new TeachingRuntime(new Learning(data.db), syntheticConfig);
    assert.equal(runtime.get(a.id, id).state, 'interrupted');
    assert.equal(runtime.events(a.id, id).events[0]?.data.type, 'state');
    data.close(); data = openDataDirectory(root); runtime = new TeachingRuntime(new Learning(data.db), syntheticConfig);
    assert.equal(runtime.events(a.id, id).events.length, 1);
  } finally { data.close(); rmSync(root, { recursive: true, force: true }); }
});

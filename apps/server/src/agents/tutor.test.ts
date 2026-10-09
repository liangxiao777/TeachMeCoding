import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-ai';
import { applyAgentEvent, type AgentDisplayPart } from '@teach-me-coding/contracts';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { TeachingRuntime } from './runtime.js';
import { populated, reply, response, syntheticSource } from './test-support.js';
import { readTools } from './read-tools.js';

test('a large lesson tool call reaches the final reply and commits the complete lesson', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l), unit = units[0]!.id;
  const lesson: JsonObject = { title: '长课件', content: `  独立生成检查\n\n## 理解参数\n\n开始-${'理解参数与返回值。'.repeat(5000)}-结束\n\n\`\`\`python file=greet.py\ndef greet(name="Ada"):\n    return "Hi " + name\n\`\`\`\n\n## 理解参数\n\n:::unknown\n未识别的增强也保留正文\n` };
  let requests = 0;
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context, options) => {
    assert.equal(options?.reasoning, 'high');
    const tool = context.messages.find((m) => m.role === 'system')?.toolsAdded?.find((t) => t.name === 'submit_lesson');
    const schema = JSON.parse(JSON.stringify(tool!.parameters));
    assert.deepEqual(Object.keys(schema.properties), ['title', 'content']);
    assert.deepEqual(schema.required, ['title', 'content']);
    requests++;
    if (requests === 1) return response(reply([
      { type: 'thinking', thinking: 'Plan the lesson', thinkingSignature: 'TASK-PRIVATE-SIGNATURE' },
      { type: 'text', text: 'Preparing lesson. ' },
      { type: 'toolCall', id: 'large-lesson', name: 'submit_lesson', arguments: lesson },
    ], 'toolUse'));
    const call = context.messages.flatMap((m) => m.role === 'assistant' ? m.content : []).find((part) => part.type === 'toolCall');
    assert.ok(call?.type === 'toolCall'); assert.deepEqual(call.arguments, lesson);
    const result = context.messages.at(-1);
    assert.ok(result?.role === 'toolResult'); assert.equal(result.isError, false);
    assert.equal(l.unit(space.id, unit).lesson, null, 'Keep the existing commit-after-success contract');
    return response(reply([{ type: 'thinking', thinking: 'Check the lesson' }, { type: 'text', text: '课件已整理。' }]));
  } });
  try {
    const task = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 0 });
    await runtime.idle(task.id);
    assert.equal(runtime.get(space.id, task.id).state, 'succeeded'); assert.equal(requests, 2);
    const saved = l.unit(space.id, unit).lesson!;
    assert.equal(saved.revision, 1); assert.equal(saved.title, lesson.title); assert.equal(saved.content, lesson.content);
    assert.equal(saved.intro, undefined); assert.equal(saved.blocks, undefined);
    assert.equal(db.prepare('SELECT * FROM task_manifests').all().length, 2);
    const events = runtime.events(space.id, task.id).events;
    const parts = events.reduce<AgentDisplayPart[]>(applyAgentEvent, []);
    assert.deepEqual(parts.map((part) => part.type), ['reasoning', 'text', 'tool', 'reasoning', 'text']);
    assert.deepEqual(parts.filter((part) => part.type === 'reasoning').map((part) => part.status), ['done', 'done']);
    assert.equal(parts.filter((part) => part.type === 'text').map((part) => part.text).join(''), 'Preparing lesson. 课件已整理。');
    assert.equal(new Set(parts.map((part) => part.id)).size, 5);
    assert.deepEqual(parts.find((part) => part.type === 'tool')?.input, lesson);
    assert.doesNotMatch(JSON.stringify(events), /TASK-PRIVATE-SIGNATURE/);
    assert.equal(db.prepare('SELECT * FROM messages').all().length, 0, 'Tasks publish activity without creating chat messages');
    assert.deepEqual(runtime.events(space.id, task.id, events.at(-1)!.seq).events, []);
  } finally { await runtime.close(); db.close(); }
});

test('independent lesson tasks are idempotent, preserve old versions and reject late writes', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l), unit = units[0]!.id;
  const legacy = { title: 'legacy', content: '', intro: 'original intro', blocks: [
    { type: 'h2', id: 'old-heading', text: 'Original section' }, { type: 'p', text: 'original text' },
  ] };
  l.saveLesson(space.id, unit, legacy);
  let mode = 'good';
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    assert.ok(!JSON.stringify(context).includes('private-chat-marker'));
    if (context.messages.at(-1)?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'lesson', name: 'submit_lesson', arguments:
      { title: 'Markdown lesson', content: mode === 'blank' ? '  \r\n ' : '## Arguments\n\n```python\nprint(13)\n```' },
    }], 'toolUse'));
    if (mode === 'late') l.saveLesson(space.id, unit, { title: 'user replacement', content: 'newer valid text' });
    return response(reply([{ type: 'text', text: 'done' }], mode === 'fail' ? 'error' : 'stop'));
  } });
  try {
    const key = randomUUID(), task = runtime.generate(space.id, unit, key, { kind: 'lesson', revision: 1 });
    assert.equal(runtime.generate(space.id, unit, key, { kind: 'lesson', revision: 1 }).id, task.id);
    assert.equal(task.sessionId, null);
    assert.throws(() => runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1 }), /已有/);
    await runtime.idle(task.id);
    assert.equal(runtime.get(space.id, task.id).state, 'succeeded');
    assert.equal(l.unit(space.id, unit).lesson?.revision, 2);
    assert.equal(l.unit(space.id, unit).lesson?.content, '## Arguments\n\n```python\nprint(13)\n```');
    assert.equal(l.unit(space.id, unit).lesson?.blocks, undefined);
    assert.equal(l.space(space.id).sessions.length, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
    for (mode of ['blank', 'fail', 'late']) {
      const task = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 2 });
      await runtime.idle(task.id);
      assert.equal(runtime.get(space.id, task.id).state, 'failed');
      assert.equal(l.unit(space.id, unit).lesson?.title, mode === 'late' ? 'user replacement' : 'Markdown lesson');
    }
    assert.deepEqual(JSON.parse((db.prepare('SELECT content FROM lesson_versions WHERE revision=1').get() as { content: string }).content), legacy);
  } finally { await runtime.close(); db.close(); }
});

test('only same-space adopted valid conclusions enter new sessions; revoke and source changes invalidate them', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), a = populated(l, 'A'), b = populated(l, 'B');
  let propose = true, saw = '';
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    saw = JSON.stringify(context);
    if (propose && context.messages.at(-1)?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'conclusion', name: 'submit_learning_conclusion', arguments: { text: 'ADOPTED-ARGUMENT-FACT' } }], 'toolUse'));
    return response(reply([{ type: 'text', text: 'explanation' }]));
  } });
  const ask = async (space: string, unit: string, text: string) => {
    const s = l.createSession(space, { scope: 'unit', unitId: unit, title: 'new session' });
    const { run } = runtime.submit(space, s.id, randomUUID(), { text, quote: null, draftRevision: 0 });
    await runtime.idle(run.id); assert.equal(runtime.get(space, run.id).state, 'succeeded');
  };
  try {
    await ask(a.space.id, a.units[0]!.id, 'private-chat-marker'); propose = false;
    await ask(a.space.id, a.units[1]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT')); assert.ok(!saw.includes('private-chat-marker'));
    const c = l.conclusions(a.space.id)[0]!;
    l.decideConclusion(a.space.id, c.id, { revision: 0, adopted: true });
    await ask(a.space.id, a.units[1]!.id, 'next'); assert.match(saw, /ADOPTED-ARGUMENT-FACT/); assert.ok(!saw.includes('private-chat-marker'));
    await ask(b.space.id, b.units[0]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT'));
    assert.throws(() => l.decideConclusion(b.space.id, c.id, { revision: 1, adopted: false }), /不存在/);
    l.decideConclusion(a.space.id, c.id, { revision: 1, adopted: false });
    await ask(a.space.id, a.units[1]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT'));
    l.decideConclusion(a.space.id, c.id, { revision: 2, adopted: true });
    l.saveLesson(a.space.id, a.units[0]!.id, { title: 'changed source', content: 'changed' });
    await ask(a.space.id, a.units[1]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT'));
  } finally { await runtime.close(); db.close(); }
});

test('OS reads permit parent, absolute, home and symlink credential-named fixtures with bounded pages and version changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-read-')), cwd = join(root, 'project'); mkdirSync(cwd);
  const file = join(root, '.env'); writeFileSync(file, 'SYNTHETIC-SOURCE-BODY\nsecond line'); symlinkSync(file, join(cwd, 'link'));
  const read = readTools(cwd).find((t) => t.name === 'read')!;
  const get = async (path: string, offset = 0, limit = 4096) => {
    const value = await read.execute('read', { path, offset, limit });
    assert.equal(value.content[0]?.type, 'text');
    return JSON.parse((value.content[0] as { text: string }).text);
  };
  try {
    const first = await get('../.env');
    for (const path of [file, 'link', `~/${relative(homedir(), file)}`]) assert.equal((await get(path)).text, first.text);
    const page = await get(file, 4, 7); assert.equal(page.text, 'HETIC-S'); assert.equal(page.nextOffset, 11);
    writeFileSync(file, 'changed-version'); assert.notEqual((await get(file)).source.version, first.source.version);
    assert.deepEqual(readTools(cwd).map((t) => t.name), ['read', 'ls', 'find', 'grep']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automatic source body is not copied to native history or manifests but provenance and protocol pairs persist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-retention-')); writeFileSync(join(root, 'sample.py'), 'SYNTHETIC-SOURCE-BODY');
  const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l);
  const s = l.createSession(space.id, { scope: 'unit', unitId: units[0]!.id, title: 'read' }); let observed = false;
  const runtime = new TeachingRuntime(l, syntheticSource, { projectDirectory: () => root, stream: (_m, context) => {
    if (context.messages.at(-1)?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'sample.py' } }], 'toolUse'));
    observed = JSON.stringify(context).includes('SYNTHETIC-SOURCE-BODY');
    return response(reply([{ type: 'text', text: 'Read completed without copying source.' }]));
  } });
  try {
    const { run } = runtime.submit(space.id, s.id, randomUUID(), { text: 'inspect sample.py', quote: null, draftRevision: 0 });
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded'); assert.ok(observed);
    for (const table of ['agent_messages', 'context_manifests', 'agent_events']) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('SYNTHETIC-SOURCE-BODY'));
    const native = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all()); assert.match(native, /tool body omitted/); assert.match(native, /toolCallId/);
    assert.match(JSON.stringify(db.prepare('SELECT value FROM context_manifests WHERE request=2').get()), /capturedAt/);
  } finally { await runtime.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

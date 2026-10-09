import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Type, validateToolArguments, type JsonObject, type ToolCall } from '@earendil-works/pi-ai';
import { applyAgentEvent, type AgentDisplayPart } from '@teach-me-coding/contracts';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { McpService } from '../extensions/mcp.js';
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

test('tool errors reach the model and remain visible without discarding a valid lesson in either call order', async () => {
  for (const error of ['validation', 'execution', 'result', 'fetch', 'replacement'] as const) {
    for (const order of ['before', 'after'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'tmc-tool-error-'));
      const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l), unit = units[0]!.id;
      const lesson = { title: 'Handling errors', content: '## Reading files\n\nKeep the useful result and explain a failed lookup.\n' };
      const mcp = new McpService(join(root, 'mcp.json'), { env: () => undefined, cwd: root });
      mcp.tools = async () => [{ name: 'mcp__fixture__lookup', label: 'Lookup', description: 'Synthetic lookup',
        parameters: Type.Object({ count: Type.Number() }), async execute() {
          if (error !== 'result') throw new Error('Lookup unavailable.');
          return { content: [{ type: 'text', text: 'Lookup unavailable.' }], isError: true, details: {} };
        } }];
      let rejected: ToolCall = { type: 'toolCall', id: 'rejected', name: 'mcp__fixture__lookup', arguments: { count: error === 'validation' ? 'invalid' : 1 } };
      if (error === 'fetch') rejected = { ...rejected, name: 'web_fetch', arguments: { url: 'http://127.0.0.1/private' } };
      if (error === 'replacement') rejected = { ...rejected, name: 'submit_lesson', arguments: { title: 'Rejected replacement', content: '  \r\n ' } };
      const accepted: ToolCall = { type: 'toolCall', id: 'accepted', name: 'submit_lesson', arguments: lesson };
      let requests = 0;
      const runtime = new TeachingRuntime(l, syntheticSource, { mcp, stream: (_m, context) => {
        assert.equal(l.unit(space.id, unit).lesson, null, 'No publication before normal completion');
        if (requests++ === 0) return response(reply(order === 'before' ? [rejected, accepted] : [accepted, rejected], 'toolUse'));
        const result = context.messages.find((m) => m.role === 'toolResult' && m.toolCallId === 'rejected');
        assert.ok(result?.role === 'toolResult' && result.isError, 'The model must receive the failed tool result');
        if (error === 'validation') assert.match(JSON.stringify(result.content), /Validation failed/);
        if (error === 'replacement') assert.match(JSON.stringify(result.content), /must not be blank/);
        return response(reply([{ type: 'text', text: 'The lesson is ready; the other operation did not complete.' }]));
      } });
      try {
        const task = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 0 });
        await runtime.idle(task.id);
        assert.equal(runtime.get(space.id, task.id).state, 'succeeded', `${error}/${order}`);
        const saved = l.unit(space.id, unit).lesson!;
        assert.equal(saved.revision, 1); assert.equal(saved.title, lesson.title); assert.equal(saved.content, lesson.content);
        const parts = runtime.events(space.id, task.id).events.reduce<AgentDisplayPart[]>(applyAgentEvent, []);
        assert.deepEqual(parts.filter((part) => part.type === 'tool').map((part) => part.status), order === 'before' ? ['error', 'done'] : ['done', 'error']);
        const retained = (db.prepare('SELECT value FROM task_messages WHERE run_id=? ORDER BY seq').all(task.id) as { value: string }[])
          .map((row) => JSON.parse(row.value)).find((m) => m.role === 'toolResult' && m.toolCallId === 'rejected');
        assert.equal(retained.isError, true);
      } finally { await Promise.all([runtime.close(), mcp.close()]); db.close(); rmSync(root, { recursive: true, force: true }); }
    }
  }
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

async function executeDiskTool(cwd: string, name: string, args: JsonObject, signal?: AbortSignal) {
  const tool = readTools(cwd).find((t) => t.name === name)!;
  const call: ToolCall = { type: 'toolCall', id: name, name, arguments: args };
  const value = await tool.execute(call.id, validateToolArguments(tool, call), signal);
  assert.equal(value.content[0]?.type, 'text');
  return JSON.parse((value.content[0] as { text: string }).text);
}

test('OS reads permit parent, absolute, home and symlink credential-named fixtures with bounded pages and version changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-read-')), cwd = join(root, 'project'); mkdirSync(cwd);
  const file = join(root, '.env'); writeFileSync(file, 'SYNTHETIC-SOURCE-BODY\nsecond line'); symlinkSync(file, join(cwd, 'link'));
  const get = (path: string, offset = 0, limit = 4096) => executeDiskTool(cwd, 'read', { path, offset, limit });
  try {
    const first = await get('../.env');
    for (const path of [file, 'link', `~/${relative(homedir(), file)}`]) assert.equal((await get(path)).text, first.text);
    const page = await get(file, 4, 7); assert.equal(page.text, 'HETIC-S'); assert.equal(page.nextOffset, 11);
    writeFileSync(file, 'changed-version'); assert.notEqual((await get(file)).source.version, first.source.version);
    assert.deepEqual(readTools(cwd).map((t) => t.name), ['read', 'ls', 'find', 'grep']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OS UTF-8 byte pages reassemble raw text, align back inside characters and preserve binary ranges and hashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-byte-pages-'));
  const text = '  A中B🙂\r\n汉😀éé\t tail\n', raw = Buffer.from(text);
  writeFileSync(join(root, 'mixed.txt'), raw);
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes.toString('base64')).digest('hex');
  try {
    const first = await executeDiskTool(root, 'read', { path: 'mixed.txt' });
    for (const limit of [1, 2, 3, 4, 5, 7]) {
      let offset: number | null = 0, combined = '';
      while (offset !== null) {
        const page = await executeDiskTool(root, 'read', { path: 'mixed.txt', offset, limit });
        assert.equal(page.source.range.offset, offset);
        assert.ok(page.source.range.bytes > 0 && page.source.range.bytes <= Math.max(limit, 4));
        assert.equal(Buffer.byteLength(page.text), page.source.range.bytes);
        assert.equal(page.source.hash, digest(raw.subarray(offset, offset + page.source.range.bytes)));
        assert.equal(page.source.version, first.source.version); assert.equal(page.source.kind, 'disk');
        assert.doesNotMatch(page.text, /\uFFFD/);
        combined += page.text;
        if (page.nextOffset !== null) assert.equal(page.nextOffset, offset + page.source.range.bytes);
        offset = page.nextOffset;
      }
      assert.equal(combined, text);
    }
    let start = 0;
    for (const char of text) {
      const bytes = Buffer.byteLength(char);
      for (let inside = 1; inside < bytes; inside++) {
        const page = await executeDiskTool(root, 'read', { path: 'mixed.txt', offset: start + inside, limit: 1 });
        assert.equal(page.text, char); assert.deepEqual(page.source.range, { offset: start, bytes });
        assert.equal(page.nextOffset, start + bytes); assert.equal(page.source.hash, digest(Buffer.from(char)));
      }
      start += bytes;
    }
    assert.deepEqual((await executeDiskTool(root, 'read', { path: 'mixed.txt', offset: raw.length })).source.range, { offset: raw.length, bytes: 0 });
    const beyond = await executeDiskTool(root, 'read', { path: 'mixed.txt', offset: raw.length + 9 });
    assert.equal(beyond.text, ''); assert.equal(beyond.nextOffset, null);
    assert.deepEqual(beyond.source.range, { offset: raw.length + 9, bytes: 0 });
    writeFileSync(join(root, 'boundary.txt'), `${'a'.repeat(8191)}中🙂\n`);
    const boundary = await executeDiskTool(root, 'read', { path: 'boundary.txt', limit: 8192 });
    assert.equal(boundary.text, 'a'.repeat(8191)); assert.equal(boundary.nextOffset, 8191);
    assert.equal((await executeDiskTool(root, 'read', { path: 'boundary.txt', offset: boundary.nextOffset })).text, '中🙂\n');
    const binary = Buffer.from([0, 255, 228, 184, 173, 0, 240, 159, 153, 130, 0]);
    writeFileSync(join(root, 'binary.bin'), binary);
    const chunks: Buffer[] = [];
    for (const [offset, limit] of [[0, 3], [3, 3], [6, 5]]) {
      const page = await executeDiskTool(root, 'read', { path: 'binary.bin', offset: offset!, limit: limit! });
      assert.deepEqual(page.source.range, { offset, bytes: limit });
      assert.equal(page.base64, binary.subarray(offset, offset! + limit!).toString('base64'));
      assert.equal(page.source.hash, digest(binary.subarray(offset, offset! + limit!)));
      assert.equal(page.nextOffset, offset! + limit! < binary.length ? offset! + limit! : null);
      chunks.push(Buffer.from(page.base64, 'base64'));
    }
    assert.deepEqual(Buffer.concat(chunks), binary);
    await assert.rejects(executeDiskTool(root, 'read', { path: '.' }), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OS searches validate literal patterns, grep files and directories safely, and report UTF-8 partial byte ranges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-grep-')), directory = join(root, 'files'); mkdirSync(directory);
  const content = `${'x'.repeat(249)}🙂 needle\n  spaced line\n`;
  writeFileSync(join(directory, '[a].txt'), content);
  writeFileSync(join(directory, 'other.txt'), 'single space\n');
  symlinkSync(directory, join(directory, 'cycle')); symlinkSync(join(directory, '[a].txt'), join(root, 'file-link'));
  symlinkSync(directory, join(root, 'directory-link'));
  try {
    const ls = readTools(root).find((t) => t.name === 'ls')!;
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(ls.parameters)).properties), ['path', 'offset']);
    const invalidPatterns: JsonObject[] = [{ path: 'files' }, { path: 'files', pattern: '' }];
    for (const args of invalidPatterns) {
      await assert.rejects(executeDiskTool(root, 'grep', args), /Validation failed.*grep[\s\S]*pattern/);
    }
    const file = await executeDiskTool(root, 'grep', { path: 'files/[a].txt', pattern: 'needle' });
    const dir = await executeDiskTool(root, 'grep', { path: 'files', pattern: 'needle' });
    assert.equal(file.items.length, 1); assert.equal(file.scanned, 1); assert.equal(file.nextOffset, null);
    assert.equal(dir.items.length, 1); assert.equal(dir.items[0].path, file.items[0].path);
    assert.deepEqual(dir.items[0].source.range, file.items[0].source.range);
    assert.equal(file.items[0].excerpts[0], 'x'.repeat(249), 'The excerpt must not end with half an emoji');
    const linkedFile = await executeDiskTool(root, 'grep', { path: 'file-link', pattern: 'needle' });
    assert.equal(linkedFile.items.length, 1); assert.equal(linkedFile.items[0].source.version, file.items[0].source.version);
    assert.equal((await executeDiskTool(root, 'grep', { path: 'directory-link', pattern: 'needle' })).items.length, 1);
    const spaces = await executeDiskTool(root, 'grep', { path: 'files', pattern: '  ' });
    assert.equal(spaces.items.length, 1); assert.deepEqual(spaces.items[0].excerpts, ['  spaced line']);
    assert.equal((await executeDiskTool(root, 'find', { path: 'files', pattern: '[a]' })).items.length, 1);
    assert.equal((await executeDiskTool(root, 'find', { path: 'files' })).items.length, 3, 'Do not follow the cycle');
    assert.equal((await executeDiskTool(root, 'grep', { path: 'files/[a].txt', pattern: 'missing' })).items.length, 0);
    writeFileSync(join(root, 'edge.txt'), `${'a'.repeat(8188)}中🙂outside`);
    const edge = await executeDiskTool(root, 'grep', { path: 'edge.txt', pattern: '中' });
    assert.equal(edge.items.length, 1); assert.deepEqual(edge.items[0].source.range, { offset: 0, bytes: 8191 });
    assert.equal(edge.items[0].nextOffset, 8191); assert.match(edge.scope, /first 8192 bytes/);
    assert.equal((await executeDiskTool(root, 'read', { path: 'edge.txt', offset: edge.items[0].nextOffset })).text, '🙂outside');
    assert.equal((await executeDiskTool(root, 'grep', { path: 'edge.txt', pattern: '🙂' })).items.length, 0);
    for (const name of ['read', 'ls', 'find', 'grep']) {
      await assert.rejects(executeDiskTool(root, name, { path: name === 'read' ? 'edge.txt' : 'files', ...(name === 'grep' ? { pattern: 'needle' } : {}) }, AbortSignal.abort()), { name: 'AbortError' });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OS match-count pagination distinguishes full pages from exhausted, sparse, scan-limited and depth-limited searches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-search-pages-')), pages = join(root, 'pages'); mkdirSync(pages);
  for (let i = 0; i < 71; i++) writeFileSync(join(pages, `${i < 67 ? 'hit' : 'miss'}-${i}.txt`), i < 67 && i % 2 === 0 ? 'needle' : 'other');
  try {
    for (const [name, pattern, total] of [['ls', undefined, 71], ['find', 'hit-', 67], ['grep', 'needle', 34]] as const) {
      let offset: number | null = 0;
      const paths: string[] = [];
      while (offset !== null) {
        const page = await executeDiskTool(root, name, { path: 'pages', offset, ...(pattern === undefined ? {} : { pattern }) });
        assert.equal(page.truncated, false); assert.ok(page.scanned <= 2000); assert.ok(page.items.length <= 30);
        paths.push(...page.items.map((item: { path: string }) => item.path));
        if (page.nextOffset !== null) { assert.equal(page.items.length, 30); assert.equal(page.nextOffset, offset + 30); }
        offset = page.nextOffset;
      }
      assert.equal(paths.length, total); assert.equal(new Set(paths).size, total);
      const exhausted = await executeDiskTool(root, name, { path: 'pages', offset: 99, ...(pattern === undefined ? {} : { pattern }) });
      assert.deepEqual(exhausted.items, []); assert.equal(exhausted.nextOffset, null); assert.equal(exhausted.truncated, false);
    }
    const exactPage = await executeDiskTool(root, 'find', { path: 'pages', pattern: 'hit-', offset: 37 });
    assert.equal(exactPage.items.length, 30); assert.equal(exactPage.nextOffset, null); assert.equal(exactPage.truncated, false);
    const empty = await executeDiskTool(root, 'find', { path: 'pages', pattern: 'absent' });
    assert.deepEqual(empty.items, []); assert.equal(empty.nextOffset, null); assert.equal(empty.truncated, false);
    const sparse = join(root, 'sparse'), bulk = join(sparse, 'target'); mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 2005; i++) writeFileSync(join(bulk, `entry-${i}`), '');
    const sparseSearches: JsonObject[] = [{ path: 'sparse', pattern: 'target' }, { path: 'sparse', pattern: 'target', offset: 1 }, { path: 'sparse', pattern: 'absent' }];
    for (const args of sparseSearches) {
      const page = await executeDiskTool(root, 'find', args);
      assert.equal(page.items.length, args.pattern === 'target' && !args.offset ? 1 : 0);
      assert.equal(page.scanned, 2000); assert.equal(page.truncated, true); assert.equal(page.nextOffset, null);
      assert.match(JSON.stringify(page), /partial/i); assert.match(JSON.stringify(page), /narrow.*path/i);
    }
    const limitedFullPage = await executeDiskTool(root, 'find', { path: 'sparse/target', pattern: 'entry-', offset: 1970 });
    assert.equal(limitedFullPage.items.length, 30); assert.equal(limitedFullPage.truncated, true); assert.equal(limitedFullPage.nextOffset, null);
    for (const [name, args] of [['ls', { path: 'sparse/target', offset: 2000 }], ['grep', { path: 'sparse/target', pattern: 'absent' }]] as const) {
      const page = await executeDiskTool(root, name, args);
      assert.deepEqual(page.items, []); assert.equal(page.scanned, 2000); assert.equal(page.truncated, true); assert.equal(page.nextOffset, null);
      assert.match(JSON.stringify(page), /partial/i);
    }
    const deep = join(root, 'deep'); mkdirSync(deep); writeFileSync(join(deep, 'visible-hit'), 'needle');
    let nested = deep;
    for (let i = 0; i < 22; i++) { nested = join(nested, `level-${i}`); mkdirSync(nested); }
    writeFileSync(join(nested, 'buried-hit'), 'needle');
    for (const [name, pattern, count] of [['find', 'hit', 1], ['find', 'absent', 0], ['grep', 'needle', 1]] as const) {
      const page = await executeDiskTool(root, name, { path: 'deep', pattern });
      assert.equal(page.items.length, count); assert.equal(page.truncated, true); assert.equal(page.nextOffset, null);
      assert.match(JSON.stringify(page), /partial/i); assert.match(JSON.stringify(page), /narrow.*path/i);
    }
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

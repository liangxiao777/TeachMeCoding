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
import { approveLesson, populated, reply, response, syntheticSource } from './test-support.js';
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
      const mcp = new McpService(join(root, 'mcp.json'), { cwd: root });
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

test('truncated lesson calls can be reissued and a later transient failure preserves only the complete staged lesson', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), { space, units } = populated(l), unit = units[0]!.id;
  const complete = { title: 'Complete lesson', content: '## Arguments\n\nA complete explanation with a final example.\n' };
  let requests = 0;
  const runtime = new TeachingRuntime(l, syntheticSource, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 }, stream: (_m, context) => {
    requests++;
    assert.equal(l.unit(space.id, unit).lesson, null, 'Do not publish a staged or truncated result early');
    if (requests === 1) return response(reply([{ type: 'toolCall', id: 'truncated', name: 'submit_lesson',
      arguments: { title: 'Incomplete lesson', content: 'TRUNCATED-BODY' } }], 'length'));
    if (requests === 2) {
      const rejected = context.messages.at(-1);
      assert.ok(rejected?.role === 'toolResult' && rejected.isError);
      assert.match(JSON.stringify(rejected.content), /not executed[\s\S]*Re-issue/);
      return response(reply([{ type: 'toolCall', id: 'complete', name: 'submit_lesson', arguments: complete }], 'toolUse'));
    }
    if (requests === 3) return response({ ...reply([], 'error'), errorMessage: '503 Service unavailable' });
    return response(reply([{ type: 'text', text: 'Ready.' }]));
  } });
  try {
    const task = runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 0 });
    await runtime.idle(task.id);
    assert.equal(runtime.get(space.id, task.id).state, 'succeeded'); assert.equal(requests, 4);
    const lesson = l.unit(space.id, unit).lesson!;
    assert.equal(lesson.revision, 1); assert.equal(lesson.title, complete.title); assert.equal(lesson.content, complete.content);
    const parts = runtime.events(space.id, task.id).events.reduce<AgentDisplayPart[]>(applyAgentEvent, []);
    assert.deepEqual(parts.filter((p) => p.type === 'tool').map((p) => p.status), ['error', 'done']);
    assert.equal(db.prepare('SELECT * FROM lesson_versions').all().length, 1);
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
    if (mode === 'late') approveLesson(l, space.id, unit, { title: 'user replacement', content: 'newer valid text' });
    return response(reply([{ type: 'text', text: 'done' }], mode === 'fail' ? 'error' : 'stop'));
  } });
  try {
    const key = randomUUID(), task = runtime.generate(space.id, unit, key, { kind: 'lesson', revision: 1 });
    assert.equal(runtime.generate(space.id, unit, key, { kind: 'lesson', revision: 1 }).id, task.id);
    assert.equal(task.sessionId, null);
    assert.throws(() => runtime.generate(space.id, unit, randomUUID(), { kind: 'lesson', revision: 1 }), { message: 'UNIT_TASK_RUNNING' });
    await runtime.idle(task.id);
    assert.equal(runtime.get(space.id, task.id).state, 'succeeded');
    assert.deepEqual(l.unit(space.id, unit).lesson, { ...legacy, revision: 1 }, 'Regeneration keeps the applied version readable until explicit acceptance.');
    const proposal = l.space(space.id).lessonProposals.at(-1)!;
    assert.deepEqual(proposal.source, { kind: 'task', id: task.id });
    assert.deepEqual(proposal.baseLesson, { ...legacy, revision: 1 });
    l.applyLessonProposal(space.id, proposal.id);
    assert.equal(l.unit(space.id, unit).lesson?.revision, 2);
    assert.equal(l.unit(space.id, unit).lesson?.content, '## Arguments\n\n```python\nprint(13)\n```');
    assert.equal(l.unit(space.id, unit).lesson?.blocks, undefined);
    assert.equal(l.space(space.id).sessions.length, 3, 'Task proposals create a saved unit session for review/follow-up.');
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

test('unit order crosses stage boundaries and advances only after successful lesson publication', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), initial = populated(l);
  const units = [...initial.units, ...Array.from({ length: 3 }, (_, index) => ({ id: randomUUID(), title: `Later ${index}`, summary: '', goals: [] }))];
  const proposal = l.proposeRoute(initial.space.id, initial.routeSession, { note: 'Sequential route', stages: [
    { id: randomUUID(), title: 'First', units: units.slice(0, 1) },
    { id: randomUUID(), title: 'Middle', units: units.slice(1, 4) },
    { id: randomUUID(), title: 'Last', units: units.slice(4) },
  ] });
  l.applyProposal(initial.space.id, proposal.id);
  const space = initial.space.id, first = units[0]!.id, second = units[1]!.id;
  l.saveAssessmentDraft(space, units[3]!.id, { revision: 0, q1: 'Imported later learning activity', q2: '' });
  l.saveLesson(space, units[3]!.id, { title: 'Pre-existing later lesson', content: 'Does not fill earlier gaps.' });
  db.prepare("UPDATE units SET status='skipped' WHERE space_id=? AND id=?").run(space, first);
  let mode = 'error', taskId = '';
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    if (context.messages.at(-1)?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'lesson', name: 'submit_lesson', arguments: { title: 'Lesson', content: 'Published only after normal completion.' } }], 'toolUse'));
    if (!l.unit(space, first).lesson) {
      assert.throws(() => runtime.generate(space, second, randomUUID(), { kind: 'lesson', revision: 0 }), { message: 'UNIT_LOCKED' });
    }
    if (mode === 'stop') runtime.stop(space, taskId);
    return response(reply([{ type: 'text', text: 'done' }], mode === 'error' ? 'error' : 'stop'));
  } });
  try {
    assert.doesNotThrow(() => l.assertUnitUnlocked(space, units[3]!.id), 'Published later lessons remain accessible across earlier gaps.');
    for (const unit of units.slice(1).filter((unit) => unit.id !== units[3]!.id)) {
      assert.throws(() => runtime.generate(space, unit.id, randomUUID(), { kind: 'lesson', revision: l.unit(space, unit.id).lesson?.revision ?? 0 }), { message: 'UNIT_LOCKED' });
    }
    for (mode of ['error', 'stop']) {
      const task = runtime.generate(space, first, randomUUID(), { kind: 'lesson', revision: 0 }); taskId = task.id;
      await runtime.idle(task.id);
      assert.equal(runtime.get(space, task.id).state, mode === 'stop' ? 'interrupted' : 'failed');
      assert.equal(l.unit(space, first).lesson, null);
      assert.throws(() => runtime.generate(space, second, randomUUID(), { kind: 'lesson', revision: 0 }), { message: 'UNIT_LOCKED' });
    }
    mode = 'good';
    for (const unit of units.slice(0, 3)) {
      const task = runtime.generate(space, unit.id, randomUUID(), { kind: 'lesson', revision: 0 });
      await runtime.idle(task.id);
      assert.equal(runtime.get(space, task.id).state, 'succeeded');
      assert.equal(l.unit(space, unit.id).records.length, 0, 'Assessments are not an unlock requirement.');
      if (unit.id !== units[2]!.id) assert.throws(() => runtime.generate(space, units[4]!.id, randomUUID(), { kind: 'lesson', revision: 0 }), { message: 'UNIT_LOCKED' });
    }
    const last = runtime.generate(space, units[4]!.id, randomUUID(), { kind: 'lesson', revision: 0 });
    await runtime.idle(last.id); assert.equal(runtime.get(space, last.id).state, 'succeeded');
    assert.equal(l.unit(space, units[3]!.id).lesson!.revision, 1, 'Unlocking does not regenerate existing lessons.');
  } finally { await runtime.close(); db.close(); }
});

test('submitting to an empty locked tutor session cannot make its own input count as prior learning activity', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units } = populated(learning), unit = units[1]!.id;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => response(reply([])) });
  try {
    const session = learning.createSession(space.id, { scope: 'unit', unitId: unit, title: 'Locked tutor' });
    assert.equal(learning.unit(space.id, unit).started, false);
    assert.throws(() => learning.assertUnitUnlocked(space.id, unit), { message: 'UNIT_LOCKED' });
    const before = learning.space(space.id);
    assert.throws(() => runtime.submit(space.id, session.id, randomUUID(), { text: 'Skip ahead', quote: null, draftRevision: 0 }), { message: 'UNIT_LOCKED' });
    assert.deepEqual(learning.session(space.id, session.id), session);
    assert.deepEqual(learning.space(space.id), before);
    assert.equal(learning.unit(space.id, unit).started, false);
  } finally { await runtime.close(); db.close(); }
});

test('lesson tools expose plan order and real progress, and read complete fixed-version references before or after the current unit', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), a = populated(l), b = populated(l, 'Other space');
  const current = { id: randomUUID(), title: 'Current', summary: 'CURRENT-PLAN', goals: ['Goal'] };
  const future = { id: randomUUID(), title: 'Future', summary: 'FUTURE-PLAN', goals: ['Later goal'] };
  const unpublished = { id: randomUUID(), title: 'Unpublished', summary: 'UNPUBLISHED-PLAN', goals: [] };
  const proposal = l.proposeRoute(a.space.id, a.routeSession, { note: 'Complete roadmap', stages: [
    { id: randomUUID(), title: 'Earlier', units: a.units }, { id: randomUUID(), title: 'Later', units: [current, future, unpublished] },
  ] });
  l.applyProposal(a.space.id, proposal.id);
  const legacy = { title: 'Legacy', content: 'LEGACY-CONTENT', intro: 'LEGACY-INTRO', blocks: [
    { type: 'h2', id: 'old-heading', text: 'Legacy heading' }, { type: 'p', text: 'Legacy paragraph' },
    { type: 'markdown', text: '## Legacy Markdown\n\nKeep raw Markdown.' }, { type: 'list', items: ['First list item', 'Second list item'] },
    { type: 'callout', title: 'Legacy tip', text: 'Legacy caution' },
    { type: 'code', language: 'ts', file: 'sample.ts', code: '  const fence = "```";\n', caption: 'Legacy code caption' },
    { type: 'practice', items: ['Legacy exercise', 'Explain the boundary.'] },
  ] };
  const markdown = { title: 'Long Markdown', content: `  MARKDOWN-START\r\n\n${'中文🙂 with exact spaces.\n'.repeat(3500)}\nMARKDOWN-END\n` };
  l.saveLesson(a.space.id, a.units[0]!.id, legacy); l.saveLesson(a.space.id, a.units[1]!.id, markdown);
  l.saveLesson(a.space.id, current.id, { title: 'Current lesson', content: 'CURRENT-BODY' });
  l.saveLesson(a.space.id, future.id, { title: 'Future lesson', content: 'FUTURE-BODY' });
  l.saveLesson(b.space.id, b.units[0]!.id, { title: 'Other', content: 'OTHER-SPACE-BODY' });
  const textOf = (content: { type: string; text?: string }[]) => content.map((part) => part.text ?? '').join('');
  let requests = 0;
  const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
    const call = (name: string, args: JsonObject) => response(reply([{ type: 'toolCall', id: `call-${requests}`, name, arguments: args }], 'toolUse'));
    requests++;
    const last = context.messages.at(-1);
    if (requests === 1) {
      const input = context.messages.find((m) => m.role === 'user')!;
      assert.doesNotMatch(JSON.stringify(input.content), /FUTURE-PLAN|FUTURE-BODY|MARKDOWN-START|LEGACY-INTRO/);
      return call('read_learning_route', {});
    }
    assert.ok(last?.role === 'toolResult');
    if (requests === 2) {
      const route = JSON.parse(textOf(last.content));
      assert.equal(route.currentUnitId, current.id); assert.equal(route.note, 'Complete roadmap');
      assert.deepEqual(route.stages.flatMap((s: { units: { unitId: string }[] }) => s.units.map((u) => u.unitId)), [...a.units.map((u) => u.id), current.id, future.id, unpublished.id]);
      assert.equal(route.stages[1].units[1].summary, 'FUTURE-PLAN'); assert.equal(route.stages[1].units[1].hasLesson, true);
      assert.equal(route.stages[1].units[1].started, true); assert.equal(route.stages[1].units[1].status, 'learning');
      assert.equal(route.stages[1].units[2].hasLesson, false); assert.equal(route.stages[1].units[2].started, false);
      return response(reply([current.id, unpublished.id, b.units[0]!.id, randomUUID()].map((unitId, index) => ({
        type: 'toolCall', id: `forbidden-${index}`, name: 'read_reference_lesson', arguments: { unitId },
      })), 'toolUse'));
    }
    if (requests === 3) {
      const forbidden = context.messages.filter((m) => m.role === 'toolResult' && m.toolCallId.startsWith('forbidden-'));
      assert.equal(forbidden.length, 4); assert.ok(forbidden.every((m) => m.role === 'toolResult' && m.isError));
      assert.doesNotMatch(JSON.stringify(forbidden), /CURRENT-BODY|FUTURE-BODY|OTHER-SPACE-BODY/);
      assert.ok(forbidden.every((m) => m.role === 'toolResult' && textOf(m.content) === 'LESSON_REFERENCE_UNAVAILABLE'));
      return call('read_reference_lesson', { unitId: future.id });
    }
    if (requests === 4) {
      assert.equal(last.isError, false); assert.equal(textOf(last.content), '课件：Future lesson\n\nFUTURE-BODY');
      return call('read_reference_lesson', { unitId: a.units[0]!.id });
    }
    if (requests === 5) {
      assert.equal(last.isError, false);
      for (const required of ['Legacy', 'LEGACY-CONTENT', 'LEGACY-INTRO', 'Legacy heading', 'Legacy paragraph',
        '## Legacy Markdown\n\nKeep raw Markdown.', 'First list item', 'Second list item', 'Legacy tip', 'Legacy caution',
        'sample.ts', '  const fence = "```";\n', 'Legacy code caption', 'Legacy exercise', 'Explain the boundary.']) assert.ok(textOf(last.content).includes(required), required);
      approveLesson(l, a.space.id, a.units[1]!.id, { title: 'Newer lesson', content: 'LATEST-BODY-MUST-NOT-LEAK' });
      return call('read_reference_lesson', { unitId: a.units[1]!.id });
    }
    if (requests === 6) {
      assert.equal(last.isError, false); assert.equal(textOf(last.content), `课件：Long Markdown\n\n${markdown.content}`);
      return call('submit_lesson', { title: 'Continuation', content: 'New lesson based on fixed earlier material.' });
    }
    return response(reply([{ type: 'text', text: 'done' }]));
  } });
  try {
    const task = runtime.generate(a.space.id, current.id, randomUUID(), { kind: 'lesson', revision: 1 });
    await runtime.idle(task.id);
    assert.equal(requests, 7); assert.equal(runtime.get(a.space.id, task.id).state, 'failed');
    assert.deepEqual(runtime.get(a.space.id, task.id).error, { code: 'LESSON_REFERENCES_CHANGED' });
    assert.equal(l.unit(a.space.id, current.id).lesson!.content, 'CURRENT-BODY');
    const manifest = JSON.parse((db.prepare('SELECT value FROM task_manifests WHERE run_id=? ORDER BY request DESC LIMIT 1').get(task.id) as { value: string }).value);
    const sources = manifest.toolSources.flatMap((tool: { sources: unknown[] }) => tool.sources);
    for (const unitId of [future.id, ...a.units.map((unit) => unit.id)]) assert.ok(sources.some((s: { kind: string; id: string; revision: number }) => s.kind === 'reference-lesson' && s.id === unitId && s.revision === 1));
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM task_messages WHERE run_id=?').all(task.id)), /MARKDOWN-START|LEGACY-INTRO/);
    assert.deepEqual(JSON.parse((db.prepare('SELECT content FROM lesson_versions WHERE space_id=? AND unit_id=? AND revision=1').get(a.space.id, a.units[0]!.id) as { content: string }).content), legacy);
  } finally { await runtime.close(); db.close(); }
});

test('lesson publication depends only on references actually read, not other published lessons that changed during generation', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), { space, units, routeSession } = populated(learning);
  const current = { id: randomUUID(), title: 'Supplement', summary: 'Insert before an already published unit', goals: [] };
  for (const unit of units) learning.saveLesson(space.id, unit.id, { title: unit.title, content: `Original-${unit.id}` });
  const route = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [units[0]!, current, units[1]!] }] };
  learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, route).id);
  const lesson = { title: 'Supplement lesson', content: 'Derived only from the reference actually read.' };
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
    const last = context.messages.at(-1);
    if (last?.role !== 'toolResult') return response(reply([{ type: 'toolCall', id: 'reference', name: 'read_reference_lesson', arguments: { unitId: units[0]!.id } }], 'toolUse'));
    if (last.toolName === 'read_reference_lesson') {
      assert.equal(last.isError, false); assert.match(JSON.stringify(last.content), new RegExp(`Original-${units[0]!.id}`));
      approveLesson(learning, space.id, units[1]!.id, { title: 'Updated unread lesson', content: 'UNREAD-CHANGED-BODY' });
      return response(reply([{ type: 'toolCall', id: 'submit', name: 'submit_lesson', arguments: lesson }], 'toolUse'));
    }
    return response(reply([]));
  } });
  try {
    const task = runtime.generate(space.id, current.id, randomUUID(), { kind: 'lesson', revision: 0 });
    await runtime.idle(task.id); assert.equal(runtime.get(space.id, task.id).state, 'succeeded');
    assert.deepEqual(learning.unit(space.id, current.id).lesson, { ...lesson, revision: 1 });
    assert.equal(learning.unit(space.id, units[1]!.id).lesson!.revision, 2);
  } finally { await runtime.close(); db.close(); }
});

test('lesson retries reject changed baselines, missing snapshots and unavailable fixed history before creating a task', async () => {
  for (const change of ['none', 'reference', 'unread', 'unread-history', 'current', 'route', 'requirement', 'snapshot', 'history', 'locked'] as const) {
    const db = openDatabase(':memory:'), l = new Learning(db), { space, units, routeSession } = populated(l);
    l.saveLesson(space.id, units[0]!.id, { title: 'Earlier', content: 'Original material' });
    const unread = { id: randomUUID(), title: 'Unread reference', summary: '', goals: [] };
    if (change === 'unread' || change === 'unread-history') {
      const route = { ...space.route.content!, stages: [{ ...space.route.content!.stages[0]!, units: [...units, unread] }] };
      l.applyProposal(space.id, l.proposeRoute(space.id, routeSession, route).id);
      l.saveAssessmentDraft(space.id, unread.id, { revision: 0, q1: 'Imported later activity', q2: '' });
      l.saveLesson(space.id, unread.id, { title: 'Unread', content: 'Other published material' });
    }
    let fail = true;
    const runtime = new TeachingRuntime(l, syntheticSource, { stream: (_m, context) => {
      if (fail) {
        if (context.messages.at(-1)?.role !== 'toolResult') {
          return response(reply([{ type: 'toolCall', id: 'reference', name: 'read_reference_lesson', arguments: { unitId: units[0]!.id } }], 'toolUse'));
        }
        const last = context.messages.at(-1);
        assert.ok(last?.role === 'toolResult' && !last.isError);
        assert.match(JSON.stringify(last.content), /Original material/);
        return response(reply([], 'error'));
      }
      return context.messages.at(-1)?.role !== 'toolResult' ? response(reply([{ type: 'toolCall', id: 'lesson', name: 'submit_lesson', arguments: { title: 'Lesson', content: 'No mandatory read-count gate.' } }], 'toolUse'))
        : response(reply([{ type: 'text', text: 'done' }]));
    } });
    try {
      const task = runtime.generate(space.id, units[1]!.id, randomUUID(), { kind: 'lesson', revision: 0 });
      await runtime.idle(task.id); assert.equal(runtime.get(space.id, task.id).state, 'failed'); fail = false;
      if (change === 'reference') approveLesson(l, space.id, units[0]!.id, { title: 'Replacement', content: 'Changed material' });
      if (change === 'current') l.saveLesson(space.id, units[1]!.id, { title: 'Replacement', content: 'Changed material' });
      if (change === 'unread') approveLesson(l, space.id, unread.id, { title: 'Unread replacement', content: 'Changed unread material' });
      if (change === 'requirement') l.saveRequirement(space.id, { ...l.space(space.id).requirement, value: { rows: [{ question: 'Goal?', answer: 'Changed goal' }] } });
      if (change === 'route' || change === 'locked') {
        const content = structuredClone(l.space(space.id).route.content!);
        if (change === 'route') content.note = 'Changed route';
        else content.stages[0]!.units.unshift({ id: randomUUID(), title: 'New prerequisite', summary: '', goals: [] });
        const proposal = l.proposeRoute(space.id, routeSession, content); l.applyProposal(space.id, proposal.id);
      }
      if (change === 'snapshot') {
        const row = db.prepare('SELECT input FROM task_runs WHERE id=?').get(task.id) as { input: string };
        const old = JSON.parse(row.input); delete old.lessonRefs;
        db.prepare('UPDATE task_runs SET input=? WHERE id=?').run(JSON.stringify(old), task.id);
      }
      if (change === 'history' || change === 'unread-history') db.prepare('DELETE FROM lesson_versions WHERE space_id=? AND unit_id=?').run(space.id, change === 'history' ? units[0]!.id : unread.id);
      const count = l.space(space.id).tasks.length;
      if (change === 'none' || change === 'unread' || change === 'unread-history') {
        const key = randomUUID(), retry = runtime.retryTask(space.id, task.id, key);
        assert.equal(runtime.retryTask(space.id, task.id, key).id, retry.id);
        await runtime.idle(retry.id); assert.equal(runtime.get(space.id, retry.id).state, 'succeeded');
        assert.equal(l.unit(space.id, units[1]!.id).lesson!.content, 'No mandatory read-count gate.');
      } else {
        assert.throws(() => runtime.retryTask(space.id, task.id, randomUUID()), { message: change === 'locked' ? 'UNIT_LOCKED' : change === 'snapshot' ? 'LESSON_RETRY_REFERENCES_MISSING' : change === 'history' ? 'LESSON_VERSION_UNAVAILABLE' : change === 'reference' ? 'LESSON_REFERENCES_CHANGED' : 'CONTENT_CHANGED' });
        assert.equal(l.space(space.id).tasks.length, count, change);
        if (change !== 'locked' && change !== 'history') {
          const fresh = runtime.generate(space.id, units[1]!.id, randomUUID(), { kind: 'lesson', revision: l.unit(space.id, units[1]!.id).lesson?.revision ?? 0 });
          await runtime.idle(fresh.id); assert.equal(runtime.get(space.id, fresh.id).state, 'succeeded', change);
        }
      }
    } finally { await runtime.close(); db.close(); }
  }
});

test('only same-space adopted valid conclusions enter new sessions; revoke and source changes invalidate them', async () => {
  const db = openDatabase(':memory:'), l = new Learning(db), a = populated(l, 'A'), b = populated(l, 'B');
  l.saveLesson(a.space.id, a.units[0]!.id, { title: 'Earlier lesson', content: 'Unlock the next unit before testing conclusion sharing.' });
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
    const beforeInsertion = l.conclusions(a.space.id);
    const routeSession = a.space.sessions.find((session) => session.scope === 'route')!.id;
    const supplement = { id: randomUUID(), title: 'Inserted prerequisite', summary: '', goals: [] };
    const route = { ...a.space.route.content!, stages: [{ ...a.space.route.content!.stages[0]!, units: [supplement, ...a.units] }] };
    l.applyProposal(a.space.id, l.proposeRoute(a.space.id, routeSession, route).id);
    assert.deepEqual(l.conclusions(a.space.id), beforeInsertion, 'An unrelated route revision must not invalidate adopted conclusions.');
    assert.doesNotThrow(() => l.assertUnitUnlocked(a.space.id, a.units[0]!.id));
    assert.doesNotThrow(() => l.assertUnitUnlocked(a.space.id, a.units[1]!.id));
    await ask(a.space.id, a.units[1]!.id, 'after insertion'); assert.match(saw, /ADOPTED-ARGUMENT-FACT/); assert.ok(!saw.includes('private-chat-marker'));
    await ask(b.space.id, b.units[0]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT'));
    assert.throws(() => l.decideConclusion(b.space.id, c.id, { revision: 1, adopted: false }), { message: 'CONCLUSION_NOT_FOUND' });
    l.decideConclusion(a.space.id, c.id, { revision: 1, adopted: false });
    await ask(a.space.id, a.units[1]!.id, 'next'); assert.ok(!saw.includes('ADOPTED-ARGUMENT-FACT'));
    l.decideConclusion(a.space.id, c.id, { revision: 2, adopted: true });
    approveLesson(l, a.space.id, a.units[0]!.id, { title: 'changed source', content: 'changed' });
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
  symlinkSync(directory, join(directory, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(directory, '[a].txt'), join(root, 'file-link'));
  symlinkSync(directory, join(root, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { TeachingRuntime } from './runtime.js';
import { reply, response, syntheticConfig } from './test-support.js';

test('intake stages distinct fields, permits editing, and never confirms or starts a route', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const space = learning.create({ name: 'intake', goal: '学习 Rust' }), session = space.sessions[0]!.id;
  const expected = { goal: '制作字数统计工具', background: '只会 Python', outcome: '处理三个文件', schedule: '每周 3 小时，6 周' };
  let turns = 0;
  const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: (_m, context) => {
    assert.match(JSON.stringify(context), /学习 Rust/);
    return turns++ === 0 ? response(reply([{ type: 'toolCall', name: 'submit_requirement_draft', id: 'draft', arguments: expected }], 'toolUse')) : response(reply([{ type: 'text', text: '请确认时间。' }]));
  } });
  try {
    const { run } = runtime.submit(space.id, session, randomUUID(), { text: '只会 Python；做字数统计，3 小时/周共6周', quote: null, draftRevision: 0 });
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.deepEqual(learning.space(space.id).requirement, { value: expected, revision: 1, confirmed: false });
    assert.throws(() => runtime.submit(space.id, space.sessions[1]!.id, randomUUID(), { text: 'plan', quote: null, draftRevision: 0 }), /先确认/);
    const edited = learning.saveRequirement(space.id, { revision: 1, value: { ...expected, schedule: '每周 7 小时' }, confirmed: false });
    assert.equal(edited.value.schedule, '每周 7 小时');
    assert.equal(learning.saveRequirement(space.id, { ...edited, confirmed: true }).confirmed, true);
    assert.equal(learning.space(space.id).route.content, null);
  } finally { await runtime.close(); db.close(); }
});

test('invalid, truncated and late intake artifacts preserve valid drafts and newer confirmations', async () => {
  for (const variant of ['invalid', 'truncated', 'late'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const space = learning.create({ name: variant, goal: 'keep goal' }), session = space.sessions[0]!.id;
    let calls = 0;
    const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: () => {
      if (calls++ === 0) return response(reply([{ type: 'toolCall', name: 'submit_requirement_draft', id: 'draft', arguments:
        variant === 'invalid' ? { goal: 'bad', confirmed: true } : { goal: 'new model goal', background: 'model', outcome: '', schedule: '' },
      }], 'toolUse'));
      if (variant === 'late') learning.saveRequirement(space.id, { ...space.requirement, value: { ...space.requirement.value, schedule: 'new user value' }, confirmed: true });
      return response(reply([{ type: 'text', text: 'partial' }], variant === 'truncated' ? 'length' : 'stop'));
    } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'update', quote: null, draftRevision: 0 });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'failed', variant);
      const saved = learning.space(space.id).requirement;
      assert.equal(saved.value.goal, 'keep goal');
      assert.equal(saved.confirmed, variant === 'late');
      assert.equal(saved.value.schedule, variant === 'late' ? 'new user value' : '');
    } finally { await runtime.close(); db.close(); }
  }
});

test('retry reuses the fixed original input, does not duplicate users or clear a newer composer', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db);
  const space = learning.create({ name: 'retry', goal: 'retry' }), session = space.sessions[0]!.id;
  let fail = true;
  const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: (_m, context) => {
    assert.equal(context.messages.at(-1)?.content, 'original question');
    return response(reply([{ type: 'text', text: 'answer' }], fail ? 'error' : 'stop'));
  } });
  try {
    const first = runtime.submit(space.id, session, randomUUID(), { text: 'original question', quote: null, draftRevision: 0 });
    await runtime.idle(first.run.id);
    learning.saveSessionDraft(space.id, session, { revision: 1, text: 'new draft', quote: null, routeSuggestion: '' });
    fail = false;
    const key = randomUUID(), retried = runtime.retry(space.id, first.run.id, key);
    assert.equal(runtime.retry(space.id, first.run.id, key).run.id, retried.run.id);
    await runtime.idle(retried.run.id);
    assert.equal(runtime.get(space.id, retried.run.id).state, 'succeeded');
    assert.equal(learning.session(space.id, session).messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(learning.session(space.id, session).draft.text, 'new draft');
  } finally { await runtime.close(); db.close(); }
});

test('roadmap binds generation and confirmation to both revisions and preserves learned units', async () => {
  for (const change of ['none', 'requirement', 'route'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db);
    const space = learning.create({ name: change, goal: 'learn A not B' }), session = space.sessions[1]!.id;
    learning.saveRequirement(space.id, { ...space.requirement, confirmed: true });
    const content = { note: 'plan', stages: [{ id: randomUUID(), title: 'stage', units: [{ id: randomUUID(), title: 'unit', summary: '', goals: ['A'] }] }] };
    let turns = 0;
    const runtime = new TeachingRuntime(learning, syntheticConfig, { stream: (_m, context) => {
      assert.match(JSON.stringify(context), /learn A not B/);
      if (turns++ === 0) return response(reply([{ type: 'toolCall', id: 'plan', name: 'submit_route_proposal', arguments: content }], 'toolUse'));
      if (change === 'requirement') learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
      if (change === 'route') learning.applyProposal(space.id, learning.proposeRoute(space.id, session, content).id);
      return response(reply([{ type: 'text', text: '请确认提案' }]));
    } });
    try {
      const { run } = runtime.submit(space.id, session, randomUUID(), { text: 'plan', quote: null, draftRevision: 0 });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, change === 'none' ? 'succeeded' : 'failed');
      if (change !== 'none') continue;
      assert.equal(learning.space(space.id).route.content, null);
      const p = learning.space(space.id).proposals[0]!;
      const old = learning.proposeRoute(space.id, session, content);
      learning.applyProposal(space.id, p.id); learning.applyProposal(space.id, p.id);
      assert.equal(learning.space(space.id).route.revision, 1);
      assert.throws(() => learning.applyProposal(space.id, old.id), /内容已改变/);
      const unit = content.stages[0]!.units[0]!.id;
      learning.saveLesson(space.id, unit, { title: 'keep', content: 'learned' });
      const next = learning.proposeRoute(space.id, session, { ...content, note: 'adjust' });
      learning.applyProposal(space.id, next.id);
      assert.equal(learning.unit(space.id, unit).lesson!.content, 'learned');
      const late = learning.proposeRoute(space.id, session, content);
      learning.saveRequirement(space.id, { ...learning.space(space.id).requirement, confirmed: true });
      assert.throws(() => learning.applyProposal(space.id, late.id), /内容已改变/);
      const remove = learning.proposeRoute(space.id, session, { ...content, stages: [{ ...content.stages[0]!, units: [{ ...content.stages[0]!.units[0]!, id: randomUUID() }] }] });
      assert.throws(() => learning.applyProposal(space.id, remove.id), /不能移除/);
    } finally { await runtime.close(); db.close(); }
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateToolArguments, type ToolCall } from '@earendil-works/pi-ai';
import { idSchema } from '@teach-me-coding/contracts';
import { createRouteTools } from './route-tools.js';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { TeachingRuntime } from './runtime.js';
import { conceptIntake, reply, response, routeReply, syntheticSource } from './test-support.js';

function caller(draft: ReturnType<typeof createRouteTools>) {
  return async (name: string, args: ToolCall['arguments']) => {
    const tool = draft.tools.find((tool) => tool.name === name)!;
    const validated = validateToolArguments(tool, { type: 'toolCall', id: 'test', name, arguments: args });
    const result = await tool.execute('test', validated);
    return JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}');
  };
}

test('small route tools generate IDs, preserve order, reject incomplete drafts and require resubmission after edits', async () => {
  const draft = createRouteTools(null), call = caller(draft);
  const first = await call('add_route_stage', { title: 'Foundation' });
  const second = await call('add_route_stage', { title: 'Application' });
  assert.ok(idSchema.safeParse(first.stageId).success); assert.notEqual(first.stageId, second.stageId);
  await assert.rejects(call('submit_route_proposal', { note: 'Not ready' }));
  const a = await call('add_route_unit', { stageId: first.stageId, title: 'A', summary: 'First', goals: ['Explain A'] });
  const c = await call('add_route_unit', { stageId: first.stageId, title: 'C', summary: 'Third', goals: ['Apply C'] });
  const b = await call('add_route_unit', { stageId: first.stageId, position: 2, title: 'B', summary: 'Second', goals: ['Compare B'] });
  assert.ok(idSchema.safeParse(a.unitId).success);
  await call('update_route_unit', { unitId: c.unitId, stageId: second.stageId, summary: 'Uses A and B' });
  await assert.rejects(call('update_route_unit', { unitId: b.unitId, position: 99, title: 'MUST NOT MUTATE' }));
  await assert.rejects(call('add_route_unit', { stageId: randomUUID(), title: 'Wrong', summary: '', goals: [] }));
  await call('update_route_stage', { stageId: second.stageId, position: 1, title: 'Application renamed' });
  await call('submit_route_proposal', { note: 'A before B; C applies both.' });
  const submitted = draft.proposal()!;
  assert.deepEqual(submitted.stages.map((s) => [s.title, s.units.map((u) => u.title)]), [
    ['Application renamed', ['C']], ['Foundation', ['A', 'B']],
  ]);
  assert.equal(submitted.stages[0]!.units[0]!.summary, 'Uses A and B');
  assert.equal(submitted.stages[1]!.units[1]!.id, b.unitId);
  await call('update_route_unit', { unitId: a.unitId, title: 'A revised', position: 2 });
  assert.throws(() => draft.proposal(), /尚未完整提交/);
  assert.equal(submitted.stages[1]!.units[0]!.title, 'A', 'Finalized snapshots cannot mutate through later draft edits');
  await call('submit_route_proposal', { note: 'Revised' });
  assert.deepEqual(draft.proposal()!.stages[1]!.units.map((u) => u.title), ['B', 'A revised']);
});

test('adjustments preserve existing IDs, cannot delete published units, and can undo draft additions', async () => {
  const stageId = randomUUID(), unitId = randomUUID();
  const current = { note: 'original', stages: [{ id: stageId, title: 'Keep', units: [{ id: unitId, title: 'Existing', summary: 'Summary', goals: ['Goal'] }] }] };
  const draft = createRouteTools(current), call = caller(draft);
  await assert.rejects(call('remove_route_unit', { unitId }), /cannot be removed/);
  await assert.rejects(call('remove_route_stage', { stageId }), /units/);
  const added = await call('add_route_stage', { title: 'New' });
  const extra = await call('add_route_unit', { stageId: added.stageId, title: 'Mistake', summary: '', goals: [] });
  await call('remove_route_unit', { unitId: extra.unitId });
  await call('update_route_unit', { unitId, stageId: added.stageId, goals: ['Revised goal'] });
  await call('remove_route_stage', { stageId });
  await call('submit_route_proposal', { note: 'Moved, not recreated' });
  assert.deepEqual(draft.proposal(), { note: 'Moved, not recreated', stages: [{ id: added.stageId, title: 'New',
    units: [{ id: unitId, title: 'Existing', summary: 'Summary', goals: ['Revised goal'] }] }] });
  assert.equal(current.stages[0]!.units[0]!.goals[0], 'Goal');
});

test('granular planning crosses old request/tool/token ceilings and commits only after explicit submission', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), space = learning.create({ name: 'Long plan', goal: 'synthetic' });
  const content = { note: 'Separate foundations and applications.', stages: [
    { title: 'Foundation', units: Array.from({ length: 5 }, (_, i) => ({ title: `F${i}`, summary: `Foundation ${i}`, goals: [`Explain ${i}`] })) },
    { title: 'Application', units: Array.from({ length: 8 }, (_, i) => ({ title: `A${i}`, summary: `Application ${i}`, goals: [`Build ${i}`] })) },
  ] };
  let requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context, options) => {
    requests++;
    assert.equal(options?.maxTokens, undefined);
    assert.equal(learning.space(space.id).route.content, null, 'Incremental calls must not publish a partial route');
    const next = routeReply(context.messages, content) ?? reply([{ type: 'text', text: 'Complete' }]);
    next.usage.output = 5000; next.usage.totalTokens = 5011;
    return response(next);
  } });
  try {
    const { run } = runtime.plan(space.id, randomUUID(), { ...space.requirement, value: { ...space.requirement.value, goal: 'Plan thirteen units' }, intake: conceptIntake, confirmed: true });
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.equal(requests, 17);
    const saved = learning.space(space.id).route.content!;
    assert.equal(saved.note, content.note);
    assert.deepEqual(saved.stages.map((s) => s.units.map((u) => u.title)), [['F0', 'F1', 'F2', 'F3', 'F4'], ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']]);
    const ids = saved.stages.flatMap((s) => [s.id, ...s.units.map((u) => u.id)]);
    assert.equal(new Set(ids).size, 15); assert.ok(ids.every((id) => idSchema.safeParse(id).success));
    const manifests = db.prepare('SELECT value FROM context_manifests').all() as { value: string }[];
    assert.equal(manifests.reduce((n, row) => n + JSON.parse(row.value).actualUsage.output, 0), 85_000);
  } finally { await runtime.close(); db.close(); }
});

test('a rejected route tool can be corrected, but edits after submission cannot silently publish', async () => {
  for (const finalEdit of [false, true]) {
    const db = openDatabase(':memory:'), learning = new Learning(db), space = learning.create({ name: 'Repair', goal: 'synthetic' });
    let requests = 0, stageId = '';
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context) => {
      const last = context.messages.at(-1);
      if (last?.role === 'toolResult' && last.toolName === 'add_route_stage') stageId = JSON.parse(last.content[0]!.type === 'text' ? last.content[0]!.text : '{}').stageId;
      const steps: Pick<ToolCall, 'name' | 'arguments'>[] = [
        { name: 'add_route_stage', arguments: { title: 'Basics' } },
        { name: 'add_route_unit', arguments: { stageId, title: 'Incomplete' } },
        { name: 'add_route_unit', arguments: { stageId, title: 'Repaired', summary: 'Useful content', goals: ['Can do it'] } },
        { name: 'submit_route_proposal', arguments: { note: 'Complete now' } },
        ...(finalEdit ? [{ name: 'update_route_stage', arguments: { stageId, title: 'Late edit' } }] : []),
      ];
      const step = steps[requests++];
      return response(step ? reply([{ type: 'toolCall', id: `repair-${requests}`, ...step }], 'toolUse') : reply([]));
    } });
    try {
      const { run } = runtime.plan(space.id, randomUUID(), { ...space.requirement, value: { ...space.requirement.value, goal: 'Repair a tool call' }, intake: conceptIntake, confirmed: true });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, finalEdit ? 'failed' : 'succeeded');
      if (finalEdit) assert.equal(learning.space(space.id).route.content, null);
      else assert.equal(learning.space(space.id).route.content!.stages[0]!.units[0]!.title, 'Repaired');
      const tools = learning.session(space.id, run.sessionId!).messages.at(-1)!.parts!.filter((p) => p.type === 'tool');
      assert.equal(tools[1]!.status, 'error');
      assert.deepEqual(tools[1]!.input, { stageId, title: 'Incomplete' });
      assert.equal(tools[2]!.status, 'done');
    } finally { await runtime.close(); db.close(); }
  }
});

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

test('one initial submission preserves nested order and repeated titles, supplies optional defaults and creates unique IDs', async () => {
  const draft = createRouteTools(null), call = caller(draft);
  assert.deepEqual(draft.tools.map((tool) => tool.name), ['submit_route']);
  assert.equal(draft.proposal(), undefined);
  await assert.rejects(call('submit_route', { stages: [] }));
  await assert.rejects(call('submit_route', { stages: [{ title: 'Empty', units: [] }] }));
  const result = await call('submit_route', { stages: [
    { title: 'Foundation', units: [{ title: 'Repeated', summary: '  Explain input\n', goals: ['Predict output'] }, { title: 'B' }] },
    { title: 'Foundation', units: [{ title: 'Repeated', goals: ['Handle errors', 'Report results'] }] },
  ] });
  assert.equal(result.status, 'staged'); assert.equal(result.stages, 2); assert.equal(result.units, 3);
  const submitted = draft.proposal()!;
  assert.equal(submitted.note, '');
  assert.deepEqual(submitted.stages.map((stage) => ({ title: stage.title, units: stage.units.map(({ title, summary, goals }) => ({ title, summary, goals })) })), [
    { title: 'Foundation', units: [{ title: 'Repeated', summary: '  Explain input\n', goals: ['Predict output'] }, { title: 'B', summary: '', goals: [] }] },
    { title: 'Foundation', units: [{ title: 'Repeated', summary: '', goals: ['Handle errors', 'Report results'] }] },
  ]);
  const ids = submitted.stages.flatMap((stage) => [stage.id, ...stage.units.map((unit) => unit.id)]);
  assert.equal(new Set(ids).size, 5); assert.ok(ids.every((id) => idSchema.safeParse(id).success));
  await assert.rejects(call('submit_route', { stages: [{ title: '  ', units: [{ title: 'Rejected replacement' }] }] }), /title/);
  assert.deepEqual(draft.proposal(), submitted, 'Failed parsing must not replace a successful submission');
});

test('route adjustment tools generate IDs, preserve order, reject incomplete drafts and require resubmission after edits', async () => {
  const current = { note: 'original', stages: [{ id: randomUUID(), title: 'Original', units: [
    { id: randomUUID(), title: 'Keep', summary: 'Keep the existing lesson', goals: ['Keep progress'] },
  ] }] };
  const draft = createRouteTools(current), call = caller(draft);
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
    ['Application renamed', ['C']], ['Original', ['Keep']], ['Foundation', ['A', 'B']],
  ]);
  assert.equal(submitted.stages[0]!.units[0]!.summary, 'Uses A and B');
  assert.equal(submitted.stages[2]!.units[1]!.id, b.unitId);
  await call('update_route_unit', { unitId: a.unitId, title: 'A revised', position: 2 });
  assert.throws(() => draft.proposal(), /尚未完整提交/);
  assert.equal(submitted.stages[2]!.units[0]!.title, 'A', 'Finalized snapshots cannot mutate through later draft edits');
  await call('submit_route_proposal', { note: 'Revised' });
  assert.deepEqual(draft.proposal()!.stages[2]!.units.map((u) => u.title), ['B', 'A revised']);
});

test('adjustments preserve existing IDs, cannot delete published units, and can undo draft additions', async () => {
  const stageId = randomUUID(), unitId = randomUUID();
  const current = { note: 'original', stages: [{ id: stageId, title: 'Keep', units: [{ id: unitId, title: 'Existing', summary: 'Summary', goals: ['Goal'] }] }] };
  const draft = createRouteTools(current), call = caller(draft);
  await assert.rejects(call('remove_route_unit', { unitId }), /cannot be removed/);
  await assert.rejects(call('remove_route_stage', { stageId }), /units/);
  const added = await call('add_route_stage', { title: 'New' });
  const extra = await call('add_route_unit', { stageId: added.stageId, title: 'Mistake' });
  await call('submit_route_proposal', {});
  assert.deepEqual(draft.proposal()!.stages[1]!.units[0], { id: extra.unitId, title: 'Mistake', summary: '', goals: [] });
  await call('remove_route_unit', { unitId: extra.unitId });
  await call('update_route_unit', { unitId, stageId: added.stageId, goals: ['Revised goal'] });
  await call('remove_route_stage', { stageId });
  await call('submit_route_proposal', { note: 'Moved, not recreated' });
  assert.deepEqual(draft.proposal(), { note: 'Moved, not recreated', stages: [{ id: added.stageId, title: 'New',
    units: [{ id: unitId, title: 'Existing', summary: 'Summary', goals: ['Revised goal'] }] }] });
  assert.equal(current.stages[0]!.units[0]!.goals[0], 'Goal');
});

test('unchanged updates preserve submissions and omitted fields, while actual goal changes still require resubmission', async () => {
  const stageId = randomUUID(), unitId = randomUUID(), siblingId = randomUUID();
  const current = { note: 'original', stages: [{ id: stageId, title: 'Foundation', units: [
    { id: unitId, title: 'A', summary: 'Original scope', goals: ['Explain A', 'Compare A'] },
    { id: siblingId, title: 'B', summary: 'Different scope', goals: ['Apply B'] },
  ] }] };
  const draft = createRouteTools(current), call = caller(draft);
  const unchanged: Pick<ToolCall, 'name' | 'arguments'>[] = [
    { name: 'update_route_stage', arguments: { stageId } },
    { name: 'update_route_stage', arguments: { stageId, title: ' Foundation ', position: 1 } },
    { name: 'update_route_unit', arguments: { unitId } },
    { name: 'update_route_unit', arguments: { unitId, stageId, title: 'A', summary: 'Original scope', goals: ['Explain A', 'Compare A'], position: 1 } },
    { name: 'update_route_unit', arguments: { unitId: siblingId, position: 2 } },
  ];
  for (const step of unchanged) assert.equal((await call(step.name, step.arguments)).changed, false);
  assert.equal(draft.proposal(), undefined);
  await call('submit_route_proposal', {});
  const submitted = draft.proposal()!;
  assert.deepEqual(submitted, { ...current, note: '' });
  for (const step of unchanged) {
    assert.equal((await call(step.name, step.arguments)).changed, false);
    assert.deepEqual(draft.proposal(), submitted);
  }
  assert.equal((await call('update_route_unit', { unitId, goals: ['Explain A', 'Apply A'] })).changed, true);
  assert.throws(() => draft.proposal(), /尚未完整提交/);
  await call('update_route_unit', { unitId });
  assert.throws(() => draft.proposal(), /尚未完整提交/);
  await call('submit_route_proposal', {});
  assert.deepEqual(draft.proposal()!.stages[0]!.units[0], { id: unitId, title: 'A', summary: 'Original scope', goals: ['Explain A', 'Apply A'] });
  assert.deepEqual(current.stages[0]!.units[0]!.goals, ['Explain A', 'Compare A']);
});

test('a complete multi-stage initial route needs one submission and commits only after normal completion', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), space = learning.create({ name: 'Long plan', goal: 'synthetic' });
  const content = { note: 'Separate foundations and applications.', stages: [
    { title: 'Foundation', units: Array.from({ length: 5 }, (_, i) => ({ title: `F${i}`, summary: `Foundation ${i}`, goals: [`Explain ${i}`] })) },
    { title: 'Application', units: Array.from({ length: 8 }, (_, i) => ({ title: `A${i}`, summary: `Application ${i}`, goals: [`Build ${i}`] })) },
  ] };
  let requests = 0;
  const runtime = new TeachingRuntime(learning, syntheticSource, { stream: (_m, context, options) => {
    requests++;
    assert.equal(options?.maxTokens, undefined);
    assert.equal(learning.space(space.id).route.content, null, 'Submission must not publish before normal completion');
    const next = routeReply(context.messages, content) ?? reply([{ type: 'text', text: 'Complete' }]);
    next.usage.output = 5000; next.usage.totalTokens = 5011;
    return response(next);
  } });
  try {
    const { run } = runtime.plan(space.id, randomUUID(), { ...space.requirement, value: { rows: [{ question: 'Plan what?', answer: 'Plan thirteen units' }] }, intake: conceptIntake, confirmed: true });
    await runtime.idle(run.id);
    assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.equal(requests, 2);
    const calls = learning.session(space.id, run.sessionId!).messages.at(-1)!.parts!.filter((part) => part.type === 'tool');
    assert.deepEqual(calls.map((call) => call.name), ['submit_route']);
    const saved = learning.space(space.id).route.content!;
    assert.equal(saved.note, content.note);
    assert.deepEqual(saved.stages.map((s) => s.units.map((u) => u.title)), [['F0', 'F1', 'F2', 'F3', 'F4'], ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']]);
    const ids = saved.stages.flatMap((s) => [s.id, ...s.units.map((u) => u.id)]);
    assert.equal(new Set(ids).size, 15); assert.ok(ids.every((id) => idSchema.safeParse(id).success));
    const manifests = db.prepare('SELECT value FROM context_manifests').all() as { value: string }[];
    assert.equal(manifests.reduce((n, row) => n + JSON.parse(row.value).actualUsage.output, 0), 10_000);
  } finally { await runtime.close(); db.close(); }
});

test('initial submissions can be corrected and failed replacements preserve the last successful route', async () => {
  for (const invalidReplacement of [null, 'arguments', 'content'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db), space = learning.create({ name: 'Repair', goal: 'synthetic' });
    let requests = 0;
    const runtime = new TeachingRuntime(learning, syntheticSource, { stream: () => {
      const steps: Pick<ToolCall, 'name' | 'arguments'>[] = [
        { name: 'submit_route', arguments: { stages: [{ title: 'Basics', units: [] }] } },
        { name: 'submit_route', arguments: { stages: [{ title: 'Basics', units: [{ title: 'Repaired' }] }] } },
      ];
      if (invalidReplacement) steps.push({ name: 'submit_route', arguments: invalidReplacement === 'arguments' ? { stages: [] }
        : { stages: [{ title: '  ', units: [{ title: 'Rejected replacement' }] }] } });
      const step = steps[requests++];
      return response(step ? reply([{ type: 'toolCall', id: `repair-${requests}`, ...step }], 'toolUse') : reply([]));
    } });
    try {
      const { run } = runtime.plan(space.id, randomUUID(), { ...space.requirement, value: { rows: [{ question: 'Plan what?', answer: 'Repair a tool call' }] }, intake: conceptIntake, confirmed: true });
      await runtime.idle(run.id);
      assert.equal(runtime.get(space.id, run.id).state, 'succeeded', invalidReplacement ?? 'corrected');
      assert.equal(learning.space(space.id).route.content!.stages[0]!.units[0]!.title, 'Repaired');
      const tools = learning.session(space.id, run.sessionId!).messages.at(-1)!.parts!.filter((p) => p.type === 'tool');
      assert.equal(tools[0]!.status, 'error');
      assert.deepEqual(tools[0]!.input, { stages: [{ title: 'Basics', units: [] }] });
      assert.equal(tools[1]!.status, 'done');
      if (invalidReplacement) assert.equal(tools[2]!.status, 'error');
    } finally { await runtime.close(); db.close(); }
  }
});

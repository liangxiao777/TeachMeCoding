import { createAssistantMessageEventStream, createProvider, InMemoryCredentialStore, type Api, type AssistantMessage, type JsonObject, type Message, type Model } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { IntakeMetadata, RouteSubmission } from '@teach-me-coding/contracts';
import type { ModelSource } from '../models/service.js';
import { randomUUID } from 'node:crypto';
import type { Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import { baseline } from './tasks.js';

// Unrelated route/task tests use generic programming concepts, not verified technology claims.
export const conceptIntake: IntakeMetadata = { researchRef: null };

export function populated(learning: Learning, name = 'Rust') {
  const space = learning.create({ name, goal: `学习 ${name}` });
  learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: '想学习什么？', answer: `学习 ${name}` }] }, intake: conceptIntake, confirmed: true });
  const unit = () => ({ id: randomUUID(), title: 'Unit', summary: 'Summary', goals: ['Goal'] });
  const units = [unit(), unit()];
  const routeSession = space.sessions.find((s) => s.scope === 'route')!.id;
  const p = learning.proposeRoute(space.id, routeSession, { note: 'Test route', stages: [{ id: randomUUID(), title: 'Stage', units }] });
  learning.applyProposal(space.id, p.id);
  return { space: learning.space(space.id), units, routeSession };
}

// Source work is a saved successful lesson task, not a bypass around review/version checks.
export function stageLesson(learning: Learning, space: string, unit: string, input: unknown, refs: { unitId: string; revision: number }[] = []) {
  const w = learning.space(space), id = randomUUID();
  const frozen: FrozenContext = { spaceId: space, unitId: unit, sessionId: null, scenario: 'lesson',
    requirement: w.requirement, route: w.route, unit: w.route.content!.stages.flatMap((s) => s.units).find((u) => u.id === unit)!,
    lesson: learning.unit(space, unit).lesson, lessonRefs: learning.lessonReferences(space), references: [] };
  return learning.db.transaction(() => {
    learning.db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,'lesson','succeeded')").run(space, id, unit);
    learning.db.prepare('INSERT INTO task_runs(space_id,id,input,created_at) VALUES (?,?,?,?)').run(space, id, JSON.stringify(frozen), Date.now());
    return learning.proposeLesson(space, unit, input, baseline(frozen), { kind: 'task', id }, refs);
  })();
}
export function approveLesson(learning: Learning, space: string, unit: string, input: unknown) {
  const proposal = stageLesson(learning, space, unit, input);
  return proposal ? learning.applyLessonProposal(space, proposal.id).unit.lesson! : learning.unit(space, unit).lesson!;
}

export const teachingModel = getBuiltinModel('openrouter', 'stealth/space-bunny-alpha');
export const syntheticSelection = { provider: 'openrouter', model: teachingModel.id, thinkingLevel: 'high' as const };
export async function syntheticSessionRuntime(model: Model<Api>) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const noTransport = () => { throw new Error('Synthetic session must use the test stream'); };
  runtime.registerNativeProvider(createProvider({ id: model.provider, name: 'Synthetic', models: [model],
    api: { stream: noTransport, streamSimple: noTransport },
    auth: { apiKey: { name: 'Synthetic transport',
      check: async () => ({ type: 'api_key', source: 'synthetic' }),
      resolve: async () => ({ type: 'api_key', source: 'synthetic', auth: { apiKey: 'synthetic-test-only' } }),
    } },
  }));
  await runtime.refresh({ providers: [model.provider], allowNetwork: false });
  return runtime;
}
export const syntheticSource: ModelSource = {
  current: () => ({ selection: syntheticSelection, model: teachingModel }),
  resolve: (selection) => selection.provider === syntheticSelection.provider && selection.model === syntheticSelection.model ? teachingModel : undefined,
  sessionRuntime: syntheticSessionRuntime,
};
// Initial routes express content without storage IDs; adjustments finalize their existing draft.
export function routeReply(messages: Message[], content: RouteSubmission, adjustment = false) {
  const current = messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1);
  const calls = current.flatMap((m) => m.role === 'assistant' ? m.content.filter((p) => p.type === 'toolCall') : []);
  if (calls.length) return null;
  const args: JsonObject = {};
  if (content.note !== undefined) args.note = content.note;
  if (!adjustment) args.stages = content.stages.map((stage) => ({ title: stage.title, units: stage.units.map((unit) => {
    const value: JsonObject = { title: unit.title };
    if (unit.summary !== undefined) value.summary = unit.summary;
    if (unit.goals !== undefined) value.goals = unit.goals;
    return value;
  }) }));
  return reply([{ type: 'toolCall', id: 'route-0', name: adjustment ? 'submit_route_proposal' : 'submit_route', arguments: args }], 'toolUse');
}
export function reply(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, timestamp: 1, api: teachingModel.api, provider: teachingModel.provider, model: teachingModel.id,
    usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function response(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
  message.content.forEach((part, contentIndex) => {
    if (part.type === 'text') {
      stream.push({ type: 'text_start', contentIndex, partial: message });
      stream.push({ type: 'text_delta', contentIndex, delta: part.text, partial: message });
      stream.push({ type: 'text_end', contentIndex, content: part.text, partial: message });
    }
    if (part.type === 'thinking') {
      stream.push({ type: 'thinking_start', contentIndex, partial: message });
      stream.push({ type: 'thinking_delta', contentIndex, delta: part.thinking, partial: message });
      stream.push({ type: 'thinking_end', contentIndex, content: part.thinking, partial: message });
    }
  });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
  else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
  return stream;
}

import { createAssistantMessageEventStream, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { RouteContent } from '@teach-me-coding/contracts';
import type { ModelSource } from '../models/service.js';
import { randomUUID } from 'node:crypto';
import type { Learning } from '../modules/learning.js';

export function populated(learning: Learning, name = 'Rust') {
  const space = learning.create({ name, goal: `学习 ${name}` });
  learning.saveRequirement(space.id, { ...space.requirement, value: { ...space.requirement.value, goal: `学习 ${name}` }, confirmed: true });
  const unit = () => ({ id: randomUUID(), title: 'Unit', summary: 'Summary', goals: ['Goal'] });
  const units = [unit(), unit()];
  const routeSession = space.sessions.find((s) => s.scope === 'route')!.id;
  const p = learning.proposeRoute(space.id, routeSession, { note: 'Test route', stages: [{ id: randomUUID(), title: 'Stage', units }] });
  learning.applyProposal(space.id, p.id);
  return { space: learning.space(space.id), units, routeSession };
}

export const teachingModel = getBuiltinModel('openrouter', 'stealth/space-bunny-alpha');
export const syntheticSelection = { provider: 'openrouter', model: teachingModel.id, thinkingLevel: 'high' as const };
export const syntheticSource: ModelSource = {
  current: () => ({ selection: syntheticSelection, model: teachingModel }),
  resolve: (selection) => selection.provider === syntheticSelection.provider && selection.model === syntheticSelection.model ? teachingModel : undefined,
};
// Follow the actual host-generated stage IDs, never manufacture IDs in model arguments.
export function routeReply(messages: Message[], content: { note: string; stages: { title: string; units: Omit<RouteContent['stages'][number]['units'][number], 'id'>[] }[] }, adjustment = false) {
  const current = messages.slice(messages.findLastIndex((m) => m.role === 'user') + 1);
  const calls = current.flatMap((m) => m.role === 'assistant' ? m.content.filter((p) => p.type === 'toolCall') : []);
  const stages = current.flatMap((m) => m.role === 'toolResult' && m.toolName === 'add_route_stage' && !m.isError ? [JSON.parse(m.content[0]!.type === 'text' ? m.content[0]!.text : '{}').stageId as string] : []);
  const steps = adjustment ? [] : content.stages.flatMap((stage, i) => [
    { name: 'add_route_stage', arguments: { title: stage.title } },
    ...stage.units.map(({ title, summary, goals }) => ({ name: 'add_route_unit', arguments: { stageId: stages[i], title, summary, goals } })),
  ]);
  const step = [...steps, { name: 'submit_route_proposal', arguments: { note: content.note } }][calls.length];
  return step ? reply([{ type: 'toolCall', id: `route-${calls.length}`, ...step }], 'toolUse') : null;
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

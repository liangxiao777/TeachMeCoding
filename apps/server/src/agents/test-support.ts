import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { teachingModel } from './model.js';
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

export const syntheticConfig = { model: teachingModel.id, apiKey: 'synthetic-test-only' };
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
  });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
  else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
  return stream;
}

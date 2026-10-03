import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { teachingModel } from './model.js';

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

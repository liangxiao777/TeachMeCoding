import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { budget } from './context.js';

// OpenRouter /api/v1/models, checked 2026-10-03. Prices are USD / million tokens.
// Application budgets below are deliberately much smaller than the provider limits.
export const teachingModel: Model<'openai-completions'> = {
  id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'openrouter', api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1', reasoning: true, input: ['text', 'image'],
  contextWindow: 1_048_576, maxTokens: 943_718,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
  compat: { thinkingFormat: 'openrouter', maxTokensField: 'max_tokens' },
  samplingParams: { reasoning: { enabled: false } },
};
export function providerStream(): StreamFn {
  const models = createModels();
  models.setProvider(openrouterProvider());
  return (model, context, options) => models.streamSimple(model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? budget.output, budget.output) });
}
export function failureStream(reason: string, aborted = false) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = { role: 'assistant', api: teachingModel.api, provider: teachingModel.provider,
    model: teachingModel.id, timestamp: Date.now(), content: [], stopReason: aborted ? 'aborted' : 'error', errorMessage: reason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error });
  return stream;
}

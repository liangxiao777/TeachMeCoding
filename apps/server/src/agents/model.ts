import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { budget } from './context.js';

// OpenRouter /api/v1/models, checked 2026-10-03. Prices are USD / million tokens.
// Capability metadata, not application-enforced request limits.
export const teachingModel: Model<'openai-completions'> = {
  id: 'stealth/space-bunny-alpha', name: 'Space Bunny Alpha', provider: 'openrouter', api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1', reasoning: true, input: ['text', 'image'],
  contextWindow: 1_000_000, maxTokens: 524_288,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { thinkingFormat: 'openrouter', maxTokensField: 'max_tokens' },
  samplingParams: { reasoning: { enabled: true, effort: budget.reasoning } },
};
export function providerStream(): StreamFn {
  const models = createModels();
  models.setProvider(openrouterProvider());
  // streamSimple estimates remaining context and inserts a maxTokens default.
  // The provider-native API leaves output length to the provider when omitted.
  return (model, context, options) => models.stream(model, context, { ...options, reasoningEffort: options?.reasoning });
}
export function failureStream(reason: string, aborted = false) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = { role: 'assistant', api: teachingModel.api, provider: teachingModel.provider,
    model: teachingModel.id, timestamp: Date.now(), content: [], stopReason: aborted ? 'aborted' : 'error', errorMessage: reason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error });
  return stream;
}

import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type Models, type RetryPolicy } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { storedModels } from '../models/auth.js';

// pi-coding-agent 1.0.0 defaults, shared by sessions and the scoped HTTP transport.
export const defaultHttpIdleTimeoutMs = 300_000;
export const defaultRetryPolicy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

/**
 * Follow pi-coding-agent's ordinary simple-stream path: Models resolves auth,
 * while provider implementations map reasoning and derive the output ceiling.
 * The host adds no maxTokens override or cumulative token budget.
 */
export function providerStream(models: Models = storedModels()): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}
export function failureStream(model: Pick<Model<Api>, 'api' | 'provider' | 'id'>, reason: string, aborted = false) {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider,
    model: model.id, timestamp: Date.now(), content: [], stopReason: aborted ? 'aborted' : 'error', errorMessage: reason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error });
  return stream;
}

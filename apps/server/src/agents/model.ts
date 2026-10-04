import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type Models } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/**
 * pi-ai's unified request path: auth resolution and per-API reasoning mapping.
 * streamSimple sets an output ceiling from the model maximum and the estimated
 * remaining context; that is an accepted trade-off for provider-neutral reasoning.
 */
export function providerStream(models: Models = builtinModels()): StreamFn {
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

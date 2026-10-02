import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModels, type Model } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { ModelConfig } from '../config/model.js';

export function createProviderAgent(config: ModelConfig, options: { streamFn?: StreamFn; tools?: Agent['state']['tools'] } = {}) {
  const models = createModels();
  models.setProvider(openrouterProvider());
  // The provider catalog can predate an alias. Send the exact configured ID;
  // these conservative smoke-test limits/zero cost metadata are not pricing claims.
  const model: Model<'openai-completions'> = {
    id: config.model, name: config.model, provider: 'openrouter', api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1', reasoning: true, input: ['text'],
    compat: { thinkingFormat: 'openrouter', maxTokensField: 'max_tokens' },
    samplingParams: { reasoning: { enabled: false } },
    // Leave room above Pi's 4096-token context safety reserve.
    contextWindow: 8192, maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return new Agent({
    initialState: {
      model, thinkingLevel: 'off', systemPrompt: 'You are running a short API compatibility check.',
      tools: options.tools ?? [],
    },
    streamFn: options.streamFn ?? ((selected, context, streamOptions) => models.streamSimple(selected, context, {
      ...streamOptions, maxTokens: 256,
    })),
    getApiKey: (provider) => provider === 'openrouter' ? config.apiKey : undefined,
  });
}

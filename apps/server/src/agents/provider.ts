import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { ModelConfig } from '../config/model.js';
import { budget } from './context.js';
import { providerStream, teachingModel } from './model.js';

export function createProviderAgent(config: ModelConfig, options: { streamFn?: StreamFn; tools?: Agent['state']['tools'] } = {}) {
  // Exercise the teaching transport and required reasoning settings, not a
  // reasoning-disabled smoke configuration rejected by the selected model.
  return new Agent({
    initialState: {
      model: { ...teachingModel, id: config.model, name: config.model },
      thinkingLevel: budget.reasoning, systemPrompt: 'You are running a short API compatibility check.',
      tools: options.tools ?? [],
    },
    streamFn: options.streamFn ?? providerStream(),
    getApiKey: (provider) => provider === 'openrouter' ? config.apiKey : undefined,
  });
}

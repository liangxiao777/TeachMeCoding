import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { ModelSelection } from '@teach-me-coding/contracts';
import type { ModelSource } from '../models/service.js';
import { providerStream } from './model.js';

export function createProviderAgent(models: ModelSource, selection: ModelSelection, options: { streamFn?: StreamFn; tools?: Agent['state']['tools'] } = {}) {
  const model = models.resolve(selection);
  if (!model) throw new Error(`Model not found in the pi-ai catalog: ${selection.provider}/${selection.model}`);
  return new Agent({
    initialState: {
      model,
      thinkingLevel: selection.thinkingLevel, systemPrompt: 'You are running a short API compatibility check.',
      tools: options.tools ?? [],
    },
    streamFn: options.streamFn ?? models.stream ?? providerStream(),
  });
}

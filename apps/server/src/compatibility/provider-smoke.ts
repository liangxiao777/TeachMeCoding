import { createProviderAgent } from '../agents/provider.js';
import { loadModelConfig } from '../config/model.js';

let apiKey = '';
try {
  const config = loadModelConfig();
  apiKey = config.apiKey;
  for (const cancel of [false, true]) {
    const agent = createProviderAgent(config);
    let deltas = 0;
    let characters = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; agent.abort(); }, 60_000);
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        deltas++;
        characters += event.assistantMessageEvent.delta.length;
        if (cancel) agent.abort();
      }
    });
    try {
      await agent.prompt(cancel ? 'Count from one to one hundred, one number per line.' : 'Reply with exactly: Hello 42');
      const result = agent.state.messages.at(-1);
      if (timedOut) throw new Error('Provider request timed out after 60 seconds.');
      if (result?.role !== 'assistant') throw new Error('Provider produced no assistant message.');
      if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'Provider request failed.');
      if (deltas === 0 || characters === 0) throw new Error('Provider produced no text deltas.');
      if (cancel ? result.stopReason !== 'aborted' : result.stopReason !== 'stop') {
        throw new Error(`Unexpected provider stop reason: ${result.stopReason}`);
      }
      if (!cancel && !result.content.some((part) => part.type === 'text' && part.text.includes('42'))) {
        throw new Error('Provider reply did not contain the requested number.');
      }
      console.log(JSON.stringify({ provider: 'openrouter', model: config.model,
        check: cancel ? 'live-cancellation' : 'live-stream', deltas, characters, stopReason: result.stopReason }));
    } finally {
      clearTimeout(timer);
      unsubscribe();
      agent.abort();
      await agent.waitForIdle();
    }
  }
} catch (error) {
  // Never dump SDK objects, headers, transcripts, or environment configuration.
  const message = error instanceof Error ? error.message : 'Provider smoke failed.';
  console.error(apiKey ? message.replaceAll(apiKey, '[redacted]') : message);
  process.exitCode = 1;
}

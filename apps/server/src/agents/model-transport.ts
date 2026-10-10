import { EventEmitter } from 'node:events';
import { Client, EnvHttpProxyAgent, Pool, fetch as httpFetch, type Dispatcher } from 'undici';

// pi-ai 1.0.0 has no public fetch-capability metadata. Google rejects injection;
// Bedrock uses its own SDK transport. Leave those paths (and unknown APIs) native.
const fetchApis = new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'azure-openai-responses',
  'mistral-conversations', 'openai-codex-responses', 'pi-messages']);

// Match Pi's HTTP transport without changing the host's global fetch/dispatcher.
// Body-reader failures still reach pi-ai; dispatcher errors must not crash Node.
function withErrorListener<T extends Dispatcher>(dispatcher: T): T {
  EventEmitter.prototype.on.call(dispatcher, 'error', () => {});
  return dispatcher;
}
function client(origin: string | URL, options: object): Dispatcher {
  return withErrorListener(new Client(origin, options as Client.Options));
}
function originDispatcher(origin: string | URL, options: object): Dispatcher {
  const settings = options as Pool.Options;
  return settings.connections === 1 ? client(origin, options) : withErrorListener(new Pool(origin, { ...settings, factory: client }));
}

export function createModelTransport(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid model HTTP idle timeout.');
  let dispatcher: EnvHttpProxyAgent | undefined;
  const fetch: typeof globalThis.fetch = (input, options) => {
    dispatcher ??= withErrorListener(new EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true,
      headersTimeout: Math.floor(timeoutMs), bodyTimeout: Math.floor(timeoutMs),
      connect: { autoSelectFamilyAttemptTimeout: 2000 }, clientFactory: client, factory: originDispatcher }));
    // Node and npm Undici declare different Web Fetch iterator types.
    return httpFetch(input as Parameters<typeof httpFetch>[0], { ...options, dispatcher } as Parameters<typeof httpFetch>[1]) as unknown as Promise<Response>;
  };
  return { fetchFor: (api: string) => fetchApis.has(api) ? fetch : undefined, close: async () => { await dispatcher?.close(); } };
}

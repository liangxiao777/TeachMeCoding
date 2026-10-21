import { createModels, envApiKeyAuth, InMemoryCredentialStore, type ApiKeyAuth, type AuthContext, type CredentialStore } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

/** App credentials are the only auth source; OS environment/files are not discovery inputs. */
export const storedAuthContext: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

export function storedModels(credentials: CredentialStore = new InMemoryCredentialStore()) {
  const models = createModels({ credentials, authContext: storedAuthContext });
  for (const provider of builtinProviders()) {
    // Bedrock's transport still consults AWS profiles/default SDK credentials.
    if (provider.id === 'amazon-bedrock') continue;
    let apiKey = provider.auth.apiKey;
    if (provider.id === 'google-vertex') apiKey = envApiKeyAuth('Google Cloud API key', []);
    if (apiKey) {
      const original = apiKey;
      const resolve: ApiKeyAuth['resolve'] = async (input) => {
        if (!input.credential) return undefined;
        const key = input.credential.key?.trim();
        // Vertex treats these placeholders as instructions to discover ADC instead.
        if (provider.id === 'google-vertex' && (!key || key === 'gcp-vertex-credentials' || /^<.*>$/.test(key))) return undefined;
        const resolved = await original.resolve({ ...input, ctx: storedAuthContext });
        if (!resolved || !resolved.auth.apiKey?.trim() && !Object.values(resolved.auth.headers ?? {}).some(Boolean)) return undefined;
        return { ...resolved, env: resolved.env ?? {} };
      };
      apiKey = { ...original, resolve, check: async (input) => await resolve(input) ? { type: 'api_key' } : undefined };
    }
    models.setProvider({ ...provider, auth: { ...provider.auth, ...(apiKey ? { apiKey } : {}) },
      stream: (model, context, options) => provider.stream(model, context, { ...options, env: options?.env ?? {} } as typeof options),
      streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, env: options?.env ?? {} }),
    });
  }
  return models;
}

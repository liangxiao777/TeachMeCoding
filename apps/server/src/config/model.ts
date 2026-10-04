import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export type EnvLookup = (name: string) => string | undefined;

// Parse into a private lookup: never populate process.env or a Vite env object.
// A variable present in the server environment, even empty, overrides the file.
export function serverEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  envFile: string | URL = new URL('../../../../.env', import.meta.url),
): EnvLookup {
  let file: NodeJS.ProcessEnv = {};
  try {
    file = parseEnv(readFileSync(envFile, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read server .env file.');
  }
  return (name) => (Object.hasOwn(environment, name) ? environment[name] : file[name])?.trim() || undefined;
}

/** Initial choice before any saved setting: the previously required OpenRouter model. */
export function defaultModel(env: EnvLookup) {
  const model = env('OPENROUTER_MODEL');
  return model ? { provider: 'openrouter', model } : null;
}

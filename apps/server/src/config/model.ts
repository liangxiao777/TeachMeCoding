import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface ModelConfig {
  apiKey: string;
  model: string;
}

// Parse into a private object: never populate process.env or a Vite env object.
export function loadModelConfig(
  environment: NodeJS.ProcessEnv = process.env,
  envFile: string | URL = new URL('../../../../.env', import.meta.url),
): ModelConfig {
  let file: NodeJS.ProcessEnv = {};
  try {
    file = parseEnv(readFileSync(envFile, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read server .env file.');
  }
  const apiKey = (environment.OPENROUTER_API_KEY ?? file.OPENROUTER_API_KEY)?.trim();
  const model = (environment.OPENROUTER_MODEL ?? file.OPENROUTER_MODEL)?.trim();
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY in the server environment or root .env.');
  if (!model) throw new Error('Set OPENROUTER_MODEL explicitly; no fallback model is selected.');
  return { apiKey, model };
}

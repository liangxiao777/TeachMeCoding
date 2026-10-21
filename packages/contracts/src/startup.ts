import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const keys = ['TMC_DATA_DIR', 'HOST', 'PORT', 'TMC_WEB_PORT', 'TMC_PREVIEW_ORIGIN', 'TMC_AGENT_DEBUG_SNAPSHOTS'] as const;

// Source and compiled modules have the same depth relative to the project root.
export function startupEnvironment(environment: NodeJS.ProcessEnv = process.env, path: string | URL = new URL('../../../.env', import.meta.url)): NodeJS.ProcessEnv {
  let saved: NodeJS.ProcessEnv = {};
  try { saved = parseEnv(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Startup .env file cannot be read.');
  }
  const resolved: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = environment[key] ?? saved[key];
    if (value !== undefined) resolved[key] = value;
  }
  // Scripts, not .env, choose development or production mode.
  if (environment.NODE_ENV !== undefined) resolved.NODE_ENV = environment.NODE_ENV;
  return resolved;
}

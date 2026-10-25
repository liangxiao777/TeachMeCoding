import { cpSync } from 'node:fs';

cpSync(new URL('../apps/server/src/agents/prompts/', import.meta.url), new URL('../apps/server/dist/agents/prompts/', import.meta.url), { recursive: true });

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Tool } from '@earendil-works/pi-ai';
import type { McpService } from '../extensions/mcp.js';
import type { SearchService } from '../extensions/search.js';
import { createWebFetchTool, type WebFetchOptions } from '../extensions/web-fetch.js';
import { BusinessError } from '../modules/learning.js';
import { readTools } from './read-tools.js';
import type { Library } from '../modules/library.js';

export interface PreparedTools {
  tools: AgentTool[];
  declarations: Tool[];
  inventory: { name: string; source: 'scenario' | 'skills-read' | 'mcp' | 'search' | 'web-fetch' | 'library' }[];
}

/** Assemble once per run; providers retain their own configuration and execution lifecycle. */
export async function prepareTools(input: {
  scenarioTools: AgentTool[];
  cwd: () => string;
  hasSkills: boolean;
  mcp?: Pick<McpService, 'tools'>;
  search?: Pick<SearchService, 'tools'>;
  webFetch?: WebFetchOptions;
  library?: Pick<Library, 'tools'>;
  runId?: string;
  signal: AbortSignal;
}): Promise<PreparedTools> {
  input.signal.throwIfAborted();
  const external = await input.mcp?.tools(input.signal) ?? [];
  input.signal.throwIfAborted();
  const reads = input.hasSkills || input.library ? readTools(input.cwd())
    .filter((tool) => !input.scenarioTools.some((existing) => existing.name === tool.name)) : [];
  const search = await input.search?.tools(input.signal) ?? [];
  input.signal.throwIfAborted();
  const groups = [
    { source: 'scenario', tools: input.scenarioTools },
    { source: input.library ? 'library' : 'skills-read', tools: reads },
    { source: 'library', tools: input.library?.tools(input.runId) ?? [] },
    { source: 'mcp', tools: external },
    { source: 'search', tools: search },
    { source: 'web-fetch', tools: [createWebFetchTool(input.webFetch)] },
  ] as const;
  const tools = groups.flatMap((group) => group.tools);
  const inventory = groups.flatMap((group) => group.tools.map(({ name }) => ({ name, source: group.source })));
  const names = new Map<string, PreparedTools['inventory'][number]['source']>();
  for (const { name, source } of inventory) {
    const previous = names.get(name);
    if (previous !== undefined) throw new BusinessError(422, { code: 'TOOL_NAME_CONFLICT' });
    names.set(name, source);
  }
  return {
    tools,
    declarations: tools.map(({ name, description, parameters, outputSchema }) => ({ name, description, parameters, ...(outputSchema ? { outputSchema } : {}) })),
    inventory,
  };
}

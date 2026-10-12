import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../apps/server/node_modules/@hono/node-server/dist/index.mjs';
import { syntheticSource } from '../apps/server/src/agents/test-support.js';
import { agentTransport } from './agent-transport.js';

const mode = process.argv[2];
if (mode !== 'production' && mode !== 'development') throw new Error('Choose serving mode');
const directory = mode === 'production' ? 'dist' : 'src';
// Production loads the built runtime and prompt assets; neither path reads .env.
const { TeachingRuntime } = await import(`../apps/server/${directory}/agents/runtime.js`) as typeof import('../apps/server/src/agents/runtime.js');
const { createApp } = await import(`../apps/server/${directory}/http/app.js`) as typeof import('../apps/server/src/http/app.js');
const { openDataDirectory } = await import(`../apps/server/${directory}/storage/data-directory.js`) as typeof import('../apps/server/src/storage/data-directory.js');
const { Learning } = await import(`../apps/server/${directory}/modules/learning.js`) as typeof import('../apps/server/src/modules/learning.js');
const { Projects } = await import(`../apps/server/${directory}/modules/projects.js`) as typeof import('../apps/server/src/modules/projects.js');
const { Actions } = await import(`../apps/server/${directory}/modules/actions.js`) as typeof import('../apps/server/src/modules/actions.js');
const { Executions } = await import(`../apps/server/${directory}/modules/executions.js`) as typeof import('../apps/server/src/modules/executions.js');
const { createLocalAccess, terminalUpgradeGate } = await import(`../apps/server/${directory}/http/local-access.js`) as typeof import('../apps/server/src/http/local-access.js');
const { Terminals } = await import(`../apps/server/${directory}/runtime/terminals.js`) as typeof import('../apps/server/src/runtime/terminals.js');
const { serverConfig } = await import(`../apps/server/${directory}/config/server.js`) as typeof import('../apps/server/src/config/server.js');
const root = mkdtempSync(join(tmpdir(), `tmc-teaching-browser-${mode}-`));
const data = openDataDirectory(root), learning = new Learning(data.db);
const projects = new Projects(root), terminals = new Terminals((space) => projects.root(space));
const actions = new Actions(learning, projects);
const executions = new Executions(learning);
const agents = new TeachingRuntime(learning, syntheticSource, { stream: agentTransport, projectDirectory: (space) => projects.root(space), actions, executions,
  // Small retained tails let the browser exercise native compaction with short,
  // readable fixtures. Production keeps Pi's default 20,000 recent tokens.
  compaction: { keepRecentTokens: 64 },
  webFetch: {
    lookup: async (hostname) => { if (hostname !== 'docs.example.org') throw new Error('Unexpected fixture host'); return [{ address: '8.8.8.8', family: 4 }]; },
    fetch: async (url) => {
      if (url.href !== 'https://docs.example.org/cedar/4.7.2') throw new Error('Unexpected fixture URL');
      return new Response('Cedar is a streaming parser toolkit.\nVersion 4.7.2 requires Node 24.\nFULL-PAGE-ONLY: irrelevant text is not saved.',
        { headers: { 'content-type': 'text/plain' } });
    },
  },
});
const config = serverConfig({ NODE_ENV: mode, PORT: mode === 'production' ? '14320' : '14321', TMC_WEB_PORT: '15173' });
const access = createLocalAccess(config);
const server = serve({ hostname: config.hostname, port: config.port, fetch: createApp(access, learning, projects, agents).fetch });
server.on('upgrade', terminalUpgradeGate(access, terminals, (space) => learning.space(space)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void Promise.all([agents.close(), terminals.close(), actions.close(), executions.close()]).finally(() => server.close(() => { data.close(); rmSync(root, { recursive: true, force: true }); }));
});

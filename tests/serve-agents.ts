import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../apps/server/node_modules/@hono/node-server/dist/index.mjs';
import { syntheticConfig } from '../apps/server/src/agents/test-support.js';
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
const { createLocalAccess } = await import(`../apps/server/${directory}/http/local-access.js`) as typeof import('../apps/server/src/http/local-access.js');
const { serverConfig } = await import(`../apps/server/${directory}/config/server.js`) as typeof import('../apps/server/src/config/server.js');
const root = mkdtempSync(join(tmpdir(), `tmc-teaching-browser-${mode}-`));
const data = openDataDirectory(root), learning = new Learning(data.db);
const agents = new TeachingRuntime(learning, syntheticConfig, { stream: agentTransport });
const config = serverConfig({ NODE_ENV: mode, PORT: mode === 'production' ? '14320' : '14321', TMC_WEB_PORT: '15173' });
const server = serve({ hostname: config.hostname, port: config.port, fetch: createApp(createLocalAccess(config), learning, new Projects(root), agents).fetch });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void agents.close().finally(() => server.close(() => { data.close(); rmSync(root, { recursive: true, force: true }); }));
});

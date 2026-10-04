import { serve } from '@hono/node-server';
import { serverConfig } from './config/server.js';
import { createApp } from './http/app.js';
import { createLocalAccess, terminalUpgradeGate } from './http/local-access.js';
import { dataDirectory, openDataDirectory } from './storage/data-directory.js';
import { Learning } from './modules/learning.js';
import { Projects } from './modules/projects.js';
import { defaultModel, serverEnvironment } from './config/model.js';
import { FileCredentialStore } from './models/credentials.js';
import { ModelService } from './models/service.js';
import { TeachingRuntime } from './agents/runtime.js';
import { join } from 'node:path';
import { Terminals } from './runtime/terminals.js';
import { Actions } from './modules/actions.js';
import { Executions } from './modules/executions.js';

try {
  const config = serverConfig();
  const { port, hostname } = config;
  const data = openDataDirectory(dataDirectory());
  const access = createLocalAccess(config);
  const env = serverEnvironment();
  let models: ModelService | null = null;
  try {
    models = new ModelService(data.db, { env, credentials: new FileCredentialStore(join(data.root, 'credentials.json')), fallback: defaultModel(env) });
    await models.refresh();
  } catch { /* Missing or unreadable model configuration must not block saved learning data. */ }
  const learning = new Learning(data.db);
  const projects = new Projects(data.root);
  const terminals = new Terminals((space) => projects.root(space));
  const actions = new Actions(learning, projects);
  const executions = new Executions(learning);
  const agents = new TeachingRuntime(learning, models, {
    actions, executions,
    projectDirectory: (space) => projects.root(space),
    debugDirectory: process.env.TMC_AGENT_DEBUG_SNAPSHOTS === '1' ? join(data.root, 'agent-debug') : undefined,
  });
  const server = serve({ fetch: createApp(access, learning, projects, agents, models ?? undefined).fetch, hostname, port }, () => {
    console.log(`TeachMeCoding listening on http://${hostname}:${port}`);
    if (hostname === '0.0.0.0') console.warn('Network access enabled without login. Use only on a trusted network.');
  });
  server.on('upgrade', terminalUpgradeGate(access, terminals, (space) => learning.space(space)));
  const close = () => Promise.all([agents.close(), terminals.close(), actions.close(), executions.close()]).then(() => models?.close());
  server.on('error', () => {
    void close().finally(() => data.close());
    console.error('Cannot start local server. Check whether PORT is already in use.');
    process.exitCode = 1;
  });
  server.on('close', () => { void close().finally(() => data.close()); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().finally(() => server.close()); });
} catch (error) {
  console.error('Cannot open local data. Check TMC_DATA_DIR, directory permissions and database version.');
  if (error instanceof Error && (error.message.startsWith('Database ') || error.message.startsWith('Data ') || error.message.startsWith('TMC_DATA_DIR') || error.message.startsWith('TMC_PREVIEW_ORIGIN'))) console.error(error.message);
  process.exitCode = 1;
}

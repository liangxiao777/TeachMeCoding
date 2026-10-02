import { serve } from '@hono/node-server';
import { serverConfig } from './config/server.js';
import { createApp } from './http/app.js';
import { createLocalAccess, terminalUpgradeGate } from './http/local-access.js';
import { dataDirectory, openDataDirectory } from './storage/data-directory.js';
import { Learning } from './modules/learning.js';
import { Projects } from './modules/projects.js';

try {
  const config = serverConfig();
  const { port, hostname } = config;
  const data = openDataDirectory(dataDirectory());
  const access = createLocalAccess(config);
  const server = serve({ fetch: createApp(access, new Learning(data.db), new Projects(data.root)).fetch, hostname, port }, () => {
    console.log(`TeachMeCoding listening on http://127.0.0.1:${port}`);
  });
  server.on('upgrade', terminalUpgradeGate(access));
  server.on('error', () => {
    data.close();
    console.error('Cannot start local server. Check whether PORT is already in use.');
    process.exitCode = 1;
  });
  server.on('close', () => data.close());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
} catch (error) {
  console.error('Cannot open local data. Check TMC_DATA_DIR, directory permissions and database version.');
  if (error instanceof Error && (error.message.startsWith('Database ') || error.message.startsWith('Data ') || error.message.startsWith('TMC_DATA_DIR'))) console.error(error.message);
  process.exitCode = 1;
}

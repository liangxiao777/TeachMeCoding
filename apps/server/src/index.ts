import { serve } from '@hono/node-server';
import { serverConfig } from './config/server.js';
import { createApp } from './http/app.js';
import { createLocalAccess, terminalUpgradeGate } from './http/local-access.js';

const config = serverConfig();
const { port, hostname } = config;
const access = createLocalAccess(config);
const server = serve({ fetch: createApp(access).fetch, hostname, port }, () => {
  console.log(`TeachMeCoding listening on http://127.0.0.1:${port}`);
});
server.on('upgrade', terminalUpgradeGate(access));
server.on('error', () => {
  console.error('Cannot start local server. Check whether PORT is already in use.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
  });
}

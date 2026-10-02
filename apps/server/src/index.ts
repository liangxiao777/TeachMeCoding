import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const server = serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port }, () => {
  console.log(`TeachMeCoding listening on http://127.0.0.1:${port}`);
});
server.on('error', () => {
  console.error('Cannot start local server. Check whether PORT is already in use.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
  });
}

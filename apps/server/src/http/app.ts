import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { HealthResponse } from '@teach-me-coding/contracts';

// Source and compiled modules have the same depth relative to apps/web.
export const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export function createApp() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({
    status: 'ok', service: 'teach-me-coding',
  } satisfies HealthResponse));
  app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use('*', serveStatic({ root: webRoot }));
  app.get('*', async (c) => {
    // Missing assets are errors, not successful HTML responses.
    if (c.req.path.split('/').at(-1)?.includes('.')) return c.notFound();
    try {
      return c.html(await readFile(`${webRoot}index.html`, 'utf8'));
    } catch {
      return c.text('Web build missing. Run pnpm build first.', 503);
    }
  });
  return app;
}

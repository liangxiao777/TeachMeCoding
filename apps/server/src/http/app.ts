import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { HealthResponse } from '@teach-me-coding/contracts';
import { localAccessError, type LocalAccess } from './local-access.js';
import { workspaceApi } from './workspaces.js';
import type { Learning } from '../modules/learning.js';

// Source and compiled modules have the same depth relative to apps/web.
export const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export function createApp(access: LocalAccess, learning?: Learning) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const api = c.req.path === '/api' || c.req.path.startsWith('/api/');
    if (api) c.header('Cache-Control', 'no-store');
    const publicRead = ['GET', 'HEAD'].includes(c.req.method) && ['/api/health', '/api/access'].includes(c.req.path);
    const error = localAccessError(c.req.raw.headers, access, { requireToken: api && !publicRead });
    if (error) return c.json({ error: error === 401 ? 'Request token required' : 'Local access denied' }, error);
    await next();
  });
  app.get('/api/health', (c) => c.json({
    status: 'ok', service: 'teach-me-coding',
  } satisfies HealthResponse));
  app.get('/api/access', (c) => {
    // A cross-origin browser cannot add this header without a CORS preflight,
    // which is denied. Same-origin fetches need not carry an Origin header.
    if (c.req.header('X-TMC-Client') !== 'browser') return c.json({ error: 'Local client header required' }, 403);
    return c.json({ token: access.token });
  });
  app.post('/api/access/check', (c) => c.json({ ok: true }));
  if (learning) app.route('/api', workspaceApi(learning));
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

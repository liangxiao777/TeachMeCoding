import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { previewFrameAncestors, type HealthResponse } from '@teach-me-coding/contracts';
import { localAccessError, type LocalAccess } from './local-access.js';
import { settingsApi } from './settings.js';
import { workspaceApi } from './workspaces.js';
import type { Learning } from '../modules/learning.js';
import type { Projects } from '../modules/projects.js';
import type { ModelService } from '../models/service.js';
import type { TeachingRuntime } from '../agents/runtime.js';
import type { McpService } from '../extensions/mcp.js';
import type { SkillService } from '../extensions/skills.js';
import type { SearchService } from '../extensions/search.js';
import type { Library } from '../modules/library.js';
import { libraryApi } from './library.js';

// Source and compiled modules have the same depth relative to apps/web.
export const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export function createApp(access: LocalAccess, learning?: Learning, projects?: Projects, agents?: TeachingRuntime, models?: ModelService, mcp?: McpService, skills?: SkillService, search?: SearchService, library?: Library) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    if (!access.previewOrigin) c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    // xterm's DOM renderer generates cell/color styles. Script execution stays
    // same-origin; only styles need the inline allowance.
    c.header('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors ${previewFrameAncestors(access.previewOrigin)}; base-uri 'none'; form-action 'none'`);
    const api = c.req.path === '/api' || c.req.path.startsWith('/api/');
    if (api) c.header('Cache-Control', 'no-store');
    const publicRead = ['GET', 'HEAD'].includes(c.req.method) && ['/api/health', '/api/access'].includes(c.req.path);
    const error = localAccessError(c.req.raw.headers, access, {
      requireToken: api && !publicRead,
      documentNavigation: !api && ['GET', 'HEAD'].includes(c.req.method),
    });
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
  if (models || mcp || skills || search) app.route('/api', settingsApi(models, mcp, skills, search));
  if (learning || library) app.route('/api', libraryApi(library));
  if (learning) app.route('/api', workspaceApi(learning, projects, agents));
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

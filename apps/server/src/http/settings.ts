import { Hono } from 'hono';
import { BusinessError } from '../modules/learning.js';
import type { ModelService } from '../models/service.js';
import type { McpService } from '../extensions/mcp.js';
import type { SkillService } from '../extensions/skills.js';

export function settingsApi(models?: ModelService, mcp?: McpService, skills?: SkillService) {
  const api = new Hono();
  api.onError((error, c) => {
    if (error instanceof BusinessError) return c.json({ error: error.message }, error.status);
    if (error.name === 'ZodError' || error instanceof SyntaxError) return c.json({ error: '请求格式或字段无效。' }, 400);
    return c.json({ error: '无法保存或读取设置，请检查数据目录权限和配置文件。' }, 503);
  });
  api.use('/settings/*', async (c, next) => {
    const path = c.req.path;
    if (path.startsWith('/api/settings/mcp') && !mcp || path.startsWith('/api/settings/skills') && !skills
      || !path.startsWith('/api/settings/mcp') && !path.startsWith('/api/settings/skills') && !models) {
      throw new BusinessError(503, '无法读取这类设置，请检查数据目录中的配置文件。');
    }
    await next();
  });
  api.get('/settings/mcp', (c) => c.json(mcp!.settings()));
  api.post('/settings/mcp', async (c) => c.json(await mcp!.save(await c.req.json())));
  api.post('/settings/mcp/reconnect', async (c) => c.json(await mcp!.reconnect()));
  api.post('/settings/mcp/servers', async (c) => c.json(await mcp!.saveServer(await c.req.json()), 201));
  api.post('/settings/mcp/servers/:server', async (c) => c.json(await mcp!.saveServer(await c.req.json(), c.req.param('server'))));
  api.post('/settings/mcp/servers/:server/delete', async (c) => c.json(await mcp!.removeServer(c.req.param('server'))));
  api.post('/settings/mcp/servers/:server/reconnect', async (c) => c.json(await mcp!.reconnect(c.req.param('server'))));
  api.get('/settings/skills', (c) => c.json(skills!.settings()));
  api.post('/settings/skills', async (c) => c.json(skills!.save(await c.req.json())));
  api.post('/settings/skills/reload', (c) => c.json(skills!.reload()));
  if (!models) return api;
  api.get('/settings/model', async (c) => c.json(await models.settings()));
  api.get('/settings/providers/:provider/models', (c) => c.json(models.modelsOf(c.req.param('provider'))));
  api.post('/settings/model', async (c) => c.json(await models.select(await c.req.json())));
  api.post('/settings/providers/:provider/login', async (c) => c.json(models.login(c.req.param('provider'), await c.req.json()), 201));
  api.get('/settings/login/:session', (c) => c.json(models.getLogin(c.req.param('session'))));
  api.post('/settings/login/:session/answer', async (c) => c.json(models.answerLogin(c.req.param('session'), await c.req.json())));
  api.post('/settings/login/:session/cancel', (c) => c.json(models.cancelLogin(c.req.param('session'))));
  api.post('/settings/providers/:provider/logout', async (c) => c.json(await models.logout(c.req.param('provider'))));
  return api;
}

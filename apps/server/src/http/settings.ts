import { Hono } from 'hono';
import { BusinessError } from '../modules/learning.js';
import type { ModelService } from '../models/service.js';

export function settingsApi(models: ModelService) {
  const api = new Hono();
  api.onError((error, c) => {
    if (error instanceof BusinessError) return c.json({ error: error.message }, error.status);
    if (error.name === 'ZodError' || error instanceof SyntaxError) return c.json({ error: '请求格式或字段无效。' }, 400);
    return c.json({ error: '无法保存或读取模型设置，请检查数据目录权限和可用空间。' }, 503);
  });
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

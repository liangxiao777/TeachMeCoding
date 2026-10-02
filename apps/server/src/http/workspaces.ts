import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BusinessError, type Learning } from '../modules/learning.js';

export function workspaceApi(learning: Learning) {
  const api = new Hono();
  api.use('*', bodyLimit({ maxSize: 1_100_000, onError: (c) => c.json({ error: '请求内容过大。' }, 413) }));
  api.onError((error, c) => {
    if (error instanceof BusinessError) return c.json({ error: error.message }, error.status);
    if (error.name === 'ZodError' || error instanceof SyntaxError) return c.json({ error: '请求格式或字段无效。' }, 400);
    return c.json({ error: '无法保存或读取本地数据，请检查数据目录权限和可用空间。' }, 503);
  });
  api.get('/spaces', (c) => c.json(learning.list()));
  api.get('/spaces/:space', (c) => c.json(learning.space(c.req.param('space'))));
  api.get('/spaces/:space/sessions/:session', (c) => c.json(learning.session(c.req.param('space'), c.req.param('session'))));
  api.get('/spaces/:space/units/:unit', (c) => c.json(learning.unit(c.req.param('space'), c.req.param('unit'))));
  api.get('/spaces/:space/records/:record', (c) => c.json(learning.record(c.req.param('space'), c.req.param('record'))));
  api.post('/spaces', async (c) => {
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => learning.create(input)));
  });
  api.post('/spaces/:space/:action', async (c) => {
    const space = c.req.param('space');
    const action = c.req.param('action');
    if (!['requirement', 'sessions'].includes(action)) return c.json({ error: 'Not found' }, 404);
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () =>
      action === 'requirement' ? learning.saveRequirement(space, input) : learning.createSession(space, input)));
  });
  api.post('/spaces/:space/sessions/:session/:action', async (c) => {
    const { space, session, action } = c.req.param();
    if (!['draft', 'messages'].includes(action)) return c.json({ error: 'Not found' }, 404);
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () =>
      action === 'draft' ? learning.saveSessionDraft(space, session, input) : learning.addMessage(space, session, input)));
  });
  api.post('/spaces/:space/units/:unit/draft', async (c) => {
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () =>
      learning.saveAssessmentDraft(c.req.param('space'), c.req.param('unit'), input)));
  });
  api.post('/spaces/:space/proposals/:proposal/apply', (c) => c.json(learning.once(
    c.req.header('Idempotency-Key') ?? '', c.req.path, null, () => learning.applyProposal(c.req.param('space'), c.req.param('proposal')))));
  return api;
}

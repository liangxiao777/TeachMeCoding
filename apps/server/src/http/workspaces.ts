import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { createSpaceSchema, researchRefSchema } from '@teach-me-coding/contracts';
import { z } from 'zod';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { Projects } from '../modules/projects.js';
import { TeachingRuntime } from '../agents/runtime.js';

export function workspaceApi(learning: Learning, projects?: Projects, agents?: TeachingRuntime) {
  const api = new Hono();
  const decisions = agents ?? new TeachingRuntime(learning, null);
  api.use('*', bodyLimit({ maxSize: 1_100_000, onError: (c) => c.json({ error: '请求内容过大。' }, 413) }));
  api.onError((error, c) => {
    if (error instanceof BusinessError) return c.json({ error: error.message }, error.status);
    if (error.name === 'ZodError' || error instanceof SyntaxError) return c.json({ error: '请求格式或字段无效。' }, 400);
    return c.json({ error: '无法保存或读取本地数据，请检查数据目录权限和可用空间。' }, 503);
  });
  api.get('/spaces', (c) => c.json(learning.list()));
  api.get('/spaces/:space', (c) => c.json(learning.space(c.req.param('space'))));
  api.get('/spaces/:space/research/:id/:revision', (c) => {
    const ref = researchRefSchema.parse({ id: c.req.param('id'), revision: Number(c.req.param('revision')) });
    learning.space(c.req.param('space'));
    const dossier = learning.intake.research(c.req.param('space'), ref);
    return c.req.query('format') === 'markdown' ? c.text(dossier.content, 200,
      { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="research-${ref.id}-v${ref.revision}.md"` }) : c.json(dossier);
  });
  api.post('/spaces/:space/research/:id/:revision', async (c) => {
    const ref = researchRefSchema.parse({ id: c.req.param('id'), revision: Number(c.req.param('revision')) });
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input,
      () => learning.saveResearch(c.req.param('space'), ref, input)));
  });
  api.get('/spaces/:space/sessions/:session', (c) => c.json(learning.session(c.req.param('space'), c.req.param('session'))));
  api.get('/spaces/:space/units/:unit', (c) => c.json(learning.unit(c.req.param('space'), c.req.param('unit'))));
  api.get('/spaces/:space/records/:record', (c) => c.json(learning.record(c.req.param('space'), c.req.param('record'))));
  api.get('/capabilities', (c) => c.json({ agent: agents?.available ?? false, terminal: !!projects, assessment: agents?.available ?? false }));
  api.get('/spaces/:space/sessions/:session/actions', (c) => {
    learning.session(c.req.param('space'), c.req.param('session'));
    return c.json(agents?.actions?.list(c.req.param('space'), c.req.param('session')) ?? []);
  });
  api.post('/spaces/:space/actions/:action', async (c) => {
    if (!agents?.actions) throw new BusinessError(503, '本机确认执行不可用。');
    return c.json(agents.actions.decide(c.req.param('space'), c.req.param('action'), await c.req.json()));
  });
  api.get('/spaces/:space/units/:unit/executions', (c) => {
    learning.unit(c.req.param('space'), c.req.param('unit'));
    return c.json(agents?.executions?.list(c.req.param('space'), c.req.param('unit')) ?? []);
  });
  api.post('/spaces/:space/units/:unit/executions', async (c) => {
    if (!agents?.executions) throw new BusinessError(503, '本机执行不可用。');
    const { space, unit } = c.req.param(), input: unknown = await c.req.json();
    const e = learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => agents.executions!.create(space, unit, input));
    void agents.executions.run(space, e.id).catch(() => { console.error('Cannot persist local execution result. Check data directory permissions and available space.'); });
    return c.json(agents.executions.get(space, e.id));
  });
  api.post('/spaces/:space/executions/:execution/stop', (c) => {
    if (!agents?.executions) throw new BusinessError(503, '本机执行不可用。');
    return c.json(agents.executions.stop(c.req.param('space'), c.req.param('execution')));
  });
  if (agents) {
    api.post('/spaces/:space/plan', async (c) => c.json(agents.plan(c.req.param('space'), c.req.header('Idempotency-Key') ?? '', await c.req.json())));
    api.post('/spaces/:space/sessions/:session/questions/:round/answer', async (c) => c.json(agents.answer(
      c.req.param('space'), c.req.param('session'), c.req.param('round'), c.req.header('Idempotency-Key') ?? '', await c.req.json())));
    api.post('/spaces/:space/tasks/:task/retry', (c) => c.json(agents.retryTask(c.req.param('space'), c.req.param('task'), c.req.header('Idempotency-Key') ?? '')));
    api.post('/spaces/:space/units/:unit/tasks', async (c) => c.json(agents.generate(
      c.req.param('space'), c.req.param('unit'), c.req.header('Idempotency-Key') ?? '', await c.req.json())));
    api.post('/spaces/:space/sessions/:session/runs', async (c) => c.json(agents.submit(
      c.req.param('space'), c.req.param('session'), c.req.header('Idempotency-Key') ?? '', await c.req.json())));
    api.get('/spaces/:space/runs/:run', (c) => c.json(agents.get(c.req.param('space'), c.req.param('run'))));
    api.get('/spaces/:space/runs/:run/events', (c) => c.json(agents.events(c.req.param('space'), c.req.param('run'), Number(c.req.query('after') ?? 0))));
    api.post('/spaces/:space/runs/:run/stop', (c) => c.json(agents.stop(c.req.param('space'), c.req.param('run'))));
    api.post('/spaces/:space/runs/:run/retry', (c) => c.json(agents.retry(c.req.param('space'), c.req.param('run'), c.req.header('Idempotency-Key') ?? '')));
    api.get('/spaces/:space/runs/:run/stream', (c) => {
      const { space, run } = c.req.param();
      let cursor = Number(c.req.query('after') ?? 0);
      agents.events(space, run, cursor); // Validate before starting a successful stream response.
      return streamSSE(c, async (stream) => {
        let heartbeat = Date.now();
        while (!stream.aborted) {
          const result = agents.events(space, run, cursor);
          for (const event of result.events) {
            await stream.writeSSE({ id: `${run}:${event.seq}`, event: 'run', data: JSON.stringify(event) });
            cursor = event.seq;
          }
          if (!['pending', 'running'].includes(result.run.state) && result.events.length < 500) return;
          if (Date.now() - heartbeat >= 5000) {
            await stream.write(': keep-alive\n\n'); // Connection health, never model progress.
            heartbeat = Date.now();
          }
          await stream.sleep(100);
        }
      }); // Subscription cancellation never calls agents.stop().
    });
  }
  api.post('/spaces', async (c) => {
    const input: unknown = await c.req.json();
    const key = c.req.header('Idempotency-Key') ?? '';
    if (agents) return c.json(agents.createSpace(key, input));
    return c.json(learning.once(key, c.req.path, input, () => {
      const value = createSpaceSchema.parse(input), space = learning.create(value);
      const session = space.sessions.find((s) => s.scope === 'intake')!;
      learning.addMessage(space.id, session.id, { text: value.goal, quote: null, draftRevision: 0 });
      return space;
    }));
  });
  api.post('/spaces/:space/:action', async (c) => {
    const space = c.req.param('space');
    const action = c.req.param('action');
    if (!['name', 'requirement', 'sessions'].includes(action)) return c.json({ error: 'Not found' }, 404);
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () =>
      action === 'name' ? learning.renameSpace(space, input) :
        action === 'requirement' ? learning.saveRequirement(space, input) : learning.createSession(space, input)));
  });
  api.post('/spaces/:space/sessions/:session/:action', async (c) => {
    const { space, session, action } = c.req.param();
    if (!['draft', 'messages', 'settings'].includes(action)) return c.json({ error: 'Not found' }, 404);
    const input: unknown = await c.req.json();
    if (action === 'settings') {
      learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => learning.saveSessionSettings(space, session, input));
      await decisions.approveSession(space, session);
      return c.json(learning.session(space, session));
    }
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => {
      if (action === 'messages') return learning.addMessage(space, session, input);
      learning.assertAgentInputAllowed(space);
      const target = learning.session(space, session);
      if (target.unitId) learning.assertUnitUnlocked(space, target.unitId);
      return learning.saveSessionDraft(space, session, input);
    }));
  });
  api.post('/spaces/:space/units/:unit/draft', async (c) => {
    const { space, unit } = c.req.param(), input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => {
      learning.assertUnitUnlocked(space, unit);
      return learning.saveAssessmentDraft(space, unit, input);
    }));
  });
  api.post('/spaces/:space/proposals/:proposal/apply', (c) => c.json(learning.once(
    c.req.header('Idempotency-Key') ?? '', c.req.path, null, () => learning.applyProposal(c.req.param('space'), c.req.param('proposal')))));
  api.post('/spaces/:space/proposals/:proposal/reject', async (c) => {
    const { space, proposal } = c.req.param(), input: unknown = await c.req.json(), key = c.req.header('Idempotency-Key') ?? '';
    // Decision recording remains available even when no teaching model is configured.
    return c.json(decisions.rejectProposal(space, proposal, key, input));
  });
  api.post('/spaces/:space/lesson-proposals/:proposal/apply', async (c) => {
    const { space, proposal } = c.req.param(), input = z.object({}).strict().parse(await c.req.json());
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => learning.applyLessonProposal(space, proposal)));
  });
  api.post('/spaces/:space/lesson-proposals/:proposal/reject', async (c) => {
    const { space, proposal } = c.req.param();
    return c.json(decisions.rejectLessonProposal(space, proposal, c.req.header('Idempotency-Key') ?? '', await c.req.json()));
  });
  api.post('/spaces/:space/conclusions/:conclusion', async (c) => {
    const input: unknown = await c.req.json();
    return c.json(learning.once(c.req.header('Idempotency-Key') ?? '', c.req.path, input, () => learning.decideConclusion(c.req.param('space'), c.req.param('conclusion'), input)));
  });
  if (projects) {
    api.use('/spaces/:space/project/*', async (c, next) => { learning.space(c.req.param('space')); await next(); });
    api.get('/spaces/:space/project/tree', (c) => c.json(projects.tree(c.req.param('space'))));
    api.get('/spaces/:space/project/file', (c) => c.json(projects.read(c.req.param('space'), c.req.query('path') ?? '')));
    api.post('/spaces/:space/project/:action', async (c) => {
      const input: unknown = await c.req.json();
      const space = c.req.param('space');
      switch (c.req.param('action')) {
        case 'create': return c.json(projects.create(space, input));
        case 'save': return c.json(projects.save(space, input));
        case 'rename': return c.json(projects.rename(space, input));
        default: return c.json({ error: 'Not found' }, 404);
      }
    });
  }
  return api;
}

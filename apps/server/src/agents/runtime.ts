import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext, type Message } from '@earendil-works/pi-ai';
import { createSpaceSchema, generationInputSchema, idSchema, messageInputSchema, saveRequirementSchema, type AgentEventData, type AgentRun, type RunEvents, type RunSubmission } from '@teach-me-coding/contracts';
import type { ModelConfig } from '../config/model.js';
import { BusinessError, Learning } from '../modules/learning.js';
import { budget, compileRequest, retainedMessage, xmlText, type FrozenContext, type HistoryGroup } from './context.js';
import { failureStream, providerStream, teachingModel } from './model.js';
import { createScenario } from './scenarios.js';
import { createTask } from './tasks.js';
import { Assessments } from '../modules/assessments.js';
import { sealToolCalls } from '../storage/agent-messages.js';

export interface ScenarioRun { tools: AgentTool[]; commit: () => void }
interface RuntimeOptions {
  stream?: StreamFn;
  scenario?: (input: FrozenContext) => ScenarioRun;
  milliseconds?: number;
  debugDirectory?: string;
  projectDirectory?: (space: string) => string;
}
const active = (run: AgentRun) => run.state === 'running' || run.state === 'pending';
export class TeachingRuntime {
  private live = new Map<string, { space: string; agent?: Agent; done: Promise<void> }>();
  private closing = false;
  private stream: StreamFn;
  constructor(readonly learning: Learning, private config: ModelConfig | null, private options: RuntimeOptions = {}) {
    this.stream = options.stream ?? providerStream();
  }
  get available() { return this.config !== null && this.config.model === teachingModel.id; }

  private tables(space: string, id: string) {
    return this.learning.db.prepare('SELECT 1 FROM task_runs WHERE space_id=? AND id=?').get(space, id)
      ? { work: 'tasks', run: 'task_runs', events: 'task_events', messages: 'task_messages', manifests: 'task_manifests' }
      : { work: 'runs', run: 'agent_runs', events: 'agent_events', messages: 'agent_messages', manifests: 'context_manifests' };
  }
  get(space: string, id: string): AgentRun {
    idSchema.parse(space); idSchema.parse(id);
    const tables = this.tables(space, id);
    const row = this.learning.db.prepare(`SELECT r.id,r.unit_id AS unitId,r.session_id AS sessionId,r.kind,r.state,
      a.error,a.cancelled,a.created_at AS createdAt,json_extract(a.input,'$.evaluation.submission.id') AS resultId FROM ${tables.work} r JOIN ${tables.run} a ON a.space_id=r.space_id AND a.id=r.id
      WHERE r.space_id=? AND r.id=?`).get(space, id) as (Omit<AgentRun, 'cancelled'> & { cancelled: number }) | undefined;
    if (!row) throw new BusinessError(404, '运行不存在。');
    return { ...row, cancelled: !!row.cancelled };
  }
  events(space: string, id: string, after = 0): RunEvents {
    const run = this.get(space, id);
    if (!Number.isSafeInteger(after) || after < 0) throw new BusinessError(400, '事件游标无效。');
    const rows = this.learning.db.prepare(`SELECT seq,value FROM ${this.tables(space, id).events} WHERE space_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT 500`)
      .all(space, id, after) as { seq: number; value: string }[];
    return { run, events: rows.map((r) => ({ runId: id, seq: r.seq, data: JSON.parse(r.value) as AgentEventData })) };
  }
  private emit(space: string, id: string, data: AgentEventData) {
    const table = this.tables(space, id).events;
    this.learning.db.prepare(`INSERT INTO ${table} SELECT ?,?,COALESCE(MAX(seq),0)+1,? FROM ${table} WHERE space_id=? AND run_id=?`)
      .run(space, id, JSON.stringify(data), space, id);
  }
  private freeze(space: string, session: string, references: FrozenContext['references']): FrozenContext {
    const s = this.learning.session(space, session), w = this.learning.space(space);
    if (s.scope !== 'intake' && !w.requirement.confirmed) throw new BusinessError(422, '请先确认学习需求。');
    return structuredClone({ spaceId: space, sessionId: session, unitId: s.unitId,
      scenario: s.scope === 'route' ? 'roadmap' : s.scope === 'unit' ? 'tutor' : 'intake',
      requirement: w.requirement, route: s.scope === 'intake' ? null : w.route,
      unit: w.route.content?.stages.flatMap((stage) => stage.units).find((unit) => unit.id === s.unitId) ?? null,
      lesson: s.unitId ? this.learning.unit(space, s.unitId).lesson : null, references,
      conclusions: s.scope === 'intake' ? [] : w.conclusions.filter((c) => c.adopted && c.valid),
      evidence: s.scope === 'intake' ? [] : this.evidence(space),
      publicAssessment: s.unitId ? this.learning.unit(space, s.unitId).assessment : null,
    });
  }
  private evidence(space: string) {
    return this.learning.space(space).route.content?.stages.flatMap((s) => s.units).flatMap((u) => this.learning.unit(space, u.id).records.filter((r) => r.valid)) ?? [];
  }
  generate(space: string, unit: string, key: string, raw: unknown): AgentRun {
    const input = generationInputSchema.parse(raw);
    if (this.closing || !this.available) throw new BusinessError(503, '教学模型不可用。');
    const id = this.learning.once(key, `task:${space}:${unit}`, input, () => {
      const w = this.learning.space(space), u = this.learning.unit(space, unit);
      const revision = input.kind === 'lesson' ? u.lesson?.revision ?? 0 : input.kind === 'assessment' ? u.assessment?.revision ?? 0 : u.draft.revision;
      if (!w.requirement.confirmed || revision !== input.revision) throw new BusinessError(409, '任务基线已改变，请刷新后重试。');
      if (input.kind !== 'lesson' && !u.lesson) throw new BusinessError(422, '请先生成课件。');
      if (this.learning.db.prepare("SELECT 1 FROM tasks WHERE space_id=? AND unit_id=? AND kind=? AND state IN ('pending','running')").get(space, unit, input.kind)) throw new BusinessError(409, '当前单元已有相同生成任务。');
      const frozen: FrozenContext = { spaceId: space, sessionId: null, unitId: unit, scenario: input.kind,
        requirement: w.requirement, route: w.route, unit: w.route.content!.stages.flatMap((s) => s.units).find((u) => u.id === unit)!,
        lesson: u.lesson, references: [], conclusions: w.conclusions.filter((c) => c.adopted && c.valid), evidence: this.evidence(space),
        assessmentRevision: u.assessment?.revision ?? 0,
        ...(input.kind === 'evaluation' ? { evaluation: new Assessments(this.learning).submit(space, unit, input) } : {}) };
      const id = randomUUID();
      this.learning.db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,?,'pending')").run(space, id, unit, input.kind);
      this.learning.db.prepare('INSERT INTO task_runs(space_id,id,input,created_at) VALUES (?,?,?,?)').run(space, id, JSON.stringify(frozen), Date.now());
      this.emit(space, id, { type: 'state', state: 'pending', error: null });
      return id;
    });
    this.launch(space, id, '完成本次独立任务，并通过当前任务工具提交结构化产物。');
    return this.get(space, id);
  }
  retryTask(space: string, previousId: string, key: string): AgentRun {
    const previous = this.get(space, previousId);
    if (previous.sessionId || !['failed', 'interrupted'].includes(previous.state)) throw new BusinessError(409, '只能重试失败或中断的独立任务。');
    if (this.closing || !this.available) throw new BusinessError(503, '教学模型不可用。');
    const id = this.learning.once(key, `retry-task:${space}:${previousId}`, null, () => {
      if (this.learning.db.prepare("SELECT 1 FROM tasks WHERE space_id=? AND unit_id=? AND kind=? AND state IN ('pending','running')").get(space, previous.unitId, previous.kind)) throw new BusinessError(409, '当前单元已有相同任务。');
      const old = this.learning.db.prepare('SELECT input FROM task_runs WHERE space_id=? AND id=?').get(space, previousId) as { input: string };
      const id = randomUUID();
      this.learning.db.prepare("INSERT INTO tasks VALUES (?,?,?,NULL,?,'pending')").run(space, id, previous.unitId, previous.kind);
      this.learning.db.prepare('INSERT INTO task_runs(space_id,id,input,created_at) VALUES (?,?,?,?)').run(space, id, old.input, Date.now());
      this.emit(space, id, { type: 'state', state: 'pending', error: null });
      return id;
    });
    this.launch(space, id, '重试固定输入的独立任务，并提交结构化产物。');
    return this.get(space, id);
  }
  createSpace(key: string, raw: unknown) {
    const input = createSpaceSchema.parse(raw);
    if (this.closing) throw new BusinessError(503, '服务正在关闭。');
    const created = this.learning.once(key, '/api/spaces', raw, () => {
      const space = this.learning.create(input), session = space.sessions.find((s) => s.scope === 'intake')!;
      const message = { text: input.goal, quote: null, draftRevision: 0 };
      if (this.available) this.recordRun(space.id, session.id, message);
      else this.learning.addMessage(space.id, session.id, message);
      return this.learning.space(space.id);
    });
    // Start only after creation, the opening message and the run commit atomically.
    for (const run of created.runs) this.launch(created.id, run.id, input.goal);
    return created;
  }
  plan(space: string, key: string, raw: unknown): RunSubmission {
    const input = saveRequirementSchema.parse(raw);
    if (this.closing || !this.available) throw new BusinessError(503, '教学模型不可用。');
    const text = '请根据已确认需求生成完整学习路线，调用路线工具提交阶段、单元及安排说明。';
    const id = this.learning.once(key, `plan:${space}`, input, () => {
      this.learning.saveRequirement(space, { ...input, confirmed: true });
      const session = this.learning.space(space).sessions.find((s) => s.scope === 'route')!;
      return this.recordRun(space, session.id, { text, quote: null, draftRevision: this.learning.session(space, session.id).draft.revision });
    });
    this.launch(space, id, text);
    const run = this.get(space, id);
    return { run, session: this.learning.session(space, run.sessionId!) };
  }
  submit(space: string, session: string, key: string, raw: unknown): RunSubmission {
    return this.begin(space, session, key, raw);
  }
  retry(space: string, id: string, key: string): RunSubmission {
    const previous = this.get(space, id);
    if (!previous.sessionId || !['failed', 'interrupted'].includes(previous.state)) throw new BusinessError(409, '只能重试失败或中断的会话运行。');
    const original = this.learning.db.prepare('SELECT input FROM agent_runs WHERE space_id=? AND id=?').get(space, id) as { input: string };
    const { submitted } = JSON.parse(original.input) as { submitted: unknown };
    return this.begin(space, previous.sessionId!, key, submitted, id);
  }
  private begin(space: string, session: string, key: string, raw: unknown, retryOf?: string): RunSubmission {
    const input = messageInputSchema.parse(raw);
    if (this.closing) throw new BusinessError(503, '服务正在关闭。');
    if (!this.available) throw new BusinessError(503, '教学模型未配置或模型不匹配；请检查服务端配置。');
    const id = this.learning.once(key, `agent:${space}:${session}:${retryOf ?? ''}`, input, () => this.recordRun(space, session, input, retryOf));
    this.launch(space, id, input.text);
    return { run: this.get(space, id), session: this.learning.session(space, session) };
  }
  private recordRun(space: string, session: string, input: ReturnType<typeof messageInputSchema.parse>, retryOf?: string) {
    const frozen = this.freeze(space, session, input.quote ? [input.quote] : []);
    if (this.learning.db.prepare("SELECT 1 FROM runs WHERE space_id=? AND session_id=? AND state IN ('pending','running')").get(space, session)) {
      throw new BusinessError(409, '该会话已有运行，请等待完成或主动停止。');
    }
    if (!retryOf) this.learning.addMessage(space, session, input);
    const id = randomUUID();
    this.learning.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,'pending')").run(space, id, frozen.unitId, session, frozen.scenario);
    this.learning.db.prepare('INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,?,?)').run(space, id, JSON.stringify({ ...frozen, submitted: input }), Date.now());
    this.learning.db.prepare("INSERT INTO messages VALUES (?,?,?,'agent','',NULL,?)").run(space, session, id, Date.now());
    this.emit(space, id, { type: 'state', state: 'pending', error: null });
    return id;
  }
  private launch(space: string, id: string, text: string) {
    if (this.get(space, id).state === 'pending' && !this.live.has(id)) {
      const entry: { space: string; agent?: Agent; done: Promise<void> } = { space, done: Promise.resolve() };
      this.live.set(id, entry);
      entry.done = Promise.resolve().then(() => this.execute(space, id, text, entry)).finally(() => { this.live.delete(id); });
    }
  }
  stop(space: string, id: string) {
    const run = this.get(space, id);
    if (active(run)) {
      // Synchronous commit fence: a cancellation accepted before commit wins.
      this.learning.db.transaction(() => {
        this.learning.db.prepare(`UPDATE ${this.tables(space, id).run} SET cancelled=1 WHERE space_id=? AND id=?`).run(space, id);
        this.finish(space, id, 'interrupted', '已主动停止；未完成的回复不能作为完成结果。');
      })();
      this.live.get(id)?.agent?.abort();
    }
    return this.get(space, id);
  }
  async idle(id: string) { await this.live.get(id)?.done; }
  async close() {
    this.closing = true;
    for (const [id, entry] of this.live) {
      this.learning.db.transaction(() => this.finish(entry.space, id, 'interrupted', '服务关闭，运行已中断；未自动重放。'))();
      entry.agent?.abort();
    }
    await Promise.all([...this.live.values()].map((entry) => entry.done));
  }
  private finish(space: string, id: string, state: AgentRun['state'], error: string | null) {
    const tables = this.tables(space, id);
    const changed = this.learning.db.prepare(`UPDATE ${tables.work} SET state=? WHERE space_id=? AND id=? AND state IN ('pending','running')`).run(state, space, id);
    if (!changed.changes) return;
    this.learning.db.prepare(`UPDATE ${tables.run} SET error=? WHERE space_id=? AND id=?`).run(error, space, id);
    this.emit(space, id, { type: 'state', state, error });
  }
  private history(space: string, session: string, id: string): HistoryGroup[] {
    const rows = this.learning.db.prepare(`SELECT r.id,m.value FROM runs r JOIN agent_messages m ON m.space_id=r.space_id AND m.run_id=r.id
      WHERE r.space_id=? AND r.session_id=? AND r.id!=? AND r.state='succeeded' ORDER BY r.rowid,m.seq`).all(space, session, id) as { id: string; value: string }[];
    const groups = new Map<string, HistoryGroup>();
    for (const row of rows) { const g = groups.get(row.id) ?? { id: row.id, messages: [] }; g.messages.push(JSON.parse(row.value) as Message); groups.set(row.id, g); }
    return [...groups.values()];
  }
  private async execute(space: string, id: string, text: string, entry: { agent?: Agent }) {
    if (!active(this.get(space, id))) return;
    const tables = this.tables(space, id);
    const { input } = this.learning.db.prepare(`SELECT input FROM ${tables.run} WHERE space_id=? AND id=?`).get(space, id) as { input: string };
    const frozen = JSON.parse(input) as FrozenContext;
    const history = frozen.sessionId ? this.history(space, frozen.sessionId, id) : [];
    // Assessment/evaluation reasoning can contain private reference answers.
    // Publish real phase/tool activity, but never their unvalidated model prose.
    const displayModelText = frozen.scenario !== 'assessment' && frozen.scenario !== 'evaluation';
    const toolSources: unknown[] = [];
    const toolParts = new Map<string, string>(), inputCharacters = new Map<string, number>();
    let transport: { startedAt: number; httpStatus: number | null; eventCount: number; lastEventAt: number | null };
    let failure = '', request = 0, calls = 0, output = 0, nativeSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const scenario = this.options.scenario?.(frozen) ?? (frozen.sessionId ? createScenario(this.learning, frozen, id, this.options.projectDirectory?.(space)) : createTask(this.learning, frozen));
      const tools = scenario.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      const agent = new Agent({
        initialState: { model: teachingModel, tools: scenario.tools, thinkingLevel: budget.reasoning },
        sessionId: frozen.sessionId ?? id, toolExecution: 'sequential', maxRetryDelayMs: 1000,
        getApiKey: () => this.config?.apiKey,
        beforeToolCall: async () => {
          if (++calls > budget.tools || !active(this.get(space, id))) {
            failure = '工具调用预算耗尽或运行已停止。';
            return { block: true, reason: failure, terminate: true };
          }
          return undefined;
        },
        streamFn: async (model, context, options) => {
          try {
            if (++request > budget.requests || output >= budget.outputTotal) throw new BusinessError(422, '模型轮次或总输出预算已耗尽。');
            if (!active(this.get(space, id))) return failureStream('运行已停止。', true);
            const compiled = compileRequest(frozen, history, context.messages, tools);
            const manifest = { ...compiled.manifest, runId: id, sessionId: frozen.sessionId, scenario: frozen.scenario, request,
              model: teachingModel.id, provider: teachingModel.provider, modelMetadata: { contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost },
              toolSources, actualUsage: null };
            this.learning.db.prepare(`INSERT INTO ${tables.manifests} VALUES (?,?,?,?)`).run(space, id, request, JSON.stringify(manifest));
            if (this.options.debugDirectory) {
              mkdirSync(this.options.debugDirectory, { recursive: true, mode: 0o700 });
              writeFileSync(join(this.options.debugDirectory, `${id}-${request}.json`), JSON.stringify({ manifest, messages: compiled.messages }), { mode: 0o600, flag: 'wx' });
            }
            transport = { startedAt: Date.now(), httpStatus: null, eventCount: 0, lastEventAt: null };
            return await this.stream(model, normalizeContext({ messages: compiled.messages }), {
              ...options, maxTokens: Math.min(budget.output, budget.outputTotal - output),
              onResponse: (response) => { transport.httpStatus = response.status; },
              onProviderStreamEvent: () => { transport.eventCount++; transport.lastEventAt = Date.now(); },
            });
          } catch (error) {
            failure = error instanceof BusinessError ? error.message : '无法准备模型请求。';
            return failureStream(failure);
          }
        },
      });
      entry.agent = agent;
      timer = setTimeout(() => { failure = '模型运行超时，请重试或缩小任务。'; agent.abort(); }, this.options.milliseconds ?? budget.milliseconds);
      this.learning.db.prepare(`UPDATE ${tables.work} SET state='running' WHERE space_id=? AND id=?`).run(space, id);
      this.emit(space, id, { type: 'state', state: 'running', error: null });
      agent.subscribe((event) => {
        if (event.type === 'message_end' && event.message.role !== 'system') {
          const m = event.message;
          this.learning.db.prepare(`INSERT INTO ${tables.messages} VALUES (?,?,?,1,?)`).run(space, id, ++nativeSeq, JSON.stringify(retainedMessage(m)));
          if (m.role === 'assistant') {
            output += m.usage.output;
            // Keep enough transport evidence for diagnosis without retaining provider
            // error bodies, headers, credentials, or an invented zero-token usage.
            const diagnostic = { ...transport, elapsedMs: transport ? Date.now() - transport.startedAt : null,
              responseId: m.responseId ?? null, stopReason: m.stopReason,
              errorFingerprint: m.errorMessage ? createHash('sha256').update(m.errorMessage).digest('hex') : null };
            this.learning.db.prepare(`UPDATE ${tables.manifests} SET value=json_set(value,'$.actualUsage',json(?),'$.transport',json(?)) WHERE space_id=? AND run_id=? AND request=?`)
              .run(JSON.stringify(m.stopReason === 'error' && m.usage.totalTokens === 0 ? null : m.usage), JSON.stringify(diagnostic), space, id, request);
          }
        }
        if (!active(this.get(space, id))) return;
        if (event.type === 'tool_execution_end' && event.result.details?.sources) toolSources.push({ callId: event.toolCallId, sources: event.result.details.sources, retention: 'body omitted' });
        if (event.type === 'tool_execution_end' && event.isError) failure = '工具调用或结构化产物无效，未保存生成产物。';
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (displayModelText && update.type === 'text_delta') {
            this.learning.db.transaction(() => {
              if (frozen.sessionId) this.learning.db.prepare('UPDATE messages SET text=text||? WHERE space_id=? AND id=?').run(update.delta, space, id);
              this.emit(space, id, { type: 'text', delta: update.delta, partId: `${id}:${request}:text:${update.contentIndex}` });
            })();
          }
          if (update.type === 'thinking_start' || update.type === 'thinking_delta' || update.type === 'thinking_end') {
            const native = update.partial.content[update.contentIndex];
            // Never publish opaque/redacted provider state or signatures.
            if (native?.type === 'thinking' && !native.redacted && (displayModelText || update.type !== 'thinking_delta')) this.emit(space, id, {
              type: 'reasoning', partId: `${id}:${request}:reasoning:${update.contentIndex}`,
              phase: update.type === 'thinking_start' ? 'start' : update.type === 'thinking_end' ? 'end' : 'delta',
              ...(update.type === 'thinking_delta' ? { delta: update.delta } : {}),
            });
          }
          if (update.type === 'toolcall_start' || update.type === 'toolcall_delta' || update.type === 'toolcall_end') {
            const native = update.partial.content[update.contentIndex];
            if (native?.type === 'toolCall') {
              const partId = `${id}:${request}:tool-input:${update.contentIndex}`;
              toolParts.set(`${request}:${native.id}`, partId);
              const count = (inputCharacters.get(partId) ?? 0) + (update.type === 'toolcall_delta' ? update.delta.length : 0);
              inputCharacters.set(partId, count);
              this.emit(space, id, { type: 'tool', callId: partId, name: native.name,
                phase: update.type === 'toolcall_end' ? 'ready' : 'input', inputCharacters: count });
            }
          }
        }
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') this.emit(space, id,
          { type: 'tool', callId: toolParts.get(`${request}:${event.toolCallId}`) ?? `${id}:${request}:tool:${event.toolCallId}`, name: event.toolName,
            phase: event.type === 'tool_execution_start' ? 'start' : 'end', failed: event.type === 'tool_execution_end' ? event.isError : undefined });
      });
      await agent.prompt({ role: 'user', content: frozen.references.length ? [
        { type: 'text', text }, { type: 'text', text: `<references>${xmlText(JSON.stringify(frozen.references))}</references>` },
      ] : text, timestamp: Date.now() });
      const last = agent.state.messages.at(-1);
      if (!active(this.get(space, id))) return;
      if (failure) throw new BusinessError(422, failure);
      if (last?.role !== 'assistant' || last.stopReason !== 'stop') throw new BusinessError(422,
        last?.role === 'assistant' && last.stopReason === 'length' ? '模型输出被截断，未保存生成产物。'
          : '模型响应未正常完成，未保存生成产物。可以重试；若反复发生，请检查模型服务状态。');
      this.learning.db.transaction(() => { scenario.commit(); this.finish(space, id, 'succeeded', null); })();
    } catch (error) {
      this.learning.db.transaction(() => this.finish(space, id, 'failed', error instanceof BusinessError ? error.message : '生成产物或模型运行无效，请重试。'))();
    } finally {
      if (timer) clearTimeout(timer);
      if (this.get(space, id).state !== 'succeeded') this.learning.db.transaction(() => sealToolCalls(this.learning.db,
        frozen.sessionId ? 'agent_messages' : 'task_messages', space, id))();
    }
  }
}

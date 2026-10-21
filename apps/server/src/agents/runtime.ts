import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { type AssistantMessage, type RetryPolicy } from '@earendil-works/pi-ai';
import { AgentSession, convertToLlm, createExtensionRuntime, SettingsManager, type CompactionSettings, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { assessmentResultSchema, assessmentSpecSchema, businessErrorResponse, createSpaceSchema, generationInputSchema, idSchema, messageInputSchema, questionAnswerSchema, rejectLessonProposalSchema, rejectRouteProposalSchema, saveRequirementSchema, type AgentContext, type AgentEventData, type AgentRun, type BusinessErrorDetail, type ProposalRejection, type RunEvents, type RunSubmission } from '@teach-me-coding/contracts';
import { BusinessError, Learning } from '../modules/learning.js';
import type { ModelSource } from '../models/service.js';
import { classifyModelFailure } from '../models/failure.js';
import { compileRequest, hash, retainedMessage, xmlText, type FrozenContext } from './context.js';
import { defaultHttpIdleTimeoutMs, defaultRetryPolicy, failureStream, providerStream } from './model.js';
import { createModelTransport } from './model-transport.js';
import { createScenario } from './scenarios.js';
import { baseline, createTask } from './tasks.js';
import { Assessments } from '../modules/assessments.js';
import type { Actions } from '../modules/actions.js';
import type { Executions } from '../modules/executions.js';
import { sealToolCalls } from '../storage/agent-messages.js';
import { restoreAgentSession } from '../storage/agent-sessions.js';
import type { McpService } from '../extensions/mcp.js';
import type { SkillService } from '../extensions/skills.js';
import type { SearchService } from '../extensions/search.js';
import type { WebFetchOptions } from '../extensions/web-fetch.js';
import { prepareTools } from './tools.js';
import type { Library } from '../modules/library.js';

export interface ScenarioRun {
  tools: AgentTool[]; commit: () => void;
}
interface RuntimeOptions {
  stream?: StreamFn;
  scenario?: (input: FrozenContext) => ScenarioRun;
  httpIdleTimeoutMs?: number;
  retry?: RetryPolicy;
  compaction?: Partial<CompactionSettings>;
  debugDirectory?: string;
  projectDirectory?: (space: string) => string;
  actions?: Actions;
  executions?: Executions;
  mcp?: McpService;
  skills?: SkillService;
  search?: SearchService;
  webFetch?: WebFetchOptions;
  library?: Library;
}
const active = (run: AgentRun) => run.state === 'running' || run.state === 'pending';
export class TeachingRuntime {
  private live = new Map<string, { space: string; session?: AgentSession; controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private stream: StreamFn;
  private httpIdleTimeoutMs: number;
  private retryPolicy: RetryPolicy;
  private modelTransport: ReturnType<typeof createModelTransport>;
  constructor(readonly learning: Learning, private models: ModelSource | null, private options: RuntimeOptions = {}) {
    this.stream = options.stream ?? models?.stream ?? providerStream();
    this.httpIdleTimeoutMs = options.httpIdleTimeoutMs ?? defaultHttpIdleTimeoutMs;
    this.retryPolicy = { ...(options.retry ?? defaultRetryPolicy) };
    this.modelTransport = createModelTransport(this.httpIdleTimeoutMs);
  }
  get available() { return this.models !== null && this.models.current() !== null; }
  get actions() { return this.options.actions; }
  get executions() { return this.options.executions; }

  private modelUnavailable() {
    return new BusinessError(503, this.models?.issue ?? { code: 'MODEL_UNAVAILABLE' });
  }

  async approveSession(space: string, session: string, run?: string) {
    const enabled = () => !this.closing && this.learning.sessionSettings(space, session).yolo;
    if (!enabled()) return;
    const owner = this.learning.session(space, session), workspace = this.learning.space(space);
    for (const proposal of workspace.proposals) {
      if (!enabled()) return;
      if (proposal.state === 'pending' && proposal.sessionId === session && (!run || proposal.runId === run)) {
        this.learning.applyProposal(space, proposal.id);
      }
    }
    for (const proposal of workspace.lessonProposals) {
      if (!enabled()) return;
      if (proposal.state === 'pending' && proposal.sessionId === session && (!run || proposal.source.id === run)) {
        this.learning.applyLessonProposal(space, proposal.id);
      }
    }
    for (const conclusion of this.learning.conclusions(space)) {
      if (!enabled()) return;
      if (conclusion.valid && !conclusion.adopted && (run ? conclusion.runId === run
        : workspace.runs.some((work) => work.id === conclusion.runId && work.sessionId === session))) {
        this.learning.decideConclusion(space, conclusion.id, { revision: conclusion.revision, adopted: true });
      }
    }
    for (const proposal of this.actions?.list(space, session) ?? []) {
      if (!enabled()) return;
      if (proposal.state !== 'pending' || run && proposal.runId !== run) continue;
      this.actions!.decide(space, proposal.id, { digest: proposal.digest, decision: 'confirm' });
      await this.actions!.idle(proposal.id);
    }
    if (!enabled() || owner.scope !== 'intake') return;
    const current = this.learning.space(space);
    // Questions need real answers; YOLO grants consent, never supplies missing facts.
    if (!current.requirement.confirmed && current.readiness?.ready
      && !current.runs.some((work) => work.kind === 'intake' && ['pending', 'running'].includes(work.state))) {
      this.plan(space, randomUUID(), { ...current.requirement, confirmed: true });
    }
  }

  private tables(space: string, id: string) {
    return this.learning.db.prepare('SELECT 1 FROM task_runs WHERE space_id=? AND id=?').get(space, id)
      ? { work: 'tasks', run: 'task_runs', events: 'task_events', messages: 'task_messages', manifests: 'task_manifests' }
      : { work: 'runs', run: 'agent_runs', events: 'agent_events', messages: 'agent_messages', manifests: 'context_manifests' };
  }
  get(space: string, id: string): AgentRun {
    idSchema.parse(space); idSchema.parse(id);
    const tables = this.tables(space, id);
    const row = this.learning.db.prepare(`SELECT r.id,r.unit_id AS unitId,r.session_id AS sessionId,r.kind,r.state,
      a.error,a.cancelled,a.created_at AS createdAt,json_extract(a.input,'$.evaluation.submission.id') AS resultId,
      (SELECT json_extract(value,'$.context') FROM ${tables.events} WHERE space_id=r.space_id AND run_id=r.id
        AND json_extract(value,'$.type')='context' ORDER BY seq DESC LIMIT 1) AS context
      FROM ${tables.work} r JOIN ${tables.run} a ON a.space_id=r.space_id AND a.id=r.id
      WHERE r.space_id=? AND r.id=?`).get(space, id) as (Omit<AgentRun, 'cancelled' | 'context' | 'error'> & { cancelled: number; context: string | null; error: string | null }) | undefined;
    if (!row) throw new BusinessError(404, { code: 'RUN_NOT_FOUND' });
    const { context, error, ...run } = row;
    let failure: BusinessErrorDetail | null = null;
    if (error) {
      failure = { code: 'MODEL_RUN_INVALID' };
      try {
        const detail = JSON.parse(error) as BusinessErrorDetail;
        if (typeof detail?.code === 'string') failure = businessErrorResponse(detail) as BusinessErrorDetail;
      } catch { /* Unstructured stored failures have no trustworthy semantic identity. */ }
    }
    return { ...run, error: failure,
      cancelled: !!row.cancelled, ...(context ? { context: JSON.parse(context) as AgentContext } : {}) };
  }
  events(space: string, id: string, after = 0): RunEvents {
    const run = this.get(space, id);
    if (!Number.isSafeInteger(after) || after < 0) throw new BusinessError(400, { code: 'INVALID_EVENT_CURSOR' });
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
    if (s.scope !== 'intake' && !w.requirement.confirmed) throw new BusinessError(422, { code: 'REQUIREMENT_UNCONFIRMED' });
    if (s.scope === 'route') this.learning.intake.assertReady(space, w.requirement);
    if (s.unitId) this.learning.assertUnitUnlocked(space, s.unitId);
    const ref = (s.scope === 'unit' ? w.route.intake : w.requirement.intake)?.researchRef;
    return structuredClone({ spaceId: space, sessionId: session, unitId: s.unitId,
      model: this.models?.current()?.selection,
      scenario: s.scope === 'route' ? 'roadmap' : s.scope === 'unit' ? 'tutor' : 'intake',
      requirement: w.requirement, route: s.scope === 'intake' ? null : w.route,
      unit: w.route.content?.stages.flatMap((stage) => stage.units).find((unit) => unit.id === s.unitId) ?? null,
      lesson: s.unitId ? this.learning.unit(space, s.unitId).lesson : null, references,
      progress: s.scope === 'intake' ? undefined : this.learning.progress(space),
      rejectedProposal: s.scope === 'route' ? w.proposals.findLast((proposal) => proposal.state === 'rejected') : undefined,
      rejectedLessonProposal: s.unitId ? w.lessonProposals.findLast((p) => p.unitId === s.unitId && p.state === 'rejected') : undefined,
      conclusions: s.scope === 'intake' ? [] : w.conclusions.filter((c) => c.adopted && c.valid),
      evidence: s.scope === 'intake' ? [] : this.evidence(space),
      publicAssessment: s.unitId ? this.learning.unit(space, s.unitId).assessment : null,
      actions: s.scope === 'unit' ? this.actions?.list(space, session) : undefined,
      research: ref ? this.learning.intake.research(space, ref) : null,
      questions: s.scope === 'intake' ? s.questions : undefined,
    });
  }
  private evidence(space: string) {
    return this.learning.space(space).route.content?.stages.flatMap((s) => s.units).flatMap((u) => this.learning.unit(space, u.id).records.filter((r) => r.valid)) ?? [];
  }
  generate(space: string, unit: string, key: string, raw: unknown): AgentRun {
    const input = generationInputSchema.parse(raw);
    if (this.closing || !this.available) throw this.modelUnavailable();
    const id = this.learning.once(key, `task:${space}:${unit}`, input, () => {
      this.learning.assertAgentInputAllowed(space);
      const w = this.learning.space(space), u = this.learning.unit(space, unit);
      this.learning.assertUnitUnlocked(space, unit);
      const revision = input.kind === 'lesson' ? u.lesson?.revision ?? 0 : input.kind === 'assessment' ? u.assessment?.revision ?? 0 : u.draft.revision;
      if (!w.requirement.confirmed || revision !== input.revision) throw new BusinessError(409, { code: 'TASK_BASELINE_CHANGED' });
      if (input.kind === 'lesson' && input.sessionId) {
        const owner = this.learning.session(space, input.sessionId);
        if (owner.scope !== 'unit' || owner.unitId !== unit) throw new BusinessError(422, { code: 'LESSON_TASK_SESSION_MISMATCH' });
      }
      if (input.kind === 'lesson') {
        this.learning.intake.assertReady(space, { ...w.requirement, intake: w.route.intake }, false);
      }
      if (input.kind !== 'lesson' && !u.lesson) throw new BusinessError(422, { code: 'LESSON_REQUIRED' });
      if (this.learning.db.prepare("SELECT 1 FROM tasks WHERE space_id=? AND unit_id=? AND kind=? AND state IN ('pending','running')").get(space, unit, input.kind)) throw new BusinessError(409, { code: 'UNIT_TASK_RUNNING' });
      const frozen: FrozenContext = { spaceId: space, sessionId: null, unitId: unit, scenario: input.kind,
        model: this.models?.current()?.selection,
        requirement: w.requirement, route: w.route, unit: w.route.content!.stages.flatMap((s) => s.units).find((u) => u.id === unit)!,
        lesson: u.lesson, references: [], conclusions: w.conclusions.filter((c) => c.adopted && c.valid), evidence: this.evidence(space),
        progress: input.kind === 'evaluation' ? undefined : this.learning.progress(space),
        research: w.route.intake?.researchRef ? this.learning.intake.research(space, w.route.intake.researchRef) : null,
        assessmentRevision: u.assessment?.revision ?? 0,
        ...(input.kind === 'lesson' ? { approvalSessionId: input.sessionId, lessonRefs: this.learning.lessonReferences(space),
          rejectedLessonProposal: w.lessonProposals.findLast((p) => p.unitId === unit && p.state === 'rejected') } : {}),
        ...(input.kind === 'evaluation' ? { evaluation: new Assessments(this.learning).submit(space, unit, input) } : {}) };
      if (input.kind === 'evaluation' && input.execute) {
        if (!this.executions) throw new BusinessError(503, { code: 'LOCAL_EXECUTION_UNAVAILABLE' });
        const fixed = frozen.evaluation!;
        fixed.submission.evidence = { kind: 'local', execution: this.executions.create(space, unit, { specRevision: input.specRevision, code: input.q2 }, fixed.submission.id) };
      }
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
    if (previous.sessionId || !['failed', 'interrupted'].includes(previous.state)) throw new BusinessError(409, { code: 'TASK_RETRY_UNAVAILABLE' });
    if (this.closing || !this.available) throw this.modelUnavailable();
    const id = this.learning.once(key, `retry-task:${space}:${previousId}`, null, () => {
      this.learning.assertAgentInputAllowed(space);
      this.learning.assertUnitUnlocked(space, previous.unitId!);
      if (this.learning.db.prepare("SELECT 1 FROM tasks WHERE space_id=? AND unit_id=? AND kind=? AND state IN ('pending','running')").get(space, previous.unitId, previous.kind)) throw new BusinessError(409, { code: 'UNIT_TASK_RUNNING' });
      const old = this.learning.db.prepare('SELECT input FROM task_runs WHERE space_id=? AND id=?').get(space, previousId) as { input: string };
      if (previous.kind === 'lesson') {
        const frozen = JSON.parse(old.input) as FrozenContext;
        if (!frozen.lessonRefs) throw new BusinessError(409, { code: 'LESSON_RETRY_REFERENCES_MISSING' });
        // Only consumed lesson bodies are dependencies. Unread courseware can
        // change without invalidating an otherwise reproducible retry.
        const refs = this.learning.db.prepare(`SELECT DISTINCT json_extract(s.value,'$.id') AS unitId,json_extract(s.value,'$.revision') AS revision
          FROM task_manifests m,json_each(m.value,'$.toolSources') t,json_each(t.value,'$.sources') s
          WHERE m.space_id=? AND m.run_id=? AND json_extract(s.value,'$.kind') IN ('reference-lesson','previous-lesson')`)
          .all(space, previousId) as { unitId: string; revision: number }[];
        this.learning.checkBaseline(space, previous.unitId!, baseline(frozen));
        this.learning.checkLessonReferences(space, refs);
      }
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
    if (this.closing) throw new BusinessError(503, { code: 'SERVICE_CLOSING' });
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
    if (this.closing || !this.available) throw this.modelUnavailable();
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
  rejectLessonProposal(space: string, proposalId: string, key: string, raw: unknown): ProposalRejection {
    const input = rejectLessonProposalSchema.parse(raw);
    const receipt = this.learning.once(key, `reject-lesson-proposal:${space}:${proposalId}`, input, () => {
      const proposal = this.learning.space(space).lessonProposals.find((p) => p.id === proposalId);
      if (!proposal) throw new BusinessError(404, { code: 'LESSON_PROPOSAL_NOT_FOUND' });
      const unfinished = proposal.state === 'pending';
      this.learning.rejectLessonProposal(space, proposalId, input);
      let runId: string | null = null, followupError: BusinessErrorDetail | null = null;
      if (unfinished && input.feedback) {
        const message = { text: input.feedback, quote: null, draftRevision: this.learning.session(space, proposal.sessionId).draft.revision };
        try {
          // A failed start rolls back only the follow-up, never the decision or opinion.
          runId = this.learning.db.transaction(() => {
            if (this.closing || !this.available) throw this.modelUnavailable();
            return this.recordRun(space, proposal.sessionId, message, undefined, true);
          })();
        } catch (error) {
          this.learning.addMessage(space, proposal.sessionId, message, false);
          followupError = error instanceof BusinessError ? error.detail : { code: 'FOLLOWUP_START_FAILED' };
        }
      }
      return { sessionId: proposal.sessionId, runId, followupError };
    });
    if (receipt.runId) this.launch(space, receipt.runId, input.feedback);
    return { workspace: this.learning.space(space), session: this.learning.session(space, receipt.sessionId),
      run: receipt.runId ? this.get(space, receipt.runId) : null, followupError: receipt.followupError };
  }
  rejectProposal(space: string, proposalId: string, key: string, raw: unknown): ProposalRejection {
    const input = rejectRouteProposalSchema.parse(raw);
    const receipt = this.learning.once(key, `reject-proposal:${space}:${proposalId}`, input, () => {
      const proposal = this.learning.space(space).proposals.find((proposal) => proposal.id === proposalId);
      if (!proposal) throw new BusinessError(404, { code: 'ROUTE_PROPOSAL_NOT_FOUND' });
      const unfinished = proposal.state === 'pending';
      this.learning.rejectProposal(space, proposalId, input);
      let runId: string | null = null, followupError: BusinessErrorDetail | null = null;
      if (unfinished && input.feedback) {
        const message = { text: input.feedback, quote: null, draftRevision: this.learning.session(space, proposal.sessionId).draft.revision };
        try {
          // Savepoint: a failed follow-up still records the decision and feedback,
          // without leaving a half-created run or consuming an unrelated draft.
          runId = this.learning.db.transaction(() => {
            if (this.closing || !this.available) throw this.modelUnavailable();
            return this.recordRun(space, proposal.sessionId, message, undefined, true);
          })();
        } catch (error) {
          if (!(error instanceof BusinessError)) throw error;
          this.learning.addMessage(space, proposal.sessionId, message, false);
          followupError = error.detail;
        }
      }
      return { sessionId: proposal.sessionId, runId, followupError };
    });
    if (receipt.runId) this.launch(space, receipt.runId, input.feedback);
    return { workspace: this.learning.space(space), session: this.learning.session(space, receipt.sessionId),
      run: receipt.runId ? this.get(space, receipt.runId) : null, followupError: receipt.followupError };
  }
  answer(space: string, session: string, round: string, key: string, raw: unknown): RunSubmission {
    idSchema.parse(round);
    const input = questionAnswerSchema.parse(raw);
    if (this.closing || !this.available) throw this.modelUnavailable();
    const id = this.learning.once(key, `answer:${space}:${session}:${round}`, input, () => {
      const saved = this.learning.session(space, session);
      if (saved.scope !== 'intake') throw new BusinessError(422, { code: 'INTAKE_SESSION_REQUIRED' });
      const text = this.learning.intake.acceptAnswer(space, session, round, this.learning.space(space).requirement.revision, input);
      return this.recordRun(space, session, { text, quote: null, draftRevision: saved.draft.revision }, undefined, true);
    });
    const stored = this.learning.db.prepare('SELECT input FROM agent_runs WHERE space_id=? AND id=?').get(space, id) as { input: string };
    this.launch(space, id, JSON.parse(stored.input).submitted.text);
    return { run: this.get(space, id), session: this.learning.session(space, session) };
  }
  retry(space: string, id: string, key: string): RunSubmission {
    const previous = this.get(space, id);
    if (!previous.sessionId || !['failed', 'interrupted'].includes(previous.state)) throw new BusinessError(409, { code: 'RUN_RETRY_UNAVAILABLE' });
    const original = this.learning.db.prepare('SELECT input FROM agent_runs WHERE space_id=? AND id=?').get(space, id) as { input: string };
    const { submitted } = JSON.parse(original.input) as { submitted: unknown };
    return this.begin(space, previous.sessionId!, key, submitted, id);
  }
  private begin(space: string, session: string, key: string, raw: unknown, retryOf?: string): RunSubmission {
    const input = messageInputSchema.parse(raw);
    if (this.closing) throw new BusinessError(503, { code: 'SERVICE_CLOSING' });
    if (!this.available) throw this.modelUnavailable();
    const id = this.learning.once(key, `agent:${space}:${session}:${retryOf ?? ''}`, input, () => this.recordRun(space, session, input, retryOf));
    this.launch(space, id, input.text);
    return { run: this.get(space, id), session: this.learning.session(space, session) };
  }
  private recordRun(space: string, session: string, input: ReturnType<typeof messageInputSchema.parse>, retryOf?: string, preserveDraft = false) {
    this.learning.assertAgentInputAllowed(space);
    if (this.learning.session(space, session).scope === 'route') this.learning.assertRouteAdjustmentAllowed(space);
    if (this.learning.db.prepare("SELECT 1 FROM runs WHERE space_id=? AND session_id=? AND state IN ('pending','running')").get(space, session)) {
      throw new BusinessError(409, { code: 'SESSION_RUN_ACTIVE' });
    }
    if (!retryOf) this.learning.addMessage(space, session, input, !preserveDraft);
    const frozen = this.freeze(space, session, input.quote ? [input.quote] : []);
    const id = randomUUID();
    this.learning.db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,'pending')").run(space, id, frozen.unitId, session, frozen.scenario);
    this.learning.db.prepare('INSERT INTO agent_runs(space_id,id,input,created_at) VALUES (?,?,?,?)').run(space, id, JSON.stringify({ ...frozen, submitted: input }), Date.now());
    this.learning.db.prepare("INSERT INTO messages VALUES (?,?,?,'agent','',NULL,?)").run(space, session, id, Date.now());
    this.emit(space, id, { type: 'state', state: 'pending', error: null });
    return id;
  }
  private launch(space: string, id: string, text: string) {
    if (this.get(space, id).state === 'pending' && !this.live.has(id)) {
      const entry: { space: string; session?: AgentSession; controller: AbortController; done: Promise<void> } = { space, controller: new AbortController(), done: Promise.resolve() };
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
        this.finish(space, id, 'interrupted', { code: 'RUN_STOPPED' });
      })();
      this.live.get(id)?.controller.abort();
      void this.live.get(id)?.session?.abort();
      this.stopExecution(space, id);
    }
    return this.get(space, id);
  }
  async idle(id: string) { await this.live.get(id)?.done; }
  private stopExecution(space: string, id: string) {
    const row = this.learning.db.prepare(`SELECT input FROM ${this.tables(space, id).run} WHERE space_id=? AND id=?`).get(space, id) as { input: string };
    const evidence = (JSON.parse(row.input) as FrozenContext).evaluation?.submission.evidence;
    if (evidence?.kind === 'local') this.executions?.stop(space, evidence.execution.id);
  }
  async close() {
    this.closing = true;
    for (const [id, entry] of this.live) {
      this.learning.db.transaction(() => this.finish(entry.space, id, 'interrupted', { code: 'RUN_SHUTDOWN' }))();
      entry.controller.abort();
      void entry.session?.abort();
      this.stopExecution(entry.space, id);
    }
    await Promise.all([...this.live.values()].map((entry) => entry.done));
    await this.modelTransport.close();
  }
  private finish(space: string, id: string, state: AgentRun['state'], error: BusinessErrorDetail | null) {
    const tables = this.tables(space, id);
    const changed = this.learning.db.prepare(`UPDATE ${tables.work} SET state=? WHERE space_id=? AND id=? AND state IN ('pending','running')`).run(state, space, id);
    if (!changed.changes) return;
    this.learning.db.prepare(`UPDATE ${tables.run} SET error=? WHERE space_id=? AND id=?`).run(error ? JSON.stringify(error) : null, space, id);
    const context = this.get(space, id).context;
    if (context?.phase === 'compacting' && !['pending', 'running'].includes(state)) this.emit(space, id,
      { type: 'context', context: { ...context, phase: state === 'failed' ? 'failed' : 'interrupted' } });
    this.emit(space, id, { type: 'state', state, error });
  }
  private async execute(space: string, id: string, text: string, entry: { session?: AgentSession; controller: AbortController }) {
    if (!active(this.get(space, id))) return;
    const tables = this.tables(space, id);
    const { input } = this.learning.db.prepare(`SELECT input FROM ${tables.run} WHERE space_id=? AND id=?`).get(space, id) as { input: string };
    const frozen = JSON.parse(input) as FrozenContext;
    const model = frozen.model && this.models?.resolve(frozen.model);
    const choice = model ? { selection: frozen.model!, model } : this.models?.current() ?? null;
    if (!choice) {
      this.learning.db.transaction(() => this.finish(space, id, 'failed', { code: 'MODEL_SELECTION_UNAVAILABLE' }))();
      return;
    }
    frozen.model = choice.selection;
    // Assessment/evaluation reasoning can contain private reference answers.
    // Publish real phase/tool activity, but never their unvalidated model prose.
    const displayModelText = frozen.scenario !== 'assessment' && frozen.scenario !== 'evaluation';
    const publicInput = (name: string, args: Record<string, unknown>) => {
      if (name === 'submit_assessment') {
        const value = args.public && typeof args.public === 'object' ? args.public as Record<string, unknown> : {};
        return { public: Object.fromEntries(Object.entries(assessmentSpecSchema.shape).flatMap(([key, schema]) =>
          key in value && schema.safeParse(value[key]).success ? [[key, value[key]]] : [])) };
      }
      if (name === 'submit_evaluation') return Object.fromEntries(Object.entries(assessmentResultSchema.shape).flatMap(([key, schema]) =>
        key in args && schema.safeParse(args[key]).success ? [[key, args[key]]] : []));
      // Unknown calls from a private-answer task must not expose private data.
      return displayModelText ? structuredClone(args) : {};
    };
    const toolSources: unknown[] = [];
    const toolParts = new Map<string, string>();
    let request = 0, nativeSeq = 0;
    let failure: BusinessErrorDetail | undefined;
    let modelFailure: ReturnType<typeof classifyModelFailure>;
    let completion: AssistantMessage | undefined;
    let phase: AgentContext['phase'] = 'ready', compaction: AgentContext['compaction'];
    let usage: AgentContext['usage'] = null;
    let persistSession: (() => void) | undefined;
    const responses: Promise<void>[] = [];
    try {
      const fixed = frozen.evaluation;
      if (fixed?.submission.evidence.kind === 'local') {
        if (!this.executions) throw new BusinessError(503, { code: 'LOCAL_EXECUTION_UNAVAILABLE' });
        fixed.submission.evidence.execution = await this.executions.run(space, fixed.submission.evidence.execution.id);
        this.learning.db.prepare('UPDATE submissions SET evidence=? WHERE space_id=? AND id=?').run(JSON.stringify(fixed.submission.evidence), space, fixed.submission.id);
        this.learning.db.prepare('UPDATE task_runs SET input=? WHERE space_id=? AND id=?').run(JSON.stringify(frozen), space, id);
        if (!active(this.get(space, id))) return;
      }
      const scenario = this.options.scenario?.(frozen) ?? (frozen.sessionId ? createScenario(this.learning, frozen, id, this.options.projectDirectory?.(space), this.actions) : createTask(this.learning, frozen, id));
      const skills = this.options.skills?.snapshot(text);
      const prepared = await prepareTools({ scenarioTools: scenario.tools,
        cwd: () => this.options.projectDirectory?.(space) ?? process.cwd(), hasSkills: !!skills?.skills.length,
        mcp: this.options.mcp, search: this.options.search, webFetch: this.options.webFetch, library: this.options.library, runId: id, signal: entry.controller.signal });
      const modelRuntime = await this.models!.sessionRuntime(choice.model);
      if (!active(this.get(space, id))) return;
      const cwd = this.options.projectDirectory?.(space) ?? process.cwd();
      const saved = restoreAgentSession(this.learning.db, space, frozen.sessionId, id, cwd);
      const approvalSession = frozen.sessionId ?? frozen.approvalSessionId;
      const yolo = approvalSession && this.learning.sessionSettings(space, approvalSession).yolo;
      const approvalPrompt = yolo ? '<approval_mode>当前会话已开启 YOLO。仍通过现有工具提交产物；正常完成后宿主会自动接受需求、路线、课件、文件修改和学习结论，无需请求用户点击审批。此模式覆盖默认的人工确认要求，但不代表已执行成功，不绕过版本、归属、写入或测评校验。澄清问题仍需用户真实回答，不能编造答案。</approval_mode>' : '';
      const compiled = compileRequest(frozen, saved.history, [], prepared.declarations, `${skills?.prompt ?? ''}${approvalPrompt}`);
      for (const message of compiled.messages.slice(2)) saved.manager.appendMessage(message);
      // The current frozen business baseline replaces the previous baseline, not
      // the conversation. Compaction summaries remain historical, never authority.
      for (const item of saved.manager.buildSessionProjection().entries) if (item.sourceEntry.type === 'custom_message' &&
        item.sourceEntry.customType === 'teaching-context' && item.messages.length) saved.manager.appendContextEdit(item.sourceEntry.id, null);
      const baselineMessage = compiled.messages[1];
      if (baselineMessage?.role !== 'user') throw new Error('Missing teaching context');
      saved.manager.appendCustomMessageEntry('teaching-context', baselineMessage.content, false);
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => String(compiled.messages[0]!.content),
        getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
      persistSession = () => {
        this.learning.db.prepare(`UPDATE ${tables.run} SET input=json_set(input,'$.sessionCheckpoint',json(?))
          WHERE space_id=? AND id=?`).run(JSON.stringify(saved.checkpoint()), space, id);
      };
      const agent = new Agent({
        initialState: { model: choice.model, messages: saved.manager.buildSessionContext().messages, thinkingLevel: choice.selection.thinkingLevel },
        convertToLlm,
        sessionId: frozen.sessionId ?? id, toolExecution: 'sequential',
        streamFn: async (model, context, options) => {
          const timeoutMs = options?.timeoutMs ?? (this.httpIdleTimeoutMs === 0 ? 2147483647 : this.httpIdleTimeoutMs);
          const modelFetch = this.modelTransport.fetchFor(model.api);
          const currentRequest = ++request;
          const purpose = phase === 'compacting' ? 'compaction' : 'agent';
          const transport = { startedAt: Date.now(), httpStatus: null as number | null, eventCount: 0, lastEventAt: null as number | null };
          try {
            if (!active(this.get(space, id))) return failureStream(model, 'RUN_STOPPED', true);
            // AgentSession owns the projection. Reinjecting raw history here would
            // silently undo compaction; summary calls also need their own prompt.
            const manifest = { ...compiled.manifest, runId: id, sessionId: frozen.sessionId, scenario: frozen.scenario, request: currentRequest, purpose,
              projectionHash: hash(context.messages),
              model: choice.model.id, provider: choice.model.provider, thinkingLevel: choice.selection.thinkingLevel,
              modelMetadata: { contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost },
              modelExecution: { httpIdleTimeoutMs: modelFetch ? this.httpIdleTimeoutMs : null, timeoutMs, retry: this.retryPolicy,
                compaction: entry.session?.settingsManager.getCompactionSettings(model), maxTokens: options?.maxTokens, maxRetryDelayMs: options?.maxRetryDelayMs },
              extensions: { skills: skills?.digest ?? null, mcpTools: prepared.inventory.filter((tool) => tool.source === 'mcp').map((tool) => tool.name) },
              toolInventory: prepared.inventory, toolSources, actualUsage: null };
            this.learning.db.prepare(`INSERT INTO ${tables.manifests} VALUES (?,?,?,?)`).run(space, id, request, JSON.stringify(manifest));
            if (this.options.debugDirectory) {
              mkdirSync(this.options.debugDirectory, { recursive: true, mode: 0o700 });
              writeFileSync(join(this.options.debugDirectory, `${id}-${currentRequest}.json`), JSON.stringify({ manifest, messages: context.messages }), { mode: 0o600, flag: 'wx' });
            }
          } catch (error) {
            failure = error instanceof BusinessError ? error.detail : { code: 'MODEL_REQUEST_PREPARATION_FAILED' };
            return failureStream(model, failure.code);
          }
          let stream;
          try {
            stream = await this.stream(model, context, {
              ...options, timeoutMs, fetch: options?.fetch ?? modelFetch,
              onResponse: (response, ...rest) => { transport.httpStatus = response.status; options?.onResponse?.(response, ...rest); },
              onProviderStreamEvent: (...args) => { transport.eventCount++; transport.lastEventAt = Date.now(); options?.onProviderStreamEvent?.(...args); },
            });
          } catch (error) {
            // Transport throws follow the same retry path as native error responses.
            // The raw reason is fingerprinted, never exposed in retained messages/UI.
            stream = failureStream(model, error instanceof Error ? error.message : String(error),
              entry.controller.signal.aborted || options?.signal?.aborted);
          }
          responses.push(stream.result().then((message) => {
            modelFailure = message.stopReason === 'error' ? classifyModelFailure(model.provider, message.errorMessage) : undefined;
            const known = (message.stopReason !== 'error' && message.stopReason !== 'aborted') || message.usage.totalTokens > 0;
            if (known) usage = { input: (usage?.input ?? 0) + message.usage.input, output: (usage?.output ?? 0) + message.usage.output,
              cacheRead: (usage?.cacheRead ?? 0) + message.usage.cacheRead, cacheWrite: (usage?.cacheWrite ?? 0) + message.usage.cacheWrite,
              cost: (usage?.cost ?? 0) + message.usage.cost.total };
            const diagnostic = { ...transport, elapsedMs: Date.now() - transport.startedAt,
              responseId: message.responseId ?? null, stopReason: message.stopReason, rawStopReason: message.rawStopReason ?? null,
              failure: modelFailure ? { category: modelFailure.category, status: modelFailure.status,
                code: modelFailure.code, error: modelFailure.detail } : null,
              errorFingerprint: message.errorMessage ? createHash('sha256').update(message.errorMessage).digest('hex') : null };
            this.learning.db.prepare(`UPDATE ${tables.manifests} SET value=json_set(value,'$.actualUsage',json(?),'$.transport',json(?)) WHERE space_id=? AND run_id=? AND request=?`)
              .run(JSON.stringify(known ? message.usage : null), JSON.stringify(diagnostic), space, id, currentRequest);
          }));
          return stream;
        },
      });
      // Abort is cooperative in Pi; finishTurn ends even a just-settled tool
      // batch without another request or an invented assistant failure message.
      agent.finishTurn = (_turn, signal) => failure || signal?.aborted ? { action: 'end' } : undefined;
      const names = prepared.tools.map((tool) => tool.name);
      const session = new AgentSession({ agent, sessionManager: saved.manager,
        settingsManager: SettingsManager.inMemory({ retry: this.retryPolicy, compaction: this.options.compaction, httpIdleTimeoutMs: this.httpIdleTimeoutMs }),
        cwd, resourceLoader, modelRuntime, initialActiveToolNames: names, allowedToolNames: names,
        baseToolsOverride: Object.fromEntries(prepared.tools.map((tool) => [tool.name, tool])),
      });
      // Session installs its own tool hooks; retain the host's cancellation fence.
      const beforeToolCall = agent.beforeToolCall;
      agent.beforeToolCall = async (context, signal) => {
        if (failure || !active(this.get(space, id))) return { block: true, reason: failure?.code ?? 'RUN_STOPPED', terminate: true };
        return beforeToolCall?.(context, signal);
      };
      entry.session = session;
      const emitContext = () => {
        if (!active(this.get(space, id))) return;
        const current = session.getContextUsage();
        this.emit(space, id, { type: 'context', context: { modelId: choice.model.id, provider: choice.model.provider,
          contextWindow: current?.contextWindow ?? choice.model.contextWindow, tokens: current?.tokens ?? null, phase, compaction, usage } });
      };
      this.learning.db.prepare(`UPDATE ${tables.work} SET state='running' WHERE space_id=? AND id=?`).run(space, id);
      this.emit(space, id, { type: 'state', state: 'running', error: null });
      emitContext();
      session.subscribe((event) => {
        if (event.type === 'message_end' && (event.message.role === 'user' || event.message.role === 'assistant' || event.message.role === 'toolResult')) {
          const m = event.message;
          this.learning.db.prepare(`INSERT INTO ${tables.messages} VALUES (?,?,?,1,?)`).run(space, id, ++nativeSeq, JSON.stringify(retainedMessage(m)));
          if (m.role === 'assistant') {
            completion = m;
            phase = 'ready';
          }
        }
        if (!active(this.get(space, id))) return;
        if (event.type === 'turn_end') emitContext();
        if (event.type === 'compaction_start') {
          phase = 'compacting';
          compaction = { reason: event.reason === 'manual' ? 'threshold' : event.reason, tokensBefore: session.getContextUsage()?.tokens ?? null };
          emitContext();
        }
        if (event.type === 'compaction_end') {
          phase = event.aborted ? 'interrupted' : event.result ? 'compacted' : 'failed';
          emitContext();
        }
        if (event.type === 'tool_execution_end' && event.result.details?.sources) {
          toolSources.push({ callId: event.toolCallId, sources: event.result.details.sources, retention: 'body omitted' });
          this.learning.db.prepare(`UPDATE ${tables.manifests} SET value=json_set(value,'$.toolSources',json(?)) WHERE space_id=? AND run_id=? AND request=?`)
            .run(JSON.stringify(toolSources), space, id, request);
        }
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
              this.emit(space, id, { type: 'tool', callId: partId, name: native.name,
                ...(update.type === 'toolcall_delta' && displayModelText && !['submit_assessment', 'submit_evaluation'].includes(native.name) ? { inputDelta: update.delta } : {}),
                ...(update.type === 'toolcall_end' ? { input: publicInput(native.name, update.toolCall.arguments) } : {}),
                phase: update.type === 'toolcall_end' ? 'ready' : 'input' });
            }
          }
        }
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') this.emit(space, id,
          { type: 'tool', callId: toolParts.get(`${request}:${event.toolCallId}`) ?? `${id}:${request}:tool:${event.toolCallId}`, name: event.toolName,
            ...(event.type === 'tool_execution_start' ? { input: publicInput(event.toolName, event.args) } : {}),
            phase: event.type === 'tool_execution_start' ? 'start' : 'end', failed: event.type === 'tool_execution_end' ? event.isError : undefined });
      });
      await session.prompt(`${skills?.text ?? text}${frozen.references.length ? `\n<references>${xmlText(JSON.stringify(frozen.references))}</references>` : ''}`, { expandPromptTemplates: false });
      await Promise.all(responses);
      if (!active(this.get(space, id))) return;
      if (failure) throw new BusinessError(422, failure);
      if (completion?.stopReason !== 'stop') throw new BusinessError(422, modelFailure?.detail ?? {
          code: completion?.stopReason === 'length' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_RESPONSE_INCOMPLETE',
        });
      // Pi feeds tool errors back to the model; the scenario validates publishable artifacts.
      this.learning.db.transaction(() => { scenario.commit(); persistSession!(); emitContext(); this.finish(space, id, 'succeeded', null); })();
      // Only committed, normally completed artifacts can be automatically accepted.
      // File execution claims remain outside the publication transaction and never replay.
      const owner = frozen.sessionId ?? frozen.approvalSessionId;
      if (owner) {
        try { await this.approveSession(space, owner, id); }
        catch (error) {
          const messageId = randomUUID();
          this.learning.db.transaction(() => {
            this.learning.db.prepare("INSERT INTO messages VALUES (?,?,?,'agent','',NULL,?)")
              .run(space, owner, messageId, Date.now());
            this.emit(space, id, { type: 'notice', messageId,
              notice: businessErrorResponse(error instanceof BusinessError ? error.detail : { code: 'LOCAL_ACTION_FAILED' }) });
          })();
        }
      }
    } catch (error) {
      this.learning.db.transaction(() => this.finish(space, id, 'failed', error instanceof BusinessError
          ? error.detail : modelFailure?.detail ?? { code: 'MODEL_RUN_INVALID' }))();
    } finally {
      await Promise.all(responses);
      if (this.get(space, id).state !== 'succeeded') persistSession?.();
      entry.session?.dispose();
      this.options.library?.release(id);
      if (this.get(space, id).state !== 'succeeded') this.learning.db.transaction(() => sealToolCalls(this.learning.db,
        frozen.sessionId ? 'agent_messages' : 'task_messages', space, id))();
    }
  }
}

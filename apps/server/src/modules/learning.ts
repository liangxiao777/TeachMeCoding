import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assessmentDraftSchema, assessmentResultSchema, assessmentSpecSchema, conclusionDecisionSchema, conclusionSchema, createSessionSchema, createSpaceSchema,
  applyAgentEvent, applyPromptQueue, executionFeedback, idSchema, lessonChangeSchema, lessonMarkdown, lessonSchema, messageInputSchema, rejectLessonProposalSchema, rejectRouteProposalSchema, renameSpaceSchema, researchInputSchema, researchRefSchema, routeContentSchema, saveRequirementSchema, sessionDraftSchema, sessionSettingsSchema, unlockedUnitIds,
  type AgentContext, type AgentDisplayPart, type AgentEventData, type AssessmentRecord, type LearningConclusion, type Lesson, type LessonProposal, type LessonProposalApplication, type Message, type Proposal, type QueuedPrompt, type ResearchRef, type ResearchSaveResult, type RouteContent, type SessionDetail, type SessionSummary, type SpaceSummary, type UnitDetail, type UnitProgress, type Workspace,
} from '@teach-me-coding/contracts';
import { Intake } from './intake.js';

export interface LessonReference { unitId: string; revision: number }
export interface LessonBaseline { requirement: number; route: number; lesson: number }

export class BusinessError extends Error {
  constructor(public status: 400 | 404 | 409 | 413 | 422 | 503, message: string) { super(message); }
}
const conflict = () => new BusinessError(409, '内容已改变，请重新读取后再保存；本次修改未写入。');

export class Learning {
  readonly intake: Intake;
  constructor(readonly db: Database.Database) { this.intake = new Intake(db); }
  private one<T>(sql: string, ...params: unknown[]): T {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    if (!row) throw new BusinessError(404, '所属空间、单元或记录不存在。');
    return row;
  }
  private all<T>(sql: string, ...params: unknown[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }

  // Response and side effect commit together. Reusing a key with different input is never a retry.
  once<T>(key: string, operation: string, input: unknown, fn: () => T): T {
    idSchema.parse(key);
    const fingerprint = createHash('sha256').update(JSON.stringify([operation, input])).digest('hex');
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT fingerprint,response FROM requests WHERE key=?').get(key) as { fingerprint: string; response: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw new BusinessError(409, '幂等键已用于其他请求。');
        return JSON.parse(old.response) as T;
      }
      const result = fn();
      this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(key, fingerprint, JSON.stringify(result));
      return result;
    })();
  }

  list(): SpaceSummary[] { return this.all('SELECT id,name,created_at AS createdAt FROM spaces ORDER BY created_at DESC,rowid DESC'); }
  space(id: string): Workspace {
    idSchema.parse(id);
    const base = this.one<SpaceSummary>('SELECT id,name,created_at AS createdAt FROM spaces WHERE id=?', id);
    const { intake, ...req } = this.one<{ revision: number; confirmed: number; value: string; intake: string | null }>('SELECT revision,confirmed,value,intake FROM requirements WHERE space_id=?', id);
    const route = this.one<{ revision: number; content: string | null; intake: string | null }>('SELECT revision,content,intake FROM routes WHERE space_id=?', id);
    const content: RouteContent | null = route.content === null ? null : JSON.parse(route.content);
    const unitIds = new Set(content?.stages.flatMap((stage) => stage.units.map((unit) => unit.id)));
    const proposals = this.all<Omit<Proposal, 'content' | 'intake'> & { content: string; intake: string | null }>(
      'SELECT id,session_id AS sessionId,run_id AS runId,base_revision AS baseRevision,requirement_revision AS requirementRevision,state,feedback,content,intake FROM proposals WHERE space_id=? ORDER BY rowid', id);
    const requirement = { ...req, confirmed: !!req.confirmed, value: JSON.parse(req.value), ...(intake ? { intake: JSON.parse(intake) } : {}) };
    return { ...base, requirement, readiness: this.intake.readiness(id, requirement),
      route: { revision: route.revision, content, ...(route.intake ? { intake: JSON.parse(route.intake) } : {}) },
      sessions: this.all<SessionSummary>('SELECT id,scope,unit_id AS unitId,title FROM sessions WHERE space_id=? ORDER BY rowid', id)
        .filter((session) => session.unitId === null || unitIds.has(session.unitId)),
      proposals: proposals.map(({ intake, ...p }) => ({ ...p, content: JSON.parse(p.content), ...(intake ? { intake: JSON.parse(intake) } : {}) })),
      lessonProposals: this.lessonProposals(id),
      tasks: this.all('SELECT id,unit_id AS unitId,session_id AS sessionId,kind,state FROM tasks WHERE space_id=? ORDER BY rowid', id),
      runs: this.all('SELECT id,unit_id AS unitId,session_id AS sessionId,kind,state FROM runs WHERE space_id=? ORDER BY rowid', id),
      conclusions: this.conclusions(id),
    };
  }
  create(input: unknown): Workspace {
    const v = createSpaceSchema.parse(input);
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(id, v.name, Date.now());
      this.db.prepare('INSERT INTO requirements(space_id,value) VALUES (?,?)').run(id, JSON.stringify({ rows: [] }));
      this.db.prepare('INSERT INTO routes(space_id) VALUES (?)').run(id);
      for (const scope of ['intake', 'route']) {
        this.db.prepare('INSERT INTO sessions(space_id,id,scope,title) VALUES (?,?,?,?)').run(id, randomUUID(), scope, scope === 'intake' ? '学习需求' : '学习路线');
      }
      return this.space(id);
    })();
  }
  renameSpace(space: string, input: unknown): SpaceSummary {
    const current = this.space(space);
    const v = renameSpaceSchema.parse(input);
    const result = this.db.prepare('UPDATE spaces SET name=? WHERE id=? AND name=?').run(v.name, space, v.previousName);
    if (!result.changes) throw conflict();
    return { id: space, name: v.name, createdAt: current.createdAt };
  }
  saveRequirement(space: string, input: unknown) {
    const v = saveRequirementSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.space(space).requirement;
      if (current.revision !== v.revision) throw conflict();
      const intake = v.intake === undefined ? current.intake : v.intake;
      if (intake) this.intake.validateMetadata(space, intake);
      if (v.confirmed) this.intake.assertReady(space, { ...v, intake });
      this.db.prepare('UPDATE requirements SET value=?,intake=?,confirmed=?,revision=revision+1 WHERE space_id=? AND revision=?')
        .run(JSON.stringify(v.value), intake ? JSON.stringify(intake) : null, Number(v.confirmed), space, v.revision);
      this.intake.supersede(space);
      return this.space(space).requirement;
    })();
  }
  saveResearch(space: string, reference: ResearchRef, input: unknown): ResearchSaveResult {
    const ref = researchRefSchema.parse(reference), value = researchInputSchema.parse(input);
    return this.db.transaction(() => {
      const workspace = this.space(space), previous = this.intake.research(space, ref);
      const intake = workspace.requirement.intake;
      if (!intake?.researchRef || intake.researchRef.id !== ref.id || intake.researchRef.revision !== ref.revision) throw conflict();
      if (previous.content === value.content) return { document: previous, workspace };
      const document = this.intake.prepareResearch(this.intake.nextResearch(space, ref), null, value);
      this.intake.saveResearch(space, document);
      this.saveRequirement(space, { ...workspace.requirement, confirmed: false,
        intake: { ...intake, researchRef: { id: document.id, revision: document.revision } } });
      return { document, workspace: this.space(space) };
    })();
  }
  sessionSettings(space: string, id: string): SessionDetail['settings'] {
    idSchema.parse(space); idSchema.parse(id);
    this.one('SELECT 1 FROM sessions WHERE space_id=? AND id=?', space, id);
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(`session:${space}:${id}`) as { value: string } | undefined;
    return row ? sessionSettingsSchema.parse(JSON.parse(row.value)) : { revision: 0, yolo: false };
  }
  saveSessionSettings(space: string, id: string, input: unknown) {
    const value = sessionSettingsSchema.parse(input);
    return this.db.transaction(() => {
      this.session(space, id);
      const current = this.sessionSettings(space, id);
      if (value.revision !== current.revision) throw conflict();
      const settings = { ...value, revision: current.revision + 1 };
      this.db.prepare('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`session:${space}:${id}`, JSON.stringify(settings));
      return settings;
    })();
  }
  session(space: string, id: string): SessionDetail {
    idSchema.parse(space); idSchema.parse(id);
    // Text, event projection and resume cursor must come from the same snapshot.
    return this.db.transaction(() => {
      const row = this.one<SessionSummary & { revision: number; draft: string }>(
        'SELECT id,scope,unit_id AS unitId,title,revision,draft FROM sessions WHERE space_id=? AND id=?', space, id);
      if (row.unitId) this.assertUnitInRoute(space, row.unitId);
      const messages = this.all<Omit<Message, 'quote'> & { quote: string | null }>(
        `SELECT m.id,m.role,m.text,m.quote,m.created_at AS createdAt,
         COALESCE((SELECT MAX(seq) FROM agent_events e WHERE e.space_id=m.space_id AND e.run_id=m.id),0) AS sequence,
         CASE r.state WHEN 'pending' THEN 'thinking' WHEN 'running' THEN CASE WHEN m.text='' THEN 'thinking' ELSE 'streaming' END
           WHEN 'interrupted' THEN 'stopped' WHEN 'failed' THEN 'error' ELSE 'done' END AS status
         FROM messages m LEFT JOIN runs r ON r.space_id=m.space_id AND r.id=m.id
         WHERE m.space_id=? AND m.session_id=? ORDER BY m.rowid`, space, id);
      const events = this.all<{ runId: string; seq: number; value: string }>(
        `SELECT e.run_id AS runId,e.seq,e.value FROM agent_events e JOIN messages m ON m.space_id=e.space_id AND m.id=e.run_id
         WHERE m.space_id=? AND m.session_id=? ORDER BY e.run_id,e.seq`, space, id);
      const parts = new Map<string, AgentDisplayPart[]>();
      const contexts = new Map<string, AgentContext>();
      const errors = new Map<string, string>();
      const queues = new Map<string, QueuedPrompt[]>();
      const currentReply = new Map<string, string>();
      const replyRuns = new Map<string, string>();
      const cursors = new Map<string, number>();
      const roots = new Map(messages.map((message) => [message.id, message]));
      for (const event of events) {
        const data = JSON.parse(event.value) as AgentEventData;
        cursors.set(event.runId, event.seq);
        queues.set(event.runId, applyPromptQueue(queues.get(event.runId) ?? [], data));
        if (data.type === 'prompt_started') {
          currentReply.set(event.runId, data.messageId);
          replyRuns.set(data.messageId, event.runId);
          continue;
        }
        const reply = currentReply.get(event.runId) ?? event.runId;
        parts.set(reply, applyAgentEvent(parts.get(reply) ?? [], { runId: event.runId, seq: event.seq, data }));
        if (data.type === 'context') contexts.set(reply, data.context);
        if (data.type === 'state') {
          if (data.error) errors.set(reply, data.error);
          else errors.delete(reply);
        }
      }
      return { id: row.id, scope: row.scope, unitId: row.unitId, title: row.title, settings: this.sessionSettings(space, id),
        draft: { ...JSON.parse(row.draft), revision: row.revision },
        messages: messages.map((m) => {
          const runId = replyRuns.get(m.id) ?? m.id, root = roots.get(runId)!;
          const latest = currentReply.get(runId) ?? runId;
          const status = cursors.has(runId) ? latest !== m.id ? 'done'
            : root.status === 'thinking' || root.status === 'streaming' ? m.text ? 'streaming' : 'thinking' : root.status : m.status;
          return { ...m, quote: m.quote === null ? null : JSON.parse(m.quote), status,
            ...(replyRuns.has(m.id) ? { runId, sequence: cursors.get(runId) } : {}),
            ...(queues.has(m.id) ? { queuedPrompts: queues.get(m.id) } : {}),
            ...(parts.has(m.id) ? { parts: parts.get(m.id) } : {}),
            ...(contexts.has(m.id) ? { context: contexts.get(m.id) } : {}),
            ...(errors.has(m.id) ? { error: errors.get(m.id) } : {}),
          };
        }),
        ...(row.scope === 'intake' ? { questions: this.intake.questions(space, id) } : {}),
      };
    })();
  }
  createSession(space: string, input: unknown) {
    this.space(space);
    const v = createSessionSchema.parse(input);
    if (v.unitId) this.unit(space, v.unitId);
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions(space_id,id,scope,unit_id,title) VALUES (?,?,?,?,?)').run(space, id, v.scope, v.unitId, v.title);
    return this.session(space, id);
  }
  saveSessionDraft(space: string, id: string, input: unknown) {
    this.session(space, id);
    const { revision, ...value } = sessionDraftSchema.parse(input);
    const result = this.db.prepare('UPDATE sessions SET draft=?,revision=revision+1 WHERE space_id=? AND id=? AND revision=?')
      .run(JSON.stringify(value), space, id, revision);
    if (!result.changes) throw conflict();
    return this.session(space, id);
  }
  addMessage(space: string, id: string, input: unknown, clearDraft = true) {
    const v = messageInputSchema.parse(input);
    return this.db.transaction(() => {
      const session = this.session(space, id);
      this.assertAgentInputAllowed(space);
      // A new message must not unlock its own otherwise-empty unit session.
      if (session.unitId) this.assertUnitUnlocked(space, session.unitId);
      if (session.draft.revision !== v.draftRevision) throw conflict();
      if (session.scope === 'intake') this.intake.supersede(space, id);
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(space, id, randomUUID(), 'user', v.text, v.quote ? JSON.stringify(v.quote) : null, Date.now());
      if (clearDraft) this.saveSessionDraft(space, id, { ...session.draft, text: '', quote: null });
      return this.session(space, id); // No Agent invocation or fabricated reply.
    })();
  }
  unit(space: string, id: string): UnitDetail {
    idSchema.parse(space); idSchema.parse(id);
    const unit = this.one<Pick<UnitDetail, 'id' | 'status'>>('SELECT id,status FROM units WHERE space_id=? AND id=?', space, id);
    this.assertUnitInRoute(space, id);
    const lesson = this.db.prepare('SELECT content,revision FROM lessons WHERE space_id=? AND unit_id=?').get(space, id) as { content: string; revision: number } | undefined;
    const spec = this.db.prepare(`SELECT s.content,s.revision,v.sources FROM assessment_specs s
      LEFT JOIN assessment_versions v ON v.space_id=s.space_id AND v.unit_id=s.unit_id AND v.revision=s.revision
      WHERE s.space_id=? AND s.unit_id=?`).get(space, id) as { content: string; revision: number; sources: string | null } | undefined;
    const draft = this.db.prepare('SELECT revision,answers FROM assessment_drafts WHERE space_id=? AND unit_id=?').get(space, id) as { revision: number; answers: string } | undefined;
    const records = this.all<{ id: string; unitId: string; attempt: number; answers: string; result: string; createdAt: number }>(
      'SELECT id,unit_id AS unitId,attempt,answers,result,created_at AS createdAt FROM assessments WHERE space_id=? AND unit_id=? ORDER BY attempt DESC', space, id);
    const versions = this.one<{ requirement: number; confirmed: number }>('SELECT revision AS requirement,confirmed FROM requirements WHERE space_id=?', space);
    const submitted = this.db.prepare('SELECT MAX(attempt) AS n FROM submissions WHERE space_id=? AND unit_id=?').get(space, id) as { n: number | null };
    const evaluated: AssessmentRecord[] = records.map(({ result, answers, ...r }) => {
      const value = JSON.parse(result);
      // Hide only our exact legacy diagnostic strings; keep stored evidence and learner content intact.
      const execution = value.execution as AssessmentRecord['execution'];
      const diagnostic = execution ? `执行 ${execution.id}，代码 SHA-256 ${execution.codeHash}；${execution.state}，匹配 ${execution.results.filter((r) => r.matches).length}/${execution.plan.cases.length} 个公开用例。`
        : value.q2Kind === 'code' ? '只进行了静态模型评估；未运行所提交代码。' : '基于固定题目、rubric 和提交答案的非执行模型评估。';
      value.evidence = value.evidence.filter((text: string) => text !== diagnostic);
      value.toVerify = value.toVerify.filter((text: string) => text !== '需要完整的真实执行证据；缺工具链请自行配置，不自动安装。');
      if (value.result === 'pass') value.summary = '本次作答符合题目要求。';
      if (value.result === 'unverified') value.summary = execution ? executionFeedback(execution).summary : '本次没有可用的代码运行结果，尚不能判断代码是否符合要求。';
      if (execution && value.result === 'needs_work' && value.summary.startsWith('实际输出与测试期望不符。')) value.summary = executionFeedback(execution).summary;
      const valid = !!versions.confirmed && ['non-execution', 'execution-verified'].includes(value.verification) && value.specRevision === spec?.revision && value.lessonRevision === (lesson?.revision ?? 0)
        && value.sources?.requirement === versions.requirement;
      return { ...r, ...value, valid, answers: JSON.parse(answers) };
    });
    const historical = evaluated.find((record, index) => {
      const saved = JSON.parse(records[index]!.result);
      return record.result === 'pass' && ['non-execution', 'execution-verified'].includes(record.verification ?? '')
        && saved.sources?.requirement === versions.requirement && Number.isInteger(record.lessonRevision)
        && record.lessonRevision! > 0 && record.lessonRevision! < (lesson?.revision ?? 0)
        && !!this.db.prepare('SELECT 1 FROM lesson_versions WHERE space_id=? AND unit_id=? AND revision=?').get(space, id, record.lessonRevision);
    });
    // Preserve legacy initial reads, but never carry an unversioned pass to a new lesson.
    if ((evaluated.some((r) => r.verification) || (lesson?.revision ?? 0) > 1) && ['passed', 'needs_work'].includes(unit.status)) {
      const current = evaluated.find((r) => r.valid);
      unit.status = current ? current.result === 'pass' ? 'passed' : 'needs_work' : 'learning';
    }
    const sources = spec?.sources ? JSON.parse(spec.sources) as NonNullable<UnitDetail['assessmentSources']> : null;
    return { ...unit, started: this.activities(space, id)[0]!.started,
      lesson: lesson ? { ...JSON.parse(lesson.content), revision: lesson.revision } : null, assessment: spec ? { ...JSON.parse(spec.content), revision: spec.revision } : null,
      assessmentSources: sources ? { requirement: sources.requirement, lesson: sources.lesson } : null,
      nextAttempt: Math.max(submitted.n ?? 0, records[0]?.attempt ?? 0) + 1,
      draft: { unitId: id, revision: draft?.revision ?? 0, ...(draft ? JSON.parse(draft.answers) : { q1: '', q2: '' }) },
      records: evaluated,
      historicalPass: historical ? { recordId: historical.id, lessonRevision: historical.lessonRevision! } : null,
    };
  }
  lessonReferences(space: string): LessonReference[] {
    idSchema.parse(space);
    return this.all('SELECT unit_id AS unitId,revision FROM lessons WHERE space_id=?', space);
  }
  private activities(space: string, unit?: string): UnitProgress[] {
    // Match String.trim() without rewriting saved drafts or quoted content.
    // SQLite's default trim only removes ASCII spaces, not tabs or newlines.
    const hasText = (field: string) => `trim(${field},char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))!=''`;
    const rows = this.all<Omit<UnitProgress, 'started' | 'hasLesson' | 'active'> & { started: number; hasLesson: number; active: number }>(
      `SELECT u.id,u.status,
       EXISTS(SELECT 1 FROM lessons l WHERE l.space_id=u.space_id AND l.unit_id=u.id) AS hasLesson,
       (u.status IN ('learning','needs_work','passed')
        OR EXISTS(SELECT 1 FROM lessons l WHERE l.space_id=u.space_id AND l.unit_id=u.id)
        OR EXISTS(SELECT 1 FROM assessment_specs a WHERE a.space_id=u.space_id AND a.unit_id=u.id)
        OR EXISTS(SELECT 1 FROM assessments a WHERE a.space_id=u.space_id AND a.unit_id=u.id)
        OR EXISTS(SELECT 1 FROM submissions a WHERE a.space_id=u.space_id AND a.unit_id=u.id)
        OR EXISTS(SELECT 1 FROM code_executions e WHERE e.space_id=u.space_id AND e.unit_id=u.id)
        OR EXISTS(SELECT 1 FROM assessment_drafts d WHERE d.space_id=u.space_id AND d.unit_id=u.id
          AND (${hasText("json_extract(d.answers,'$.q1')")} OR ${hasText("json_extract(d.answers,'$.q2')")}))
        OR EXISTS(SELECT 1 FROM sessions s WHERE s.space_id=u.space_id AND s.unit_id=u.id
          AND (${hasText("json_extract(s.draft,'$.text')")} OR ${hasText("json_extract(s.draft,'$.quote.text')")}))
        OR EXISTS(SELECT 1 FROM messages m JOIN sessions s ON s.space_id=m.space_id AND s.id=m.session_id
          WHERE s.space_id=u.space_id AND s.unit_id=u.id AND (${hasText('m.text')} OR ${hasText("json_extract(m.quote,'$.text')")}))) AS started,
       (EXISTS(SELECT 1 FROM tasks t WHERE t.space_id=u.space_id AND t.unit_id=u.id AND t.state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM runs r WHERE r.space_id=u.space_id AND r.unit_id=u.id AND r.state IN ('pending','running'))
        OR EXISTS(SELECT 1 FROM code_executions e WHERE e.space_id=u.space_id AND e.unit_id=u.id
          AND json_extract(e.value,'$.state') IN ('pending','running'))) AS active
       FROM units u WHERE u.space_id=?${unit ? ' AND u.id=?' : ''}`, ...(unit ? [space, unit] : [space]));
    return rows.map((row) => ({ ...row, started: !!row.started, hasLesson: !!row.hasLesson, active: !!row.active }));
  }
  progress(space: string): UnitProgress[] {
    const ids = new Set(this.space(space).route.content?.stages.flatMap((stage) => stage.units.map((unit) => unit.id)));
    return this.activities(space).filter((unit) => ids.has(unit.id)).map((unit) => {
      const detail = this.unit(space, unit.id);
      return { ...unit, status: detail.status, historicalPass: detail.historicalPass };
    });
  }
  assertUnitInRoute(space: string, id: string) {
    if (!this.db.prepare(`SELECT 1 FROM routes r,json_each(r.content,'$.stages') s,json_each(s.value,'$.units') u
      WHERE r.space_id=? AND json_extract(u.value,'$.id')=?`).get(space, id)) throw new BusinessError(404, '单元不在当前学习路线中。');
  }
  assertUnitUnlocked(space: string, id: string) {
    idSchema.parse(id);
    const units = this.space(space).route.content?.stages.flatMap((stage) => stage.units) ?? [];
    if (!units.some((unit) => unit.id === id)) throw new BusinessError(404, '单元不在当前学习路线中。');
    const published = new Set(this.lessonReferences(space).map((ref) => ref.unitId));
    const retained = new Set(this.progress(space).filter((unit) => unit.started || unit.active).map((unit) => unit.id));
    if (!unlockedUnitIds(units, published, retained).has(id)) {
      const first = units.find((unit) => !published.has(unit.id))!;
      throw new BusinessError(422, `单元尚未解锁，请先生成并保存「${first.title}」的课件。`);
    }
  }
  lessonVersion(space: string, unit: string, revision: number) {
    idSchema.parse(space); idSchema.parse(unit);
    this.assertUnitInRoute(space, unit);
    const row = this.db.prepare('SELECT content FROM lesson_versions WHERE space_id=? AND unit_id=? AND revision=?').get(space, unit, revision) as { content: string } | undefined;
    if (!row) throw new BusinessError(409, '本次任务固定的课件版本无法读取，不会改用最新版。请重新生成课件。');
    return { ...lessonSchema.parse(JSON.parse(row.content)), revision };
  }
  checkLessonReferences(space: string, refs: readonly LessonReference[]) {
    const current = new Map(this.lessonReferences(space).map((ref) => [ref.unitId, ref.revision]));
    if (refs.some((ref) => current.get(ref.unitId) !== ref.revision)) {
      throw new BusinessError(409, '参考课件已改变，请按当前资料重新生成课件；本次结果未保存。');
    }
    for (const ref of refs) this.lessonVersion(space, ref.unitId, ref.revision);
  }
  saveAssessmentDraft(space: string, unit: string, input: unknown) {
    const { revision, ...answers } = assessmentDraftSchema.parse(input);
    return this.db.transaction(() => {
      if (this.unit(space, unit).draft.revision !== revision) throw conflict();
      this.db.prepare(`INSERT INTO assessment_drafts VALUES (?,?,?,?) ON CONFLICT(space_id,unit_id)
        DO UPDATE SET revision=excluded.revision,answers=excluded.answers`).run(space, unit, revision + 1, JSON.stringify(answers));
      return this.unit(space, unit).draft;
    })();
  }
  record(space: string, id: string): AssessmentRecord {
    idSchema.parse(id);
    const { unit_id } = this.one<{ unit_id: string }>('SELECT unit_id FROM assessments WHERE space_id=? AND id=?', space, id);
    return this.unit(space, unit_id).records.find((r) => r.id === id)!;
  }

  // Internal business entrypoints for validated future generation tasks; not browser generation APIs.
  assertAgentInputAllowed(space: string) {
    if (this.db.prepare("SELECT 1 FROM proposals WHERE space_id=? AND state='pending'").get(space)) {
      throw new BusinessError(409, '请先接受或拒绝当前路线提案，再继续对话。');
    }
    if (this.db.prepare("SELECT 1 FROM lesson_proposals WHERE space_id=? AND state='pending'").get(space)) {
      throw new BusinessError(409, '请先接受或拒绝当前课件提案，再继续对话或生成。');
    }
  }
  assertRouteAdjustmentAllowed(space: string, run?: string) {
    this.assertAgentInputAllowed(space);
    if (this.db.prepare("SELECT 1 FROM runs WHERE space_id=? AND kind='roadmap' AND state IN ('pending','running') AND id!=?").get(space, run ?? '')) {
      throw new BusinessError(409, '这个学习空间正在调整路线，请等待完成或停止当前生成。');
    }
  }
  private validateRouteAdjustment(space: string, content: RouteContent, previous: RouteContent | null) {
    const protectedIds = new Set(this.progress(space).filter((unit) => unit.started || unit.active).map((unit) => unit.id));
    const next = new Map(content.stages.flatMap((stage) => stage.units.map((unit) => [unit.id, unit] as const)));
    for (const unit of previous?.stages.flatMap((stage) => stage.units) ?? []) {
      if (!protectedIds.has(unit.id)) continue;
      const replacement = next.get(unit.id);
      if (!replacement) throw new BusinessError(409, `不能移除已开始学习或正在生成的单元「${unit.title}」，可以移动它或添加补充单元。`);
      if (JSON.stringify(unit.goals) !== JSON.stringify(replacement.goals)) throw new BusinessError(409,
        `「${unit.title}」已有学习活动，学习目标需要保留；新增目标请安排为补充单元。`);
    }
  }
  proposeRoute(space: string, session: string, input: unknown, baseline?: { requirement: number; route: number }, run?: string) {
    const content = routeContentSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.space(space);
      if (!current.requirement.confirmed || this.session(space, session).scope !== 'route') throw new BusinessError(422, '路线提案需要已确认需求及路线会话。');
      this.intake.assertReady(space, current.requirement);
      const base = baseline ?? { requirement: current.requirement.revision, route: current.route.revision };
      if (base.requirement !== current.requirement.revision || base.route !== current.route.revision) throw conflict();
      const ids = content.stages.flatMap((s) => [s.id, ...s.units.map((u) => u.id)]);
      if (new Set(ids).size !== ids.length) throw new BusinessError(422, '路线中的阶段和单元标识不能重复。');
      this.assertRouteAdjustmentAllowed(space, run);
      this.validateRouteAdjustment(space, content, current.route.content);
      const id = randomUUID();
      this.db.prepare('INSERT INTO proposals(space_id,id,session_id,base_revision,requirement_revision,content,intake,run_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(space, id, session, base.route, base.requirement, JSON.stringify(content), JSON.stringify(current.requirement.intake), run ?? null);
      return this.space(space).proposals.find((p) => p.id === id)!;
    })();
  }
  applyProposal(space: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(() => {
      const current = this.space(space);
      const p = current.proposals.find((p) => p.id === id);
      if (!p) throw new BusinessError(404, '路线提案不存在。');
      if (p.state === 'applied') return current;
      if (p.state !== 'pending') throw new BusinessError(409, '这份路线提案已经结束，不能再应用。');
      if (!current.requirement.confirmed || p.requirementRevision !== current.requirement.revision || p.baseRevision !== current.route.revision) throw conflict();
      this.intake.assertReady(space, current.requirement);
      const units = p.content.stages.flatMap((s) => s.units);
      this.validateRouteAdjustment(space, p.content, current.route.content);
      for (const u of units) this.db.prepare('INSERT INTO units(space_id,id) VALUES (?,?) ON CONFLICT DO NOTHING').run(space, u.id);
      this.db.prepare('UPDATE routes SET content=?,intake=?,revision=revision+1 WHERE space_id=?').run(JSON.stringify(p.content), p.intake ? JSON.stringify(p.intake) : null, space);
      this.db.prepare("UPDATE proposals SET state='applied' WHERE space_id=? AND id=?").run(space, id);
      return this.space(space);
    })();
  }
  rejectProposal(space: string, id: string, raw: unknown) {
    idSchema.parse(id);
    const input = rejectRouteProposalSchema.parse(raw);
    return this.db.transaction(() => {
      const current = this.space(space), proposal = current.proposals.find((proposal) => proposal.id === id);
      if (!proposal) throw new BusinessError(404, '路线提案不存在。');
      if (proposal.state === 'rejected' && proposal.feedback === input.feedback) return current;
      if (proposal.state !== 'pending') throw new BusinessError(409, '这份路线提案已经结束，不能再改变选择。');
      this.db.prepare("UPDATE proposals SET state='rejected',feedback=? WHERE space_id=? AND id=?").run(input.feedback, space, id);
      return this.space(space);
    })();
  }
  private lessonProposals(space: string): LessonProposal[] {
    const rows = this.all<Omit<LessonProposal, 'source' | 'content' | 'baseLesson' | 'references'> & {
      runId: string | null; taskId: string | null; content: string; references: string; base: string;
    }>(`SELECT p.id,p.unit_id AS unitId,p.session_id AS sessionId,p.run_id AS runId,p.task_id AS taskId,
      p.base_revision AS baseRevision,p.requirement_revision AS requirementRevision,p.route_revision AS routeRevision,
      p.state,p.feedback,p.note,p.content,p.reference_versions AS "references",v.content AS base
      FROM lesson_proposals p JOIN lesson_versions v ON v.space_id=p.space_id AND v.unit_id=p.unit_id AND v.revision=p.base_revision
      WHERE p.space_id=? ORDER BY p.rowid`, space);
    return rows.map(({ runId, taskId, content, references, base, ...row }) => ({ ...row,
      source: runId ? { kind: 'run', id: runId } : { kind: 'task', id: taskId! }, content: JSON.parse(content),
      references: JSON.parse(references), baseLesson: { ...lessonSchema.parse(JSON.parse(base)), revision: row.baseRevision } }));
  }
  private lessonSource(space: string, unit: string, source: LessonProposal['source'], base: LessonBaseline, session?: string) {
    idSchema.parse(source.id);
    const work = source.kind === 'run' ? 'runs' : 'tasks', runs = source.kind === 'run' ? 'agent_runs' : 'task_runs';
    const row = this.one<{ unitId: string; sessionId: string | null; kind: string; state: string; cancelled: number; input: string }>(
      `SELECT w.unit_id AS unitId,w.session_id AS sessionId,w.kind,w.state,r.cancelled,r.input
       FROM ${work} w JOIN ${runs} r ON r.space_id=w.space_id AND r.id=w.id WHERE w.space_id=? AND w.id=?`, space, source.id);
    const frozen = JSON.parse(row.input);
    if (row.unitId !== unit || row.kind !== (source.kind === 'run' ? 'tutor' : 'lesson')
      || row.cancelled || !['running', 'succeeded'].includes(row.state)
      || frozen.spaceId !== space || frozen.unitId !== unit || frozen.unit?.id !== unit || frozen.scenario !== row.kind
      || frozen.requirement?.revision !== base.requirement || frozen.route?.revision !== base.route || frozen.lesson?.revision !== base.lesson
      || frozen.sessionId !== row.sessionId || (source.kind === 'run' && row.sessionId !== session)) {
      throw new BusinessError(409, '课件提案来源或所属单元与固定输入不一致，不能保存。');
    }
    for (const ownerId of new Set([session, row.sessionId])) {
      if (!ownerId) continue;
      const owner = this.session(space, ownerId);
      if (owner.scope !== 'unit' || owner.unitId !== unit) throw new BusinessError(422, '课件提案只能修改发起会话所属单元。');
    }
    return row.state;
  }
  proposeLesson(space: string, unit: string, input: unknown, base: LessonBaseline, source: LessonProposal['source'], refs: readonly LessonReference[] = [], session?: string): LessonProposal | null {
    const { note, ...content } = lessonChangeSchema.parse(input);
    return this.db.transaction(() => {
      this.assertAgentInputAllowed(space);
      this.assertUnitUnlocked(space, unit);
      this.checkBaseline(space, unit, base);
      this.lessonSource(space, unit, source, base, session);
      this.checkLessonReferences(space, refs);
      const previous = this.lessonVersion(space, unit, base.lesson);
      if (previous.title === content.title && lessonMarkdown(previous) === content.content) return null;
      const owner = session ?? this.space(space).sessions.find((s) => s.scope === 'unit' && s.unitId === unit)?.id
        ?? this.createSession(space, { scope: 'unit', unitId: unit, title: previous.title }).id;
      this.lessonSource(space, unit, source, base, owner);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO lesson_proposals(space_id,id,unit_id,session_id,run_id,task_id,base_revision,requirement_revision,route_revision,content,note,reference_versions)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(space, id, unit, owner, source.kind === 'run' ? source.id : null,
        source.kind === 'task' ? source.id : null, base.lesson, base.requirement, base.route, JSON.stringify(content), note, JSON.stringify(refs));
      return this.lessonProposals(space).find((p) => p.id === id)!;
    })();
  }
  applyLessonProposal(space: string, id: string): LessonProposalApplication {
    idSchema.parse(id);
    return this.db.transaction(() => {
      const current = this.space(space), p = current.lessonProposals.find((p) => p.id === id);
      if (!p) throw new BusinessError(404, '课件提案不存在。');
      if (p.state === 'applied') return { workspace: current, unit: this.unit(space, p.unitId) };
      if (p.state !== 'pending') throw new BusinessError(409, '这份课件提案已经结束，不能再应用。');
      const base = { requirement: p.requirementRevision, route: p.routeRevision, lesson: p.baseRevision };
      this.assertUnitUnlocked(space, p.unitId);
      this.checkBaseline(space, p.unitId, base);
      if (this.lessonSource(space, p.unitId, p.source, base, p.sessionId) !== 'succeeded') throw new BusinessError(409, '课件提案的来源任务尚未正常完成，不能接受。');
      this.checkLessonReferences(space, p.references);
      this.writeLesson(space, p.unitId, p.content, p.baseRevision + 1);
      this.db.prepare("UPDATE lesson_proposals SET state='applied' WHERE space_id=? AND id=?").run(space, id);
      return { workspace: this.space(space), unit: this.unit(space, p.unitId) };
    })();
  }
  rejectLessonProposal(space: string, id: string, raw: unknown): Workspace {
    idSchema.parse(id);
    const input = rejectLessonProposalSchema.parse(raw);
    return this.db.transaction(() => {
      const current = this.space(space), p = current.lessonProposals.find((p) => p.id === id);
      if (!p) throw new BusinessError(404, '课件提案不存在。');
      if (p.state === 'rejected' && p.feedback === input.feedback) return current;
      if (p.state !== 'pending') throw new BusinessError(409, '这份课件提案已经结束，不能再改变选择。');
      this.db.prepare("UPDATE lesson_proposals SET state='rejected',feedback=? WHERE space_id=? AND id=?").run(input.feedback, space, id);
      return this.space(space);
    })();
  }
  // Initial publication only. Existing lessons can be written solely by an accepted proposal.
  saveLesson(space: string, unit: string, input: unknown, baseline?: LessonBaseline) {
    const content = lessonSchema.parse(input);
    return this.db.transaction(() => {
      const revision = this.unit(space, unit).lesson?.revision ?? 0;
      if (revision) throw new BusinessError(409, '已有课件必须通过课件提案并由用户明确接受，不能直接覆盖。');
      this.assertAgentInputAllowed(space);
      this.assertUnitUnlocked(space, unit);
      const w = this.space(space);
      this.checkBaseline(space, unit, baseline ?? { requirement: w.requirement.revision, route: w.route.revision, lesson: 0 });
      this.writeLesson(space, unit, content, 1);
      return this.unit(space, unit).lesson!;
    })();
  }
  private writeLesson(space: string, unit: string, content: Lesson, revision: number) {
    this.db.prepare(`INSERT INTO lessons(space_id,unit_id,content,revision) VALUES (?,?,?,?)
      ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content,revision=excluded.revision`).run(space, unit, JSON.stringify(content), revision);
    this.db.prepare('INSERT INTO lesson_versions VALUES (?,?,?,?)').run(space, unit, revision, JSON.stringify(content));
    this.db.prepare("UPDATE units SET status='learning' WHERE space_id=? AND id=? AND status='not_started'").run(space, unit);
  }
  checkBaseline(space: string, unit: string, baseline: { requirement: number; route: number; lesson: number }) {
    const w = this.space(space), u = this.unit(space, unit);
    if (!w.requirement.confirmed || w.requirement.revision !== baseline.requirement || w.route.revision !== baseline.route || (u.lesson?.revision ?? 0) !== baseline.lesson) throw conflict();
  }
  checkLearningSources(space: string, unit: string, baseline: { requirement: number; lesson: number }) {
    const w = this.space(space), u = this.unit(space, unit);
    if (!w.requirement.confirmed || w.requirement.revision !== baseline.requirement || (u.lesson?.revision ?? 0) !== baseline.lesson) throw conflict();
  }
  conclusions(space: string): LearningConclusion[] {
    const rows = this.all<Omit<LearningConclusion, 'sources' | 'adopted' | 'valid'> & { sources: string; adopted: number; valid: number }>(
      `SELECT c.id,c.unit_id AS unitId,c.run_id AS runId,c.text,c.revision,c.adopted,c.sources,
        (r.confirmed=1 AND r.revision=json_extract(c.sources,'$.requirement')
        AND COALESCE(l.revision,0)=json_extract(c.sources,'$.lesson')) AS valid
        FROM conclusions c JOIN requirements r ON r.space_id=c.space_id
        LEFT JOIN lessons l ON l.space_id=c.space_id AND l.unit_id=c.unit_id WHERE c.space_id=? ORDER BY c.rowid`, space);
    return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources), adopted: !!r.adopted, valid: !!r.valid }));
  }
  proposeConclusion(space: string, unit: string, run: string, input: unknown, sources: LearningConclusion['sources']) {
    this.checkBaseline(space, unit, sources);
    const value = conclusionSchema.parse(input);
    this.db.prepare('INSERT INTO conclusions(space_id,id,unit_id,run_id,text,sources) VALUES (?,?,?,?,?,?)')
      .run(space, randomUUID(), unit, run, value.text, JSON.stringify(sources));
  }
  decideConclusion(space: string, id: string, raw: unknown) {
    const input = conclusionDecisionSchema.parse(raw);
    const c = this.conclusions(space).find((c) => c.id === id);
    if (!c) throw new BusinessError(404, '结论不存在。');
    if (c.revision !== input.revision || (input.adopted && !c.valid)) throw conflict();
    this.db.prepare('UPDATE conclusions SET adopted=?,revision=revision+1 WHERE space_id=? AND id=?').run(Number(input.adopted), space, id);
    return this.conclusions(space);
  }
  saveAssessmentSpec(space: string, unit: string, input: unknown) {
    const revision = (this.unit(space, unit).assessment?.revision ?? 0) + 1;
    const content = assessmentSpecSchema.parse(input);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO assessment_specs(space_id,unit_id,content,revision) VALUES (?,?,?,?)
        ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content,revision=excluded.revision`).run(space, unit, JSON.stringify(content), revision);
      this.db.prepare('INSERT INTO assessment_versions VALUES (?,?,?,?,NULL,NULL)').run(space, unit, revision, JSON.stringify(content));
    })();
  }
  saveAssessmentResult(space: string, unit: string, revision: number, input: unknown) {
    const result = assessmentResultSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.unit(space, unit);
      if (current.draft.revision !== revision) throw conflict();
      const { q1, q2 } = current.draft;
      const attempt = (current.records[0]?.attempt ?? 0) + 1;
      const id = randomUUID();
      this.db.prepare('INSERT INTO assessments VALUES (?,?,?,?,?,?,?)').run(space, unit, id, attempt, JSON.stringify({ q1, q2 }), JSON.stringify(result), Date.now());
      this.saveAssessmentDraft(space, unit, { revision, q1: '', q2: '' });
      this.db.prepare('UPDATE units SET status=? WHERE space_id=? AND id=?').run(result.result === 'pass' ? 'passed' : 'needs_work', space, unit);
      return this.record(space, id);
    })();
  }
}

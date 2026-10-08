import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assessmentDraftSchema, assessmentResultSchema, assessmentSpecSchema, conclusionDecisionSchema, conclusionSchema, createSessionSchema, createSpaceSchema,
  applyAgentEvent, executionFeedback, idSchema, lessonSchema, messageInputSchema, renameSpaceSchema, researchInputSchema, researchRefSchema, routeContentSchema, saveRequirementSchema, sessionDraftSchema,
  type AgentDisplayPart, type AgentEventData, type AssessmentRecord, type LearningConclusion, type Message, type ResearchRef, type ResearchSaveResult, type SessionDetail, type SessionSummary, type SpaceSummary, type UnitDetail, type Workspace,
} from '@teach-me-coding/contracts';
import { Intake } from './intake.js';

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
    const proposals = this.all<{ id: string; baseRevision: number; requirementRevision: number | null; state: 'pending' | 'applied'; content: string; intake: string | null }>(
      'SELECT id,base_revision AS baseRevision,requirement_revision AS requirementRevision,state,content,intake FROM proposals WHERE space_id=? ORDER BY rowid', id);
    const requirement = { ...req, confirmed: !!req.confirmed, value: JSON.parse(req.value), ...(intake ? { intake: JSON.parse(intake) } : {}) };
    return { ...base, requirement, readiness: this.intake.readiness(id, requirement),
      route: { revision: route.revision, content: route.content === null ? null : JSON.parse(route.content), ...(route.intake ? { intake: JSON.parse(route.intake) } : {}) },
      sessions: this.all('SELECT id,scope,unit_id AS unitId,title FROM sessions WHERE space_id=? ORDER BY rowid', id),
      proposals: proposals.map(({ intake, ...p }) => ({ ...p, content: JSON.parse(p.content), ...(intake ? { intake: JSON.parse(intake) } : {}) })),
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
      this.db.prepare('INSERT INTO requirements(space_id,value) VALUES (?,?)').run(id, JSON.stringify({ goal: '', background: '', outcome: '', schedule: '' }));
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
      const changedScope = v.value.goal !== current.value.goal || v.value.outcome !== current.value.outcome;
      const intake = v.intake === undefined ? changedScope ? null : current.intake : v.intake;
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
      const document = this.intake.prepareResearch(this.intake.nextResearch(space, ref), null, previous.target, value);
      this.intake.saveResearch(space, document);
      this.saveRequirement(space, { ...workspace.requirement, confirmed: false,
        intake: { ...intake, researchRef: { id: document.id, revision: document.revision } } });
      return { document, workspace: this.space(space) };
    })();
  }
  session(space: string, id: string): SessionDetail {
    idSchema.parse(space); idSchema.parse(id);
    // Text, event projection and resume cursor must come from the same snapshot.
    return this.db.transaction(() => {
      const row = this.one<SessionSummary & { revision: number; draft: string }>(
        'SELECT id,scope,unit_id AS unitId,title,revision,draft FROM sessions WHERE space_id=? AND id=?', space, id);
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
      for (const event of events) parts.set(event.runId, applyAgentEvent(parts.get(event.runId) ?? [],
        { runId: event.runId, seq: event.seq, data: JSON.parse(event.value) as AgentEventData }));
      return { id: row.id, scope: row.scope, unitId: row.unitId, title: row.title,
        draft: { ...JSON.parse(row.draft), revision: row.revision },
        messages: messages.map((m) => ({ ...m, quote: m.quote === null ? null : JSON.parse(m.quote),
          ...(parts.has(m.id) ? { parts: parts.get(m.id) } : {}),
        })),
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
    const lesson = this.db.prepare('SELECT content,revision FROM lessons WHERE space_id=? AND unit_id=?').get(space, id) as { content: string; revision: number } | undefined;
    const spec = this.db.prepare('SELECT content,revision FROM assessment_specs WHERE space_id=? AND unit_id=?').get(space, id) as { content: string; revision: number } | undefined;
    const draft = this.db.prepare('SELECT revision,answers FROM assessment_drafts WHERE space_id=? AND unit_id=?').get(space, id) as { revision: number; answers: string } | undefined;
    const records = this.all<{ id: string; unitId: string; attempt: number; answers: string; result: string; createdAt: number }>(
      'SELECT id,unit_id AS unitId,attempt,answers,result,created_at AS createdAt FROM assessments WHERE space_id=? AND unit_id=? ORDER BY attempt DESC', space, id);
    const versions = this.one<{ requirement: number; route: number }>('SELECT r.revision AS requirement,t.revision AS route FROM requirements r JOIN routes t ON t.space_id=r.space_id WHERE r.space_id=?', space);
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
      const valid = ['non-execution', 'execution-verified'].includes(value.verification) && value.specRevision === spec?.revision && value.lessonRevision === (lesson?.revision ?? 0)
        && value.sources?.requirement === versions.requirement && value.sources?.route === versions.route;
      return { ...r, ...value, valid, answers: JSON.parse(answers) };
    });
    // Versioned evidence, unlike legacy imports, must stop driving progress when its sources expire.
    if (evaluated.some((r) => r.verification) && ['passed', 'needs_work'].includes(unit.status)) {
      const current = evaluated.find((r) => r.valid);
      unit.status = current ? current.result === 'pass' ? 'passed' : 'needs_work' : 'learning';
    }
    return { ...unit, lesson: lesson ? { ...JSON.parse(lesson.content), revision: lesson.revision } : null, assessment: spec ? { ...JSON.parse(spec.content), revision: spec.revision } : null,
      nextAttempt: Math.max(submitted.n ?? 0, records[0]?.attempt ?? 0) + 1,
      draft: { unitId: id, revision: draft?.revision ?? 0, ...(draft ? JSON.parse(draft.answers) : { q1: '', q2: '' }) },
      records: evaluated,
    };
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
  proposeRoute(space: string, session: string, input: unknown, baseline?: { requirement: number; route: number }) {
    const content = routeContentSchema.parse(input);
    const current = this.space(space);
    if (!current.requirement.confirmed || this.session(space, session).scope !== 'route') throw new BusinessError(422, '路线提案需要已确认需求及路线会话。');
    this.intake.assertReady(space, current.requirement);
    const base = baseline ?? { requirement: current.requirement.revision, route: current.route.revision };
    if (base.requirement !== current.requirement.revision || base.route !== current.route.revision) throw conflict();
    const ids = content.stages.flatMap((s) => [s.id, ...s.units.map((u) => u.id)]);
    if (new Set(ids).size !== ids.length) throw new BusinessError(422, '路线中的阶段和单元标识不能重复。');
    const id = randomUUID();
    this.db.prepare('INSERT INTO proposals(space_id,id,session_id,base_revision,requirement_revision,content,intake) VALUES (?,?,?,?,?,?,?)')
      .run(space, id, session, base.route, base.requirement, JSON.stringify(content), JSON.stringify(current.requirement.intake));
    return this.space(space).proposals.find((p) => p.id === id)!;
  }
  applyProposal(space: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(() => {
      const current = this.space(space);
      const p = current.proposals.find((p) => p.id === id);
      if (!p) throw new BusinessError(404, '路线提案不存在。');
      if (p.state === 'applied') return current;
      if (!current.requirement.confirmed || p.requirementRevision !== current.requirement.revision || p.baseRevision !== current.route.revision) throw conflict();
      this.intake.assertReady(space, current.requirement);
      const units = p.content.stages.flatMap((s) => s.units);
      const existing = this.all<{ id: string }>('SELECT id FROM units WHERE space_id=?', space);
      if (existing.some((u) => !units.some((v) => v.id === u.id))) throw new BusinessError(409, '提案不能移除已有单元及学习记录。');
      for (const u of units) this.db.prepare('INSERT INTO units(space_id,id) VALUES (?,?) ON CONFLICT DO NOTHING').run(space, u.id);
      this.db.prepare('UPDATE routes SET content=?,intake=?,revision=revision+1 WHERE space_id=?').run(JSON.stringify(p.content), p.intake ? JSON.stringify(p.intake) : null, space);
      this.db.prepare("UPDATE proposals SET state='applied' WHERE space_id=? AND id=?").run(space, id);
      return this.space(space);
    })();
  }
  saveLesson(space: string, unit: string, input: unknown, baseline?: { requirement: number; route: number; lesson: number }) {
    const content = lessonSchema.parse(input);
    return this.db.transaction(() => {
      const revision = this.unit(space, unit).lesson?.revision ?? 0;
      if (baseline) this.checkBaseline(space, unit, baseline);
      this.db.prepare(`INSERT INTO lessons(space_id,unit_id,content,revision) VALUES (?,?,?,?)
        ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content,revision=excluded.revision`).run(space, unit, JSON.stringify(content), revision + 1);
      this.db.prepare('INSERT INTO lesson_versions VALUES (?,?,?,?)').run(space, unit, revision + 1, JSON.stringify(content));
      this.db.prepare("UPDATE units SET status='learning' WHERE space_id=? AND id=? AND status='not_started'").run(space, unit);
      return this.unit(space, unit).lesson!;
    })();
  }
  checkBaseline(space: string, unit: string, baseline: { requirement: number; route: number; lesson: number }) {
    const w = this.space(space), u = this.unit(space, unit);
    if (!w.requirement.confirmed || w.requirement.revision !== baseline.requirement || w.route.revision !== baseline.route || (u.lesson?.revision ?? 0) !== baseline.lesson) throw conflict();
  }
  conclusions(space: string): LearningConclusion[] {
    const rows = this.all<Omit<LearningConclusion, 'sources' | 'adopted' | 'valid'> & { sources: string; adopted: number; valid: number }>(
      `SELECT c.id,c.unit_id AS unitId,c.run_id AS runId,c.text,c.revision,c.adopted,c.sources,
        (r.confirmed=1 AND r.revision=json_extract(c.sources,'$.requirement') AND t.revision=json_extract(c.sources,'$.route')
        AND COALESCE(l.revision,0)=json_extract(c.sources,'$.lesson')) AS valid
        FROM conclusions c JOIN requirements r ON r.space_id=c.space_id JOIN routes t ON t.space_id=c.space_id
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

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assessmentDraftSchema, assessmentResultSchema, assessmentSpecSchema, createSessionSchema, createSpaceSchema,
  idSchema, lessonSchema, messageInputSchema, renameSpaceSchema, routeContentSchema, saveRequirementSchema, sessionDraftSchema,
  type AssessmentRecord, type Message, type SessionDetail, type SessionSummary, type SpaceSummary, type UnitDetail, type Workspace,
} from '@teach-me-coding/contracts';

export class BusinessError extends Error {
  constructor(public status: 400 | 404 | 409 | 413 | 422 | 503, message: string) { super(message); }
}
const conflict = () => new BusinessError(409, '内容已改变，请重新读取后再保存；本次修改未写入。');

export class Learning {
  constructor(readonly db: Database.Database) {}
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
    const req = this.one<{ revision: number; confirmed: number; value: string }>('SELECT revision,confirmed,value FROM requirements WHERE space_id=?', id);
    const route = this.one<{ revision: number; content: string | null }>('SELECT revision,content FROM routes WHERE space_id=?', id);
    const proposals = this.all<{ id: string; baseRevision: number; state: 'pending' | 'applied'; content: string }>(
      'SELECT id,base_revision AS baseRevision,state,content FROM proposals WHERE space_id=? ORDER BY rowid', id);
    return { ...base, requirement: { ...req, confirmed: !!req.confirmed, value: JSON.parse(req.value) },
      route: { revision: route.revision, content: route.content === null ? null : JSON.parse(route.content) },
      sessions: this.all('SELECT id,scope,unit_id AS unitId,title FROM sessions WHERE space_id=? ORDER BY rowid', id),
      proposals: proposals.map((p) => ({ ...p, content: JSON.parse(p.content) })),
      tasks: this.all('SELECT id,unit_id AS unitId,session_id AS sessionId,kind,state FROM tasks WHERE space_id=?', id),
      runs: this.all('SELECT id,unit_id AS unitId,session_id AS sessionId,kind,state FROM runs WHERE space_id=?', id),
    };
  }
  create(input: unknown): Workspace {
    const v = createSpaceSchema.parse(input);
    return this.db.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(id, v.name, Date.now());
      this.db.prepare('INSERT INTO requirements(space_id,value) VALUES (?,?)').run(id, JSON.stringify({ goal: v.goal, background: '', outcome: '', schedule: '' }));
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
    this.space(space);
    const v = saveRequirementSchema.parse(input);
    const result = this.db.prepare('UPDATE requirements SET value=?,confirmed=?,revision=revision+1 WHERE space_id=? AND revision=?')
      .run(JSON.stringify(v.value), Number(v.confirmed), space, v.revision);
    if (!result.changes) throw conflict();
    return this.space(space).requirement;
  }
  session(space: string, id: string): SessionDetail {
    idSchema.parse(space); idSchema.parse(id);
    const row = this.one<SessionSummary & { revision: number; draft: string }>(
      'SELECT id,scope,unit_id AS unitId,title,revision,draft FROM sessions WHERE space_id=? AND id=?', space, id);
    const messages = this.all<Omit<Message, 'quote'> & { quote: string | null }>(
      `SELECT m.id,m.role,m.text,m.quote,m.created_at AS createdAt,
       CASE r.state WHEN 'pending' THEN 'thinking' WHEN 'running' THEN CASE WHEN m.text='' THEN 'thinking' ELSE 'streaming' END
         WHEN 'interrupted' THEN 'stopped' WHEN 'failed' THEN 'error' ELSE 'done' END AS status
       FROM messages m LEFT JOIN runs r ON r.space_id=m.space_id AND r.id=m.id
       WHERE m.space_id=? AND m.session_id=? ORDER BY m.rowid`, space, id);
    return { id: row.id, scope: row.scope, unitId: row.unitId, title: row.title,
      draft: { ...JSON.parse(row.draft), revision: row.revision },
      messages: messages.map((m) => ({ ...m, quote: m.quote === null ? null : JSON.parse(m.quote) })),
    };
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
  addMessage(space: string, id: string, input: unknown) {
    const v = messageInputSchema.parse(input);
    return this.db.transaction(() => {
      const session = this.session(space, id);
      if (session.draft.revision !== v.draftRevision) throw conflict();
      this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(space, id, randomUUID(), 'user', v.text, v.quote ? JSON.stringify(v.quote) : null, Date.now());
      this.saveSessionDraft(space, id, { ...session.draft, text: '', quote: null });
      return this.session(space, id); // No Agent invocation or fabricated reply.
    })();
  }
  unit(space: string, id: string): UnitDetail {
    idSchema.parse(space); idSchema.parse(id);
    const unit = this.one<Pick<UnitDetail, 'id' | 'status'>>('SELECT id,status FROM units WHERE space_id=? AND id=?', space, id);
    const lesson = this.db.prepare('SELECT content FROM lessons WHERE space_id=? AND unit_id=?').get(space, id) as { content: string } | undefined;
    const spec = this.db.prepare('SELECT content FROM assessment_specs WHERE space_id=? AND unit_id=?').get(space, id) as { content: string } | undefined;
    const draft = this.db.prepare('SELECT revision,answers FROM assessment_drafts WHERE space_id=? AND unit_id=?').get(space, id) as { revision: number; answers: string } | undefined;
    const records = this.all<{ id: string; unitId: string; attempt: number; answers: string; result: string; createdAt: number }>(
      'SELECT id,unit_id AS unitId,attempt,answers,result,created_at AS createdAt FROM assessments WHERE space_id=? AND unit_id=? ORDER BY attempt DESC', space, id);
    return { ...unit, lesson: lesson ? JSON.parse(lesson.content) : null, assessment: spec ? JSON.parse(spec.content) : null,
      draft: { unitId: id, revision: draft?.revision ?? 0, ...(draft ? JSON.parse(draft.answers) : { q1: '', q2: '' }) },
      records: records.map(({ result, answers, ...r }) => ({ ...r, ...JSON.parse(result), answers: JSON.parse(answers) })),
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
  proposeRoute(space: string, session: string, input: unknown) {
    const content = routeContentSchema.parse(input);
    const current = this.space(space);
    if (!current.requirement.confirmed || this.session(space, session).scope !== 'route') throw new BusinessError(422, '路线提案需要已确认需求及路线会话。');
    const ids = content.stages.flatMap((s) => [s.id, ...s.units.map((u) => u.id)]);
    if (new Set(ids).size !== ids.length) throw new BusinessError(422, '路线中的阶段和单元标识不能重复。');
    const id = randomUUID();
    this.db.prepare('INSERT INTO proposals(space_id,id,session_id,base_revision,content) VALUES (?,?,?,?,?)')
      .run(space, id, session, current.route.revision, JSON.stringify(content));
    return this.space(space).proposals.find((p) => p.id === id)!;
  }
  applyProposal(space: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(() => {
      const current = this.space(space);
      const p = current.proposals.find((p) => p.id === id);
      if (!p) throw new BusinessError(404, '路线提案不存在。');
      if (p.state === 'applied') return current;
      if (!current.requirement.confirmed || p.baseRevision !== current.route.revision) throw conflict();
      const units = p.content.stages.flatMap((s) => s.units);
      const existing = this.all<{ id: string }>('SELECT id FROM units WHERE space_id=?', space);
      if (existing.some((u) => !units.some((v) => v.id === u.id))) throw new BusinessError(409, '提案不能移除已有单元及学习记录。');
      for (const u of units) this.db.prepare('INSERT INTO units(space_id,id) VALUES (?,?) ON CONFLICT DO NOTHING').run(space, u.id);
      this.db.prepare('UPDATE routes SET content=?,revision=revision+1 WHERE space_id=?').run(JSON.stringify(p.content), space);
      this.db.prepare("UPDATE proposals SET state='applied' WHERE space_id=? AND id=?").run(space, id);
      return this.space(space);
    })();
  }
  saveLesson(space: string, unit: string, input: unknown) {
    this.unit(space, unit);
    const content = lessonSchema.parse(input);
    this.db.prepare('INSERT INTO lessons VALUES (?,?,?) ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content').run(space, unit, JSON.stringify(content));
  }
  saveAssessmentSpec(space: string, unit: string, input: unknown) {
    this.unit(space, unit);
    const content = assessmentSpecSchema.parse(input);
    this.db.prepare('INSERT INTO assessment_specs VALUES (?,?,?) ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content').run(space, unit, JSON.stringify(content));
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

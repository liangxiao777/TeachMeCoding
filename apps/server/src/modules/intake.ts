import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { intakeMetadataSchema, questionAnswerSchema, questionInputSchema, researchInputSchema,
  type IntakeMetadata, type IntakeReadiness, type QuestionRound, type RequirementState, type ResearchDossier, type ResearchRef } from '@teach-me-coding/contracts';
import { BusinessError } from './learning.js';

export class Intake {
  constructor(private db: Database.Database) {}

  research(space: string, ref: ResearchRef): ResearchDossier {
    const row = this.db.prepare('SELECT value FROM research_dossiers WHERE space_id=? AND id=? AND revision=?')
      .get(space, ref.id, ref.revision) as { value: string } | undefined;
    if (!row) throw new BusinessError(404, '所属空间的调研资料版本不存在。');
    return JSON.parse(row.value) as ResearchDossier;
  }
  nextResearch(space: string, previous?: ResearchRef | null): ResearchRef {
    if (!previous) return { id: randomUUID(), revision: 1 };
    this.research(space, previous);
    const row = this.db.prepare('SELECT MAX(revision) AS revision FROM research_dossiers WHERE space_id=? AND id=?')
      .get(space, previous.id) as { revision: number };
    return { id: previous.id, revision: row.revision + 1 };
  }
  prepareResearch(ref: ResearchRef, runId: string | null, raw: unknown): ResearchDossier {
    const value = researchInputSchema.parse(raw);
    return { ...value, ...ref, runId, createdAt: Date.now(),
      hash: createHash('sha256').update(value.content).digest('hex') };
  }
  saveResearch(space: string, value: ResearchDossier) {
    this.db.prepare('INSERT INTO research_dossiers VALUES (?,?,?,?,?)').run(space, value.id, value.revision, value.runId, JSON.stringify(value));
  }
  validateMetadata(space: string, value: IntakeMetadata) {
    intakeMetadataSchema.parse(value);
    if (value.researchRef) this.research(space, value.researchRef);
  }
  readiness(space: string, requirement: RequirementState, checkQuestions = true): IntakeReadiness {
    const reasons: string[] = [];
    if (!requirement.value.rows.some((row) => row.question.trim() && row.answer.trim())) reasons.push('请先整理学习需求。');
    if (requirement.intake) this.validateMetadata(space, requirement.intake);
    if (checkQuestions && this.db.prepare("SELECT 1 FROM intake_questions WHERE space_id=? AND json_extract(value,'$.state')='pending'").get(space)) {
      reasons.push('请回答待确认问题，或修改需求后重新核对。');
    }
    return { ready: reasons.length === 0, reasons };
  }
  assertReady(space: string, requirement: RequirementState, checkQuestions = true) {
    const state = this.readiness(space, requirement, checkQuestions);
    if (!state.ready) throw new BusinessError(422, state.reasons.join(' '));
  }
  questions(space: string, session: string): QuestionRound[] {
    const rows = this.db.prepare('SELECT value FROM intake_questions WHERE space_id=? AND session_id=? ORDER BY rowid')
      .all(space, session) as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as QuestionRound);
  }
  supersede(space: string, session?: string) {
    this.db.prepare(`UPDATE intake_questions SET value=json_set(value,'$.state','superseded') WHERE space_id=?
      AND json_extract(value,'$.state')='pending'${session ? ' AND session_id=?' : ''}`).run(...(session ? [space, session] : [space]));
  }
  prepareQuestions(sessionId: string, runId: string, generationRevision: number, raw: unknown): QuestionRound {
    const value = questionInputSchema.parse(raw);
    for (const question of value.questions) if (new Set(question.options.map((option) => option.label)).size !== question.options.length) {
      throw new BusinessError(422, '问题选项不能重复。');
    }
    return { id: randomUUID(), sessionId, runId, generationRevision, requirementRevision: generationRevision, createdAt: Date.now(),
      state: 'pending', answers: null, questions: value.questions.map((q) => ({ ...q, id: randomUUID(),
        options: q.options.map((o) => ({ ...o, id: randomUUID() })) })) };
  }
  publishQuestions(space: string, value: QuestionRound, revision: number) {
    this.supersede(space, value.sessionId);
    this.db.prepare('INSERT INTO intake_questions VALUES (?,?,?,?,?)').run(space, value.id, value.sessionId, value.runId,
      JSON.stringify({ ...value, requirementRevision: revision }));
  }
  acceptAnswer(space: string, session: string, roundId: string, revision: number, raw: unknown): string {
    const round = this.questions(space, session).find((q) => q.id === roundId);
    if (!round) throw new BusinessError(404, '所属会话的问题不存在。');
    if (round.state !== 'pending' || round.requirementRevision !== revision) throw new BusinessError(409, '问题已回答或需求已改变，请读取最新问题。');
    const { answers } = questionAnswerSchema.parse(raw);
    if (answers.length !== round.questions.length || new Set(answers.map((a) => a.questionId)).size !== answers.length) {
      throw new BusinessError(422, '请回答这一轮的每个问题，不要重复提交。');
    }
    const lines = round.questions.map((q) => {
      const a = answers.find((answer) => answer.questionId === q.id);
      if (!a || new Set(a.optionIds).size !== a.optionIds.length || !a.optionIds.every((id) => q.options.some((o) => o.id === id))
        || (!a.optionIds.length && !a.customText) || (!q.multiple && a.optionIds.length + Number(!!a.customText) !== 1)) {
        throw new BusinessError(422, '回答选项无效；单选只能选择一项或填写自定义回答。');
      }
      return `${q.prompt}\n${[...a.optionIds.map((id) => q.options.find((o) => o.id === id)!.label), ...(a.customText ? [a.customText] : [])].join('；')}`;
    });
    this.db.prepare('UPDATE intake_questions SET value=? WHERE space_id=? AND id=?').run(JSON.stringify({ ...round, state: 'answered', answers }), space, roundId);
    return lines.join('\n\n');
  }
}

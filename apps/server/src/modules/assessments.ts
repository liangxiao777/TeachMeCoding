import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assessmentResultSchema, assessmentSpecSchema, generationInputSchema, type AssessmentSpec, type CodeExecution } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from './learning.js';
import { hash } from '../agents/context.js';

const criterion = z.object({ answer: z.string().min(1).max(6000), criteria: z.array(z.string().min(1).max(1000)).min(1).max(20) }).strict();
export const assessmentArtifactSchema = z.object({ public: assessmentSpecSchema, rubric: z.object({ q1: criterion, q2: criterion }).strict() }).strict();
export const evaluationArtifactSchema = assessmentResultSchema.extend({ result: z.enum(['pass', 'needs_work']) });
export type AssessmentSources = { requirement: number; route: number; lesson: number };
type ExecutionEvidence = { kind: 'none' } | { kind: 'fixture'; status: 'succeeded' | 'failed'; output: string } | { kind: 'local'; execution: CodeExecution };
export interface FixedAssessment {
  revision: number; public: AssessmentSpec; rubric: z.infer<typeof assessmentArtifactSchema>['rubric']; sources: AssessmentSources;
  submission: { id: string; attempt: number; answers: { q1: string; q2: string }; answerHash: string; evidence: ExecutionEvidence; createdAt: number };
}

/** Private assessment versions and immutable submissions. No execution or mutable draft reads during grading. */
export class Assessments {
  constructor(private learning: Learning) {}
  saveSpec(space: string, unit: string, raw: unknown, sources: AssessmentSources, expected: number) {
    const artifact = assessmentArtifactSchema.parse(raw), l = this.learning;
    return l.db.transaction(() => {
      l.checkBaseline(space, unit, sources);
      if ((l.unit(space, unit).assessment?.revision ?? 0) !== expected) throw new BusinessError(409, '题目版本已变化。');
      const revision = expected + 1;
      l.db.prepare(`INSERT INTO assessment_specs(space_id,unit_id,content,revision) VALUES (?,?,?,?)
        ON CONFLICT(space_id,unit_id) DO UPDATE SET content=excluded.content,revision=excluded.revision`).run(space, unit, JSON.stringify(artifact.public), revision);
      l.db.prepare('INSERT INTO assessment_versions VALUES (?,?,?,?,?,?)').run(space, unit, revision, JSON.stringify(artifact.public), JSON.stringify(artifact.rubric), JSON.stringify(sources));
      return l.unit(space, unit).assessment!;
    })();
  }
  submit(space: string, unit: string, raw: unknown, evidence: ExecutionEvidence = { kind: 'none' }): FixedAssessment {
    const input = generationInputSchema.parse(raw), l = this.learning;
    if (input.kind !== 'evaluation') throw new BusinessError(400, '需要测评提交。');
    return l.db.transaction(() => {
      const u = l.unit(space, unit);
      if (u.draft.revision !== input.revision || u.assessment?.revision !== input.specRevision) throw new BusinessError(409, '作答或题目版本已变化，请重新读取。');
      const v = l.db.prepare('SELECT content,rubric,sources FROM assessment_versions WHERE space_id=? AND unit_id=? AND revision=?').get(space, unit, input.specRevision) as { content: string; rubric: string | null; sources: string | null } | undefined;
      if (!v?.rubric || !v.sources) throw new BusinessError(422, '旧题目没有版本化评分标准，请重新生成题目。');
      const sources = JSON.parse(v.sources) as AssessmentSources;
      l.checkBaseline(space, unit, sources);
      const answers = { q1: input.q1, q2: input.q2 };
      if (!answers.q1.trim()) throw new BusinessError(422, '请先作答。');
      const previous = l.db.prepare(`SELECT MAX(attempt) AS n FROM (SELECT attempt FROM assessments WHERE space_id=? AND unit_id=? UNION ALL
        SELECT attempt FROM submissions WHERE space_id=? AND unit_id=?)`).get(space, unit, space, unit) as { n: number | null };
      const submission = { id: randomUUID(), attempt: (previous.n ?? 0) + 1, answers, answerHash: hash(answers), evidence, createdAt: Date.now() };
      l.db.prepare('INSERT INTO submissions VALUES (?,?,?,?,?,?,?,?,?,?)').run(space, unit, submission.id, submission.attempt, input.specRevision, input.revision,
        JSON.stringify(answers), JSON.stringify(evidence), submission.answerHash, submission.createdAt);
      return { revision: input.specRevision, public: JSON.parse(v.content), rubric: JSON.parse(v.rubric), sources, submission };
    })();
  }
  grade(space: string, unit: string, fixed: FixedAssessment, raw: unknown) {
    const proposed = evaluationArtifactSchema.parse(raw), l = this.learning;
    return l.db.transaction(() => {
      // Retry evaluates exactly the same submission; a committed result cannot be replaced.
      if (l.db.prepare('SELECT 1 FROM assessments WHERE space_id=? AND id=?').get(space, fixed.submission.id)) return l.record(space, fixed.submission.id);
      const code = fixed.public.q2Kind === 'code';
      let execution: CodeExecution | undefined;
      if (fixed.submission.evidence.kind === 'local') {
        const row = l.db.prepare('SELECT value FROM code_executions WHERE space_id=? AND id=?').get(space, fixed.submission.evidence.execution.id) as { value: string } | undefined;
        if (row) {
          const value = JSON.parse(row.value) as CodeExecution;
          if (value.unitId === unit && value.submissionId === fixed.submission.id && value.specRevision === fixed.revision
            && value.codeHash === hash(fixed.submission.answers.q2) && hash(value.plan) === hash(fixed.public.execution)) execution = value;
        }
      }
      const checked = execution?.state === 'succeeded' && execution.results.length === execution.plan.cases.length && execution.results.every((r) => r.result.status === 'succeeded');
      const matched = checked && execution?.results.every((r) => r.matches);
      const unverified = code && !checked;
      const verification = !code ? 'non-execution' : checked ? 'execution-verified' : execution || fixed.submission.evidence.kind === 'fixture' && fixed.submission.evidence.status === 'failed' ? 'execution-failed' : 'execution-unverified';
      const result = { ...proposed, result: unverified ? 'unverified' as const : code && !matched ? 'needs_work' as const : proposed.result, verification, execution,
        specRevision: fixed.revision, lessonRevision: fixed.sources.lesson, answerHash: fixed.submission.answerHash,
        sources: fixed.sources, q2Kind: fixed.public.q2Kind,
        mastered: code && !matched ? [] : proposed.mastered,
        summary: unverified ? `代码尚未通过真实执行验证。${execution ? '本机执行未完成或失败，不能据此判定掌握。' : ''}${proposed.summary}` : code && !matched ? `实际输出与测试期望不符。${proposed.summary}` : proposed.summary,
        evidence: [execution ? `执行 ${execution.id}，代码 SHA-256 ${execution.codeHash}；${execution.state}，匹配 ${execution.results.filter((r) => r.matches).length}/${execution.plan.cases.length} 个公开用例。`
          : code ? '只进行了静态模型评估；未运行所提交代码。' : '基于固定题目、rubric 和提交答案的非执行模型评估。', ...proposed.evidence],
        toVerify: unverified ? ['需要完整的真实执行证据；缺工具链请自行配置，不自动安装。', ...proposed.toVerify] : proposed.toVerify };
      l.db.prepare('INSERT INTO assessments VALUES (?,?,?,?,?,?,?)').run(space, unit, fixed.submission.id, fixed.submission.attempt,
        JSON.stringify(fixed.submission.answers), JSON.stringify(result), Date.now());
      const current = l.unit(space, unit), record = current.records.find((r) => r.id === fixed.submission.id)!;
      if (record.valid && current.records[0]?.id === record.id) l.db.prepare('UPDATE units SET status=? WHERE space_id=? AND id=?').run(result.result === 'pass' ? 'passed' : 'needs_work', space, unit);
      // Never clear or read the draft here: it may be a different attempt now.
      return record;
    })();
  }
}

import { z } from 'zod';

export const idSchema = z.string().uuid();
const text = z.string().max(100_000);
const title = z.string().trim().min(1).max(200);
export const provenanceSchema = z.object({ kind: z.enum(['pasted', 'lesson', 'editor-buffer', 'disk', 'terminal', 'assessment', 'legacy']),
  objectId: z.string().max(1000).optional(), version: z.string().max(200).optional(), capturedAt: z.number().optional(),
  range: z.string().max(200).optional(),
}).strict();
export const quoteSchema = z.object({ source: z.enum(['lesson', 'code', 'terminal', 'advice']), label: title, text, provenance: provenanceSchema.optional() }).strict();
export const requirementSchema = z.object({ goal: title, background: text, outcome: text, schedule: text }).strict();
// The opening request is a user message, not the structured requirement's short goal.
export const createSpaceSchema = z.object({ name: title, goal: text.trim().min(1) }).strict();
export const renameSpaceSchema = z.object({ name: title, previousName: z.string().min(1).max(200) }).strict();
export const saveRequirementSchema = z.object({ revision: z.number().int().nonnegative(), value: requirementSchema, confirmed: z.boolean() }).strict();
export const createSessionSchema = z.object({ scope: z.enum(['intake', 'route', 'unit']), unitId: idSchema.nullable(), title }).strict()
  .refine((v) => (v.scope === 'unit') === (v.unitId !== null), 'Unit sessions require a unit; other scopes forbid it');
export const sessionDraftSchema = z.object({ revision: z.number().int().nonnegative(), text, quote: quoteSchema.nullable(), routeSuggestion: text }).strict();
export const messageInputSchema = z.object({ text, quote: quoteSchema.nullable(), draftRevision: z.number().int().nonnegative() }).strict()
  .refine((v) => v.text.trim() || v.quote, 'A message or reference is required');
export const assessmentDraftSchema = z.object({ revision: z.number().int().nonnegative(), q1: text, q2: text }).strict();
export const routeContentSchema = z.object({ note: text, stages: z.array(z.object({
  id: idSchema, title, units: z.array(z.object({ id: idSchema, title, summary: text, goals: z.array(title).max(30) }).strict()).min(1).max(100),
}).strict()).min(1).max(30) }).strict();
export const lessonBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('h2'), id: title, text }).strict(),
  z.object({ type: z.literal('p'), text }).strict(),
  z.object({ type: z.literal('markdown'), text }).strict(),
  z.object({ type: z.literal('list'), items: z.array(text).max(50) }).strict(),
  z.object({ type: z.literal('code'), file: title, language: title, code: text, caption: text.optional() }).strict(),
  z.object({ type: z.literal('callout'), title, text }).strict(),
  z.object({ type: z.literal('practice'), items: z.array(text).max(50) }).strict(),
]);
export const structuredLessonSchema = z.object({ title, intro: text, blocks: z.array(lessonBlockSchema).min(1).max(100) }).strict();
export const lessonSchema = z.object({ title, content: text.default(''), intro: text.optional(), blocks: z.array(lessonBlockSchema).optional() }).strict();
export const conclusionSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export const conclusionDecisionSchema = z.object({ revision: z.number().int().nonnegative(), adopted: z.boolean() }).strict();
export const generationInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['lesson', 'assessment']), revision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('evaluation'), revision: z.number().int().nonnegative(), specRevision: z.number().int().positive(), q1: text, q2: text }).strict(),
]);
export const assessmentSpecSchema = z.object({ q1: title, q2: text, starter: text, q2Kind: z.enum(['code', 'reasoning']).default('code') }).strict();
export const assessmentResultSchema = z.object({ result: z.enum(['pass', 'needs_work', 'unverified']), summary: text,
  mastered: z.array(text).max(100), concerns: z.array(text).max(100), evidence: z.array(text).max(100), toVerify: z.array(text).max(100),
}).strict();

export type Quote = z.infer<typeof quoteSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type RouteContent = z.infer<typeof routeContentSchema>;
export type Lesson = z.infer<typeof lessonSchema> & { revision?: number };
export type AssessmentSpec = z.infer<typeof assessmentSpecSchema> & { revision?: number };
export interface SpaceSummary { id: string; name: string; createdAt: number }
export interface RequirementState { revision: number; confirmed: boolean; value: Requirement }
export interface SessionSummary { id: string; scope: 'intake' | 'route' | 'unit'; unitId: string | null; title: string }
export interface Message { id: string; role: 'user' | 'agent'; text: string; quote: Quote | null; createdAt: number; sequence?: number; status?: 'thinking' | 'streaming' | 'done' | 'stopped' | 'error' }
export interface SessionDetail extends SessionSummary { draft: z.infer<typeof sessionDraftSchema>; messages: Message[] }
export interface AssessmentDraft extends z.infer<typeof assessmentDraftSchema> { unitId: string }
export interface AssessmentRecord extends z.infer<typeof assessmentResultSchema> { id: string; unitId: string; attempt: number; answers: { q1: string; q2: string }; createdAt: number;
  valid?: boolean; verification?: 'non-execution' | 'execution-unverified' | 'execution-failed'; specRevision?: number; lessonRevision?: number; answerHash?: string; q2Kind?: 'code' | 'reasoning' }
export interface Proposal { id: string; baseRevision: number; requirementRevision: number | null; state: 'pending' | 'applied'; content: RouteContent }
export interface WorkStatus { id: string; unitId: string | null; sessionId: string | null; kind: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted' }
export interface AgentRun extends WorkStatus { error: string | null; cancelled: boolean; createdAt: number; resultId?: string | null }
export type AgentEventData = { type: 'state'; state: WorkStatus['state']; error: string | null }
  | { type: 'text'; delta: string } | { type: 'tool'; name: string; phase: 'start' | 'end'; failed?: boolean };
export interface RunEvent { runId: string; seq: number; data: AgentEventData }
export interface RunEvents { run: AgentRun; events: RunEvent[] }
export interface RunSubmission { run: AgentRun; session: SessionDetail }
export interface LearningConclusion { id: string; unitId: string; runId: string; text: string; revision: number; adopted: boolean; valid: boolean; sources: { requirement: number; route: number; lesson: number } }
export interface Workspace extends SpaceSummary {
  requirement: RequirementState;
  route: { revision: number; content: RouteContent | null };
  sessions: SessionSummary[];
  proposals: Proposal[];
  tasks: WorkStatus[];
  runs: WorkStatus[];
  conclusions: LearningConclusion[];
}
export interface UnitDetail {
  id: string; status: 'not_started' | 'learning' | 'needs_work' | 'passed' | 'skipped';
  lesson: Lesson | null; assessment: AssessmentSpec | null; draft: AssessmentDraft;
  records: AssessmentRecord[];
  nextAttempt?: number;
}
export interface ProjectEntry { path: string; kind: 'file' | 'directory'; version: string }
export interface ProjectFile { path: string; content: string; version: string }
export const createEntrySchema = z.object({ path: z.string().min(1).max(1000), kind: z.enum(['file', 'directory']) }).strict();
export const saveFileSchema = z.object({ path: z.string().min(1).max(1000), version: z.string().min(1), content: z.string().max(1_000_000) }).strict();
export const renameEntrySchema = z.object({ path: z.string().min(1).max(1000), destination: z.string().min(1).max(1000), version: z.string().min(1) }).strict();

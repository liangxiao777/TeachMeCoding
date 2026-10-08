import { z } from 'zod';
import { codePlanSchema, type CodeExecution } from './execution.js';
import { intakeMetadataSchema, type IntakeMetadata, type IntakeReadiness, type QuestionRound, type ResearchDossier } from './intake.js';

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
export const saveRequirementSchema = z.object({ revision: z.number().int().nonnegative(), value: requirementSchema, confirmed: z.boolean(),
  intake: intakeMetadataSchema.nullable().optional() }).strict();
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
  z.object({ kind: z.literal('evaluation'), revision: z.number().int().nonnegative(), specRevision: z.number().int().positive(), q1: text, q2: text, execute: z.boolean().optional() }).strict(),
]);
export const assessmentSpecSchema = z.object({ q1: title, q2: text, starter: text, q2Kind: z.enum(['code', 'reasoning']).default('code'), execution: codePlanSchema.optional() }).strict();
export const assessmentResultSchema = z.object({ result: z.enum(['pass', 'needs_work', 'unverified']), summary: text,
  mastered: z.array(text).max(100), concerns: z.array(text).max(100), evidence: z.array(text).max(100), toVerify: z.array(text).max(100),
}).strict();

export type Quote = z.infer<typeof quoteSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type RouteContent = z.infer<typeof routeContentSchema>;
export type Lesson = z.infer<typeof lessonSchema> & { revision?: number };
export type AssessmentSpec = z.infer<typeof assessmentSpecSchema> & { revision?: number };
export interface SpaceSummary { id: string; name: string; createdAt: number }
export interface RequirementState { revision: number; confirmed: boolean; value: Requirement; intake?: IntakeMetadata | null }
export interface SessionSummary { id: string; scope: 'intake' | 'route' | 'unit'; unitId: string | null; title: string }
export type AgentDisplayPart = { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string; status: 'streaming' | 'done' | 'interrupted' }
  | { type: 'tool'; id: string; name: string; input?: unknown; inputText?: string; status: 'generating' | 'ready' | 'running' | 'done' | 'error' | 'interrupted' };
export interface Message { id: string; role: 'user' | 'agent'; text: string; quote: Quote | null; createdAt: number; parts?: AgentDisplayPart[]; sequence?: number; status?: 'thinking' | 'streaming' | 'done' | 'stopped' | 'error' }
export interface SessionDetail extends SessionSummary { draft: z.infer<typeof sessionDraftSchema>; messages: Message[]; questions?: QuestionRound[] }
export interface AssessmentDraft extends z.infer<typeof assessmentDraftSchema> { unitId: string }
export interface AssessmentRecord extends z.infer<typeof assessmentResultSchema> { id: string; unitId: string; attempt: number; answers: { q1: string; q2: string }; createdAt: number;
  valid?: boolean; verification?: 'non-execution' | 'execution-unverified' | 'execution-failed' | 'execution-verified'; execution?: CodeExecution; specRevision?: number; lessonRevision?: number; answerHash?: string; q2Kind?: 'code' | 'reasoning' }
export interface Proposal { id: string; baseRevision: number; requirementRevision: number | null; state: 'pending' | 'applied'; content: RouteContent; intake?: IntakeMetadata | null }
export interface WorkStatus { id: string; unitId: string | null; sessionId: string | null; kind: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted' }
export interface AgentRun extends WorkStatus { error: string | null; cancelled: boolean; createdAt: number; resultId?: string | null }
export type AgentEventData = { type: 'state'; state: WorkStatus['state']; error: string | null }
  | { type: 'text'; delta: string; partId?: string }
  | { type: 'reasoning'; partId: string; phase: 'start' | 'delta' | 'end'; delta?: string }
  | { type: 'tool'; name: string; phase: 'input' | 'ready' | 'start' | 'end'; input?: unknown; inputDelta?: string; failed?: boolean; callId?: string };
export interface RunEvent { runId: string; seq: number; data: AgentEventData }
export interface RunEvents { run: AgentRun; events: RunEvent[] }
export interface RunSubmission { run: AgentRun; session: SessionDetail }

// One run's ordered display projection. Callers discard seq <= their saved cursor
// before applying events; hydration starts empty, never from Message.text.
export function applyAgentEvent(parts: readonly AgentDisplayPart[], event: RunEvent): AgentDisplayPart[] {
  const { data, runId, seq } = event;
  if (data.type === 'state') {
    return parts.map((part) => ['succeeded', 'failed', 'interrupted'].includes(data.state)
      && ((part.type === 'reasoning' && part.status === 'streaming') || (part.type === 'tool' && ['generating', 'ready', 'running'].includes(part.status)))
      ? { ...part, status: 'interrupted' } : part);
  }
  const last = parts.at(-1);
  if (data.type === 'text') {
    const id = data.partId ?? (last?.type === 'text' && last.id.startsWith(`${runId}:legacy-text:`) ? last.id : `${runId}:legacy-text:${seq}`);
    const existing = parts.find((part) => part.type === 'text' && part.id === id);
    return existing?.type === 'text' ? parts.map((part) => part === existing ? { ...existing, text: existing.text + data.delta } : part)
      : [...parts, { type: 'text', id, text: data.delta }];
  }
  if (data.type === 'reasoning') {
    const existing = parts.find((part) => part.type === 'reasoning' && part.id === data.partId);
    const part: AgentDisplayPart = { type: 'reasoning', id: data.partId,
      text: (existing?.type === 'reasoning' ? existing.text : '') + (data.phase === 'delta' ? data.delta ?? '' : ''),
      status: data.phase === 'end' ? 'done' : existing?.type === 'reasoning' ? existing.status : 'streaming' };
    return existing ? parts.map((p) => p === existing ? part : p) : [...parts, part];
  }
  // Legacy events lack call IDs; match the most recent unfinished call by name.
  const existing = data.callId ? parts.find((part) => part.type === 'tool' && part.id === data.callId)
    : data.phase === 'end' ? parts.findLast((part) => part.type === 'tool' && part.name === data.name && part.status === 'running') : undefined;
  const part: AgentDisplayPart = { ...existing, type: 'tool', id: data.callId ?? existing?.id ?? `${runId}:legacy-tool:${seq}`,
    ...(data.inputDelta !== undefined ? { inputText: (existing?.type === 'tool' ? existing.inputText ?? '' : '') + data.inputDelta } : {}),
    ...(data.input !== undefined ? { input: structuredClone(data.input) } : {}),
    name: data.name, status: data.phase === 'input' ? 'generating' : data.phase === 'ready' ? 'ready' : data.phase === 'end' ? data.failed ? 'error' : 'done' : 'running' };
  if (data.input !== undefined) delete part.inputText;
  return existing ? parts.map((p) => p === existing ? part : p) : [...parts, part];
}

export interface LearningConclusion { id: string; unitId: string; runId: string; text: string; revision: number; adopted: boolean; valid: boolean; sources: { requirement: number; route: number; lesson: number } }
export interface Workspace extends SpaceSummary {
  requirement: RequirementState;
  readiness?: IntakeReadiness;
  route: { revision: number; content: RouteContent | null; intake?: IntakeMetadata | null };
  sessions: SessionSummary[];
  proposals: Proposal[];
  tasks: WorkStatus[];
  runs: WorkStatus[];
  conclusions: LearningConclusion[];
}
export interface ResearchSaveResult { document: ResearchDossier; workspace: Workspace }
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

import { z } from 'zod';

const id = z.string().uuid();
const label = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(10_000);
export const learningTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), name: label, scope: text }).strict(),
  z.object({ kind: z.literal('technology'), name: label, scope: text,
    version: label.refine((v) => !/^(latest|current|stable|最新版?|当前版本|稳定版)$/i.test(v), 'Use a concrete applicable version') }).strict(),
]);
export const researchRefSchema = z.object({ id, revision: z.number().int().positive() }).strict();
export const intakeMetadataSchema = z.object({ target: learningTargetSchema, researchRef: researchRefSchema.nullable() }).strict();
export const researchInputSchema = z.object({
  content: z.string().refine((value) => value.trim().length > 0, 'Write a non-empty Markdown document'),
}).strict();

export const questionInputSchema = z.object({ questions: z.array(z.object({ prompt: text,
  multiple: z.boolean(), options: z.array(z.object({ label, description: z.string().max(2000) }).strict()).min(2).max(4),
}).strict()).min(1).max(4) }).strict();
export const questionAnswerSchema = z.object({ answers: z.array(z.object({ questionId: id,
  optionIds: z.array(id).max(4), customText: z.string().trim().max(10_000),
}).strict()).min(1).max(4) }).strict();

export type LearningTarget = z.infer<typeof learningTargetSchema>;
export type ResearchRef = z.infer<typeof researchRefSchema>;
export type IntakeMetadata = z.infer<typeof intakeMetadataSchema>;
export type ResearchInput = z.infer<typeof researchInputSchema>;
export interface ResearchDossier extends ResearchInput, ResearchRef {
  target: LearningTarget; runId: string | null; createdAt: number; hash: string;
}
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export interface QuestionRound {
  id: string; sessionId: string; runId: string; generationRevision: number; requirementRevision: number; createdAt: number;
  state: 'pending' | 'answered' | 'superseded';
  questions: (Omit<QuestionInput['questions'][number], 'options'> & { id: string;
    options: (QuestionInput['questions'][number]['options'][number] & { id: string })[] })[];
  answers: QuestionAnswer['answers'] | null;
}
export interface IntakeReadiness { ready: boolean; reasons: string[] }

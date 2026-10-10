import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Message, Tool } from '@earendil-works/pi-ai';
import type { ActionProposal, AssessmentRecord, AssessmentSpec, LearningConclusion, ModelSelection, QuestionRound, Quote, RequirementState, ResearchDossier, RouteContent, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import type { FixedAssessment } from '../modules/assessments.js';
import type { LessonReference } from '../modules/learning.js';

export type Scenario = 'intake' | 'roadmap' | 'tutor' | 'lesson' | 'assessment' | 'evaluation';
export interface FrozenContext {
  spaceId: string;
  sessionId: string | null;
  unitId: string | null;
  scenario: Scenario;
  /** Model choice frozen when the run was created; absent on runs from before settings existed. */
  model?: ModelSelection;
  requirement: RequirementState;
  route: Workspace['route'] | null;
  unit: RouteContent['stages'][number]['units'][number] | null;
  lesson: UnitDetail['lesson'];
  /** Published versions at task creation; bodies are read on demand, never from latest. */
  lessonRefs?: LessonReference[];
  references: Quote[];
  conclusions?: LearningConclusion[];
  publicAssessment?: AssessmentSpec | null;
  assessmentRevision?: number;
  evaluation?: FixedAssessment;
  evidence?: AssessmentRecord[];
  actions?: ActionProposal[];
  research?: ResearchDossier | null;
  questions?: QuestionRound[];
}
export interface HistoryGroup { id: string; messages: Message[] }
export const contextVersion = '1';
export const compilerVersion = '11';
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function xmlText(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/gu, '�')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
const resource = (name: string) => {
  const value = readFileSync(new URL(`./prompts/${name}.xml`, import.meta.url), 'utf8').trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('Prompt resources cannot declare entities or DTDs.');
  return value;
};
export function systemPrompt(scenario: Scenario) {
  return `<teaching schemaVersion="1">${resource('teaching')}<scenario>${scenario}</scenario>${resource(scenario)}</teaching>`;
}

export function compileContext(input: FrozenContext) {
  const sources = input.evaluation ? [{ kind: 'fixed-evaluation', id: input.evaluation.submission.id, revision: input.evaluation.revision, value: input.evaluation }] : [
    { kind: 'requirement', id: input.spaceId, revision: input.requirement.revision, value: input.requirement },
    ...(input.research ? [{ kind: 'research-dossier', id: input.research.id, revision: input.research.revision, value: input.research }] : []),
    ...(input.questions ?? []).map((value) => ({ kind: 'intake-question', id: value.id, revision: hash(value), value })),
    ...(input.route && input.scenario !== 'lesson' ? [{ kind: 'route', id: input.spaceId, revision: input.route.revision, value: input.route }] : []),
    ...(input.unit ? [{ kind: 'unit', id: input.unit.id, revision: input.route?.revision ?? 0, value: input.unit }] : []),
    ...(input.lesson ? [{ kind: 'lesson', id: input.unitId!, revision: hash(input.lesson), value: input.lesson }] : []),
    ...(input.conclusions ?? []).map((value) => ({ kind: 'adopted-conclusion', id: value.id, revision: value.revision, value })),
    ...(input.evidence ?? []).map((value) => ({ kind: 'valid-assessment', id: value.id, revision: value.specRevision ?? 0, value })),
    ...(input.actions ?? []).map((value) => ({ kind: 'local-action', id: value.id, revision: hash(value), value })),
    ...(input.publicAssessment ? [{ kind: 'public-assessment', id: input.unitId!, revision: input.publicAssessment.revision ?? 0, value: input.publicAssessment }] : []),
    ...input.references.map((value, index) => ({ kind: 'reference', id: `${input.sessionId}:${index}`, revision: hash(value), value })),
  ];
  const xml = `<context schemaVersion="${contextVersion}" scenario="${input.scenario}"><scope spaceId="${xmlText(input.spaceId)}" sessionId="${xmlText(input.sessionId ?? '')}" unitId="${xmlText(input.unitId ?? '')}" />${sources.map((s) =>
    `<source kind="${s.kind}" id="${xmlText(s.id)}" revision="${xmlText(String(s.revision))}" hash="${hash(s.value)}">${xmlText(s.kind === 'research-dossier' ? (s.value as ResearchDossier).content : JSON.stringify(s.value))}</source>`).join('')}</context>`;
  return { xml, sources: sources.map(({ value, ...s }) => ({ ...s, hash: hash(value) })) };
}

export function compileRequest(input: FrozenContext, history: HistoryGroup[], current: Message[], tools: Tool[], skillPrompt = '') {
  const { xml, sources } = compileContext(input);
  const prompt = systemPrompt(input.scenario).replace('</teaching>', () => `${skillPrompt}</teaching>`);
  const prefix: Message[] = [
    { role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 },
    { role: 'user', content: xml, timestamp: 0 },
  ];
  // Rebuild system/tool declarations once. Failed attempts remain in raw history,
  // but not in this request or later requests from a successfully recovered run.
  const project = (messages: Message[]) => messages.filter((m) => m.role !== 'system' &&
    !(m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted')));
  const active = project(current);
  const previous = history.map((group) => ({ ...group, messages: project(group.messages) }));
  return { messages: structuredClone([...prefix, ...previous.flatMap((g) => g.messages), ...active]),
    manifest: { schemaVersion: contextVersion, compilerVersion, promptHash: hash(prompt), contextHash: hash(xml),
      sources, selectedHistory: previous.map((g) => ({ id: g.id, hash: hash(g.messages) })),
      budget: { reasoning: input.model?.thinkingLevel ?? null },
      retention: 'tool bodies omitted; explicit references retained' },
  };
}

export function retainedMessage(message: Message): Message {
  const copy = structuredClone(message);
  if (copy.role === 'toolResult') {
    return { role: 'toolResult', toolCallId: copy.toolCallId, toolName: copy.toolName, timestamp: copy.timestamp,
      isError: copy.isError, content: [{ type: 'text', text: `[tool body omitted by retention policy; hash=${hash(copy.content)}; bytes=${Buffer.byteLength(JSON.stringify(copy.content), 'utf8')}]` }] };
  }
  if (copy.role === 'assistant') {
    // Native thinking (including opaque signatures/redaction markers) is needed
    // for provider continuation. It is not the browser display projection.
    delete copy.errorMessage; // Provider diagnostics can contain request data; show a product error instead.
  }
  return copy;
}

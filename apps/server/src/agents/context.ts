import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Message, Tool } from '@earendil-works/pi-ai';
import type { AssessmentRecord, AssessmentSpec, LearningConclusion, Quote, RequirementState, RouteContent, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import type { FixedAssessment } from '../modules/assessments.js';

export type Scenario = 'intake' | 'roadmap' | 'tutor' | 'lesson' | 'assessment' | 'evaluation';
export interface FrozenContext {
  spaceId: string;
  sessionId: string | null;
  unitId: string | null;
  scenario: Scenario;
  requirement: RequirementState;
  route: Workspace['route'] | null;
  unit: RouteContent['stages'][number]['units'][number] | null;
  lesson: UnitDetail['lesson'];
  references: Quote[];
  conclusions?: LearningConclusion[];
  publicAssessment?: AssessmentSpec | null;
  assessmentRevision?: number;
  evaluation?: FixedAssessment;
  evidence?: AssessmentRecord[];
}
export interface HistoryGroup { id: string; messages: Message[] }
export const contextVersion = '1';
export const compilerVersion = '3';
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const budget = { reasoning: 'high' as const, milliseconds: 300_000 };

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
    ...(input.route ? [{ kind: 'route', id: input.spaceId, revision: input.route.revision, value: input.route }] : []),
    ...(input.unit ? [{ kind: 'unit', id: input.unit.id, revision: input.route?.revision ?? 0, value: input.unit }] : []),
    ...(input.lesson ? [{ kind: 'lesson', id: input.unitId!, revision: hash(input.lesson), value: input.lesson }] : []),
    ...(input.conclusions ?? []).map((value) => ({ kind: 'adopted-conclusion', id: value.id, revision: value.revision, value })),
    ...(input.evidence ?? []).map((value) => ({ kind: 'valid-assessment', id: value.id, revision: value.specRevision ?? 0, value })),
    ...(input.publicAssessment ? [{ kind: 'public-assessment', id: input.unitId!, revision: input.publicAssessment.revision ?? 0, value: input.publicAssessment }] : []),
    ...input.references.map((value, index) => ({ kind: 'reference', id: `${input.sessionId}:${index}`, revision: hash(value), value })),
  ];
  const xml = `<context schemaVersion="${contextVersion}" scenario="${input.scenario}"><scope spaceId="${xmlText(input.spaceId)}" sessionId="${xmlText(input.sessionId ?? '')}" unitId="${xmlText(input.unitId ?? '')}" />${sources.map((s) =>
    `<source kind="${s.kind}" id="${xmlText(s.id)}" revision="${xmlText(String(s.revision))}" hash="${hash(s.value)}">${xmlText(JSON.stringify(s.value))}</source>`).join('')}</context>`;
  return { xml, sources: sources.map(({ value, ...s }) => ({ ...s, hash: hash(value) })) };
}

export function compileRequest(input: FrozenContext, history: HistoryGroup[], current: Message[], tools: Tool[]) {
  const { xml, sources } = compileContext(input);
  const prompt = systemPrompt(input.scenario);
  const prefix: Message[] = [
    { role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 },
    { role: 'user', content: xml, timestamp: 0 },
  ];
  // System messages are rebuilt once. Never allow a saved system/tool patch to win.
  const active = current.filter((m) => m.role !== 'system');
  const previous = history.map((group) => ({ ...group, messages: group.messages.filter((m) => m.role !== 'system') }));
  return { messages: structuredClone([...prefix, ...previous.flatMap((g) => g.messages), ...active]),
    manifest: { schemaVersion: contextVersion, compilerVersion, promptHash: hash(prompt), contextHash: hash(xml),
      sources, selectedHistory: previous.map((g) => ({ id: g.id, hash: hash(g.messages) })),
      budget: { ...budget }, retention: 'tool bodies omitted; explicit references retained' },
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

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
export const compilerVersion = '1';
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Conservative byte upper estimate, not a model tokenizer or provider usage report.
export const estimateTokens = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const budget = { total: 32_768, output: 4096, reasoning: 0, requests: 6, tools: 12, outputTotal: 12_288, milliseconds: 120_000 };
export class ContextLimit extends Error {}

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

export function compileRequest(input: FrozenContext, history: HistoryGroup[], current: Message[], tools: Tool[], limit = budget.total) {
  const { xml, sources } = compileContext(input);
  const prompt = systemPrompt(input.scenario);
  const prefix: Message[] = [
    { role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 },
    { role: 'user', content: xml, timestamp: 0 },
  ];
  // System messages are rebuilt once. Never allow a saved system/tool patch to win.
  const active = structuredClone(current.filter((m) => m.role !== 'system'));
  const selected: HistoryGroup[] = [];
  const omitted: { id: string; reason: string }[] = [];
  const count = (groups: HistoryGroup[]) => estimateTokens([...prefix, ...groups.flatMap((g) => g.messages), ...active]) + budget.output + 1024;
  if (count([]) > limit) throw new ContextLimit('当前问题、引用或工具结果超出上下文预算；请缩小材料范围后重试。');
  for (const group of [...history].reverse()) {
    const clean = { ...group, messages: group.messages.filter((m) => m.role !== 'system') };
    if (count([clean, ...selected]) <= limit) selected.unshift(clean);
    else omitted.push({ id: group.id, reason: 'whole-turn-budget' });
  }
  return { messages: structuredClone([...prefix, ...selected.flatMap((g) => g.messages), ...active]),
    manifest: { schemaVersion: contextVersion, compilerVersion, promptHash: hash(prompt), contextHash: hash(xml),
      sources, selectedHistory: selected.map((g) => ({ id: g.id, hash: hash(g.messages) })), omitted,
      estimatedTokens: count(selected) - budget.output, estimation: 'utf8-bytes-upper-estimate',
      budget: { ...budget, total: limit }, retention: 'tool bodies omitted; explicit references retained' },
  };
}

export function retainedMessage(message: Message): Message {
  const copy = structuredClone(message);
  if (copy.role === 'toolResult') {
    return { role: 'toolResult', toolCallId: copy.toolCallId, toolName: copy.toolName, timestamp: copy.timestamp,
      isError: copy.isError, content: [{ type: 'text', text: `[tool body omitted by retention policy; hash=${hash(copy.content)}; bytes=${estimateTokens(copy.content)}]` }] };
  }
  if (copy.role === 'assistant') {
    copy.content = copy.content.filter((part) => part.type !== 'thinking');
    delete copy.errorMessage; // Provider diagnostics can contain request data; show a product error instead.
  }
  return copy;
}

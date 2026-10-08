import { Type } from '@earendil-works/pi-ai';
import { intakeMetadataSchema, questionInputSchema, requirementSchema, researchInputSchema,
  type IntakeMetadata, type QuestionRound, type ResearchInput } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';

// Document references belong to the host, not to model-written requirements.
const draftSchema = requirementSchema.extend({ intake: intakeMetadataSchema.omit({ researchRef: true }).loose().nullable().optional() });

export function createIntakeTools(learning: Learning, input: FrozenContext, runId: string): ScenarioRun {
  let draft: ReturnType<typeof draftSchema.parse> | undefined, questions: QuestionRound | undefined, research: ResearchInput | undefined;
  return {
    tools: [
      { name: 'ask_user_question', label: '确认学习需求',
        description: 'Stage one round of relevant questions with 2–4 balanced options each. Usually ask 1–2 questions. The host always allows custom text. End this run normally to publish them; an answer starts a new run. Never ask for information already provided.',
        parameters: Type.Unsafe(JSON.parse(JSON.stringify(questionInputSchema.toJSONSchema()))),
        async execute(_id, args) {
          questions = learning.intake.prepareQuestions(input.sessionId!, runId, input.requirement.revision, args);
          return { content: [{ type: 'text', text: JSON.stringify({ roundId: questions.id, staged: true,
            instruction: '问题已暂存；请正常结束本轮，由用户回答后再继续。' }) }], details: {} };
        } },
      { name: 'write_research_document', label: '记录调研资料',
        description: 'Write the current learning space’s research document as Markdown. Pass only content, the complete document; a later call replaces the staged content. Organize it naturally for roadmap and lesson authors: explain what the technology is, its applicable version, the user’s learning scope, necessary background and important limitations. Distinguish documented facts from your recommendations and unresolved questions. Summarize in your own words and include relevant source URLs as ordinary Markdown links; do not invent sources or copy whole pages. No fixed headings, source IDs or verbatim quotations are required. If an uncertainty would change the roadmap, explain it and ask the user rather than claim it is resolved. Update the requirement draft when the learning target changes; the host handles document references and versions. End this run normally to publish the document; it is only staged until then.',
        parameters: Type.Unsafe(JSON.parse(JSON.stringify(researchInputSchema.toJSONSchema()))),
        async execute(_id, args) {
          research = researchInputSchema.parse(args);
          return { content: [{ type: 'text', text: 'Markdown 调研资料已暂存；正常结束本轮后发布。' }], details: {} };
        } },
      { name: 'submit_requirement_draft', label: '整理需求草稿',
        description: 'Stage the complete editable requirement and its target: concept or a technology with a concrete version and scope. The host automatically associates research documents; do not supply document IDs or references. Write or update the research document when the target changes. Never confirms the requirement. Unknown optional fields may be empty.',
        parameters: Type.Unsafe(JSON.parse(JSON.stringify(draftSchema.toJSONSchema()))),
        async execute(_id, args) {
          draft = draftSchema.parse(args);
          return { content: [{ type: 'text', text: '草稿已暂存；成功结束后仍需用户核对和确认。' }], details: {} };
        } },
    ],
    commit() {
      if (learning.space(input.spaceId).requirement.revision !== input.requirement.revision) throw new BusinessError(409, '需求已改变，本轮问题和资料未发布。');
      if (draft || research) {
        const { intake: metadata = input.requirement.intake, ...value } = draft ?? { ...input.requirement.value, intake: input.requirement.intake };
        let intake: IntakeMetadata | null | undefined = metadata ? { target: metadata.target, researchRef: null } : metadata;
        if (research) {
          if (!intake) throw new BusinessError(422, '请在需求草稿中说明调研资料对应的学习对象和范围。');
          const document = learning.intake.prepareResearch(learning.intake.nextResearch(input.spaceId, input.requirement.intake?.researchRef), runId, intake.target, research);
          learning.intake.saveResearch(input.spaceId, document);
          intake = { target: intake.target, researchRef: { id: document.id, revision: document.revision } };
        } else if (intake && input.research && JSON.stringify(intake.target) === JSON.stringify(input.research.target)) {
          intake.researchRef = input.requirement.intake?.researchRef ?? null;
        }
        learning.saveRequirement(input.spaceId, { revision: input.requirement.revision, value, intake, confirmed: false });
      }
      if (questions) learning.intake.publishQuestions(input.spaceId, questions, learning.space(input.spaceId).requirement.revision);
    },
  };
}

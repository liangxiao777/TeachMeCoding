import { Type } from '@earendil-works/pi-ai';
import { questionInputSchema, requirementSchema, researchInputSchema,
  type QuestionRound, type ResearchInput } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';

export function createIntakeTools(learning: Learning, input: FrozenContext, runId: string): ScenarioRun {
  let draft: ReturnType<typeof requirementSchema.parse> | undefined, questions: QuestionRound | undefined, research: ResearchInput | undefined;
  return {
    tools: [
      { name: 'ask_user_question', label: '确认学习需求',
        description: 'Stage one round of questions. Each question asks about exactly one thing, with 2–4 distinct options that answer that one thing, never combinations of several attributes. Include only independent questions needed now; ask follow-ups that depend on an answer in a later round. The host always allows custom text. End this run normally to publish them; an answer starts a new run. Never ask for information already provided.',
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
        description: 'Write the complete editable learning-requirement table as rows of question and answer. Choose useful questions from the conversation; there is no fixed checklist, required wording, category or separate version field. Preserve the user’s answers, goals, important preferences and corrections in their own words and concrete details, without inventing missing information. Do not present your own inferences or suggestions as the user’s answers, or add rows only for the user to fill in. The host associates the whole table with its research document; do not supply IDs, references or row metadata. Update that document when it no longer supports the agreed learning needs. A later call replaces the staged table. Never confirms the requirement for the user.',
        parameters: Type.Unsafe(JSON.parse(JSON.stringify(requirementSchema.toJSONSchema()))),
        async execute(_id, args) {
          draft = requirementSchema.parse(args);
          return { content: [{ type: 'text', text: '草稿已暂存；成功结束后仍需用户核对和确认。' }], details: {} };
        } },
    ],
    commit() {
      if (learning.space(input.spaceId).requirement.revision !== input.requirement.revision) throw new BusinessError(409, '需求已改变，本轮问题和资料未发布。');
      if (draft || research) {
        let intake = input.requirement.intake;
        if (research) {
          const document = learning.intake.prepareResearch(learning.intake.nextResearch(input.spaceId, intake?.researchRef), runId, research);
          learning.intake.saveResearch(input.spaceId, document);
          intake = { researchRef: { id: document.id, revision: document.revision } };
        }
        learning.saveRequirement(input.spaceId, { revision: input.requirement.revision, value: draft ?? input.requirement.value, intake, confirmed: false });
      }
      if (questions) learning.intake.publishQuestions(input.spaceId, questions, learning.space(input.spaceId).requirement.revision);
    },
  };
}

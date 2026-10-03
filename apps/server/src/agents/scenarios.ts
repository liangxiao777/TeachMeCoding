import { Type } from '@earendil-works/pi-ai';
import { commandProposalSchema, fileProposalSchema, conclusionSchema, requirementSchema, type ActionProposal, type Requirement } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { Actions } from '../modules/actions.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';
import { readTools } from './read-tools.js';
import { createRouteTools } from './route-tools.js';
import { baseline } from './tasks.js';

export function createScenario(learning: Learning, input: FrozenContext, runId: string, cwd?: string, actions?: Actions): ScenarioRun {
  if (input.scenario === 'intake') {
    let draft: Requirement | undefined;
    return {
      tools: [{ name: 'submit_requirement_draft', label: '整理需求草稿', description: 'Stage a complete requirement draft. Never confirms it.',
        // Strip Zod's non-JSON metadata before TypeBox sees it: provider schemas are data, not validators.
        parameters: Type.Unsafe<Requirement>(JSON.parse(JSON.stringify(requirementSchema.toJSONSchema()))),
        async execute(_id, args) {
          draft = requirementSchema.parse(args);
          return { content: [{ type: 'text', text: '草稿已暂存；成功结束后仍需用户确认。' }], details: {} };
        },
      }],
      commit() {
        if (draft) learning.saveRequirement(input.spaceId, { revision: input.requirement.revision, value: draft, confirmed: false });
      },
    };
  }
  if (input.scenario === 'roadmap') {
    const initial = input.route!.content === null;
    const draft = createRouteTools(input.route!.content);
    return {
      tools: draft.tools,
      commit() {
        const proposal = draft.proposal();
        if (initial && !proposal) throw new BusinessError(422, '未生成完整学习路线，请重试规划。');
        if (proposal) {
          const saved = learning.proposeRoute(input.spaceId, input.sessionId!, proposal, { requirement: input.requirement.revision, route: input.route!.revision });
          if (initial) learning.applyProposal(input.spaceId, saved.id);
        }
      },
    };
  }
  let conclusion: ReturnType<typeof conclusionSchema.parse> | undefined;
  const proposals: ActionProposal[] = [];
  const proposalTools: ScenarioRun['tools'] = actions ? [
    { name: 'propose_file_change', label: '提议修改文件', description: 'Propose full new content for one project file. Does not write; requires explicit user confirmation.',
      parameters: Type.Unsafe<ReturnType<typeof fileProposalSchema.parse>>(JSON.parse(JSON.stringify(fileProposalSchema.toJSONSchema()))),
      async execute(_id, args) {
        const p = actions.prepare(input.spaceId, input.sessionId!, runId, 'file', args); proposals.push(p);
        return { content: [{ type: 'text', text: `已暂存提案 ${p.id}，尚未执行。成功回复后由用户查看并确认。` }], details: {} };
      } },
    { name: 'propose_command', label: '提议本机命令', description: 'Propose a bash command in the current project directory. Does not execute; requires explicit user confirmation. Never auto-install toolchains.',
      parameters: Type.Unsafe<ReturnType<typeof commandProposalSchema.parse>>(JSON.parse(JSON.stringify(commandProposalSchema.toJSONSchema()))),
      async execute(_id, args) {
        const p = actions.prepare(input.spaceId, input.sessionId!, runId, 'command', args); proposals.push(p);
        return { content: [{ type: 'text', text: `已暂存提案 ${p.id}，尚未执行。成功回复后由用户查看并确认。` }], details: {} };
      } },
  ] : [];
  return { tools: [...(cwd ? readTools(cwd) : []), ...proposalTools, {
    name: 'submit_learning_conclusion', label: '整理学习结论', description: 'Stage a specific learning conclusion for user adoption; never infer mastery or assign a score.',
    parameters: Type.Unsafe<ReturnType<typeof conclusionSchema.parse>>(JSON.parse(JSON.stringify(conclusionSchema.toJSONSchema()))),
    async execute(_id, args) {
      conclusion = conclusionSchema.parse(args);
      return { content: [{ type: 'text', text: '待用户采纳，不代表测评通过。' }], details: {} };
    },
  }], commit() {
    if (conclusion) learning.proposeConclusion(input.spaceId, input.unitId!, runId, conclusion, baseline(input));
    for (const proposal of proposals) actions!.save(input.spaceId, proposal);
  } };
}

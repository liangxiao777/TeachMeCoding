import { Type } from '@earendil-works/pi-ai';
import { conclusionSchema, requirementSchema, type Requirement } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';
import { readTools } from './read-tools.js';
import { createRouteTools } from './route-tools.js';
import { baseline } from './tasks.js';

export function createScenario(learning: Learning, input: FrozenContext, runId: string, cwd?: string): ScenarioRun {
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
  return { tools: [...(cwd ? readTools(cwd) : []), {
    name: 'submit_learning_conclusion', label: '整理学习结论', description: 'Stage a specific learning conclusion for user adoption; never infer mastery or assign a score.',
    parameters: Type.Unsafe<ReturnType<typeof conclusionSchema.parse>>(JSON.parse(JSON.stringify(conclusionSchema.toJSONSchema()))),
    async execute(_id, args) {
      conclusion = conclusionSchema.parse(args);
      return { content: [{ type: 'text', text: '待用户采纳，不代表测评通过。' }], details: {} };
    },
  }], commit() {
    if (conclusion) learning.proposeConclusion(input.spaceId, input.unitId!, runId, conclusion, baseline(input));
  } };
}

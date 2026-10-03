import { Type } from '@earendil-works/pi-ai';
import { requirementSchema, routeContentSchema, type Requirement, type RouteContent } from '@teach-me-coding/contracts';
import type { Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';

export function createScenario(learning: Learning, input: FrozenContext): ScenarioRun {
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
    let proposal: RouteContent | undefined;
    return {
      tools: [{ name: 'submit_route_proposal', label: '拟定路线提案', description: 'Stage the complete route, retaining existing unit IDs. User confirmation is required.',
        parameters: Type.Unsafe<RouteContent>(JSON.parse(JSON.stringify(routeContentSchema.toJSONSchema()))),
        async execute(_id, args) {
          proposal = routeContentSchema.parse(args);
          return { content: [{ type: 'text', text: '提案已暂存，尚未应用。' }], details: {} };
        },
      }],
      commit() {
        if (proposal) learning.proposeRoute(input.spaceId, input.sessionId, proposal, { requirement: input.requirement.revision, route: input.route!.revision });
      },
    };
  }
  return { tools: [], commit() {} };
}

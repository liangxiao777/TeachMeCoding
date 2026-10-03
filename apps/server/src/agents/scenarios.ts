import { Type } from '@earendil-works/pi-ai';
import { requirementSchema, type Requirement } from '@teach-me-coding/contracts';
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
  return { tools: [], commit() {} };
}

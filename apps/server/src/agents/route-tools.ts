import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { idSchema, routeContentSchema, routeSubmissionSchema, type RouteContent, type UnitProgress } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';

const stageSchema = routeContentSchema.shape.stages.element;
const unitSchema = stageSchema.shape.units.element;
const unitContent = unitSchema.omit({ id: true });
const position = z.number().int().positive().optional().describe('1-based position; omit to keep the current position, or append a new/moved item.');

// This draft belongs to one run. Nothing reaches the business tables until the
// model submits it and the runtime commits a normally completed run.
export function createRouteTools(current: RouteContent | null, progress: readonly UnitProgress[] = []): { tools: AgentTool[]; proposal: () => RouteContent | undefined } {
  if (current === null) {
    let submitted: RouteContent | undefined;
    return { tools: [{
      name: 'submit_route', label: '提交完整学习路线',
      description: 'Submit the complete initial learning route in one call. Nest units inside stages; array order is learning order. Include a concise summary of what each unit covers and goals describing what the learner will be able to do when useful. Summary, goals and the planning rationale note are optional. Do not provide IDs or position numbers; the host creates identities and associations. This only stages the route; successful completion saves and displays it.',
      parameters: Type.Unsafe(JSON.parse(JSON.stringify(routeSubmissionSchema.toJSONSchema()))),
      async execute(_id, args) {
        const content = routeSubmissionSchema.parse(args);
        submitted = { note: content.note ?? '', stages: content.stages.map((stage) => ({
          id: randomUUID(), title: stage.title, units: stage.units.map((unit) => ({
            id: randomUUID(), title: unit.title, summary: unit.summary ?? '', goals: unit.goals ?? [],
          })),
        })) };
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'staged', stages: submitted.stages.length,
          units: submitted.stages.reduce((n, stage) => n + stage.units.length, 0),
          next: 'Successful completion saves and displays the complete initial route.' }) }], details: {} };
      },
    }], proposal: () => submitted };
  }
  const draft = structuredClone(current);
  const protectedUnits = new Set(progress.filter((unit) => unit.started || unit.active).map((unit) => unit.id));
  let submitted: RouteContent | undefined, changed = false;
  const stage = (id: string) => {
    const found = draft.stages.find((stage) => stage.id === id);
    if (!found) throw new Error('Unknown stageId. Copy an ID from the current route or add_route_stage result.');
    return found;
  };
  const unit = (id: string) => {
    const parent = draft.stages.find((stage) => stage.units.some((unit) => unit.id === id));
    if (!parent) throw new Error('Unknown unitId. Copy an ID from the current route or add_route_unit result.');
    return { parent, value: parent.units.find((unit) => unit.id === id)! };
  };
  const index = (position: number | undefined, fallback: number, length: number) => {
    const value = position === undefined ? fallback : position - 1;
    if (value < 0 || value > length) throw new Error(`Position must be between 1 and ${length + 1}.`);
    return value;
  };
  function tool<S extends z.ZodType>(name: string, label: string, description: string, schema: S, edit: (args: z.output<S>) => Record<string, unknown>): AgentTool {
    return { name, label, description, parameters: Type.Unsafe(JSON.parse(JSON.stringify(schema.toJSONSchema()))),
      async execute(_id, args) {
        const before = JSON.stringify(draft);
        const result = edit(schema.parse(args));
        const edited = name !== 'submit_route_proposal' && JSON.stringify(draft) !== before;
        if (edited) { submitted = undefined; changed = true; }
        return { content: [{ type: 'text', text: JSON.stringify(name === 'submit_route_proposal' ? result : { ...result, changed: edited }) }], details: {} };
      },
    };
  }
  const tools = [
    tool('add_route_stage', '添加学习阶段', 'Add one stage. The host returns its stageId; do not invent IDs.',
      z.object({ title: stageSchema.shape.title, position }).strict(), (args) => {
        const at = index(args.position, draft.stages.length, draft.stages.length);
        const value = { id: randomUUID(), title: args.title, units: [] };
        draft.stages.splice(at, 0, value);
        return { stageId: value.id, title: value.title };
      }),
    tool('add_route_unit', '添加学习单元', 'Add one unit to a stage. Copy stageId from the route or tool result. Summary and goals are optional; prefer useful teaching scope and learning outcomes rather than filler. The host returns unitId.',
      unitContent.partial({ summary: true, goals: true }).extend({ stageId: idSchema, position }).strict(), (args) => {
        const parent = stage(args.stageId), at = index(args.position, parent.units.length, parent.units.length);
        const value = { id: randomUUID(), title: args.title, summary: args.summary ?? '', goals: args.goals ?? [] };
        parent.units.splice(at, 0, value);
        return { stageId: parent.id, unitId: value.id, title: value.title };
      }),
    tool('update_route_stage', '调整学习阶段', 'Rename or reorder one stage, retaining its ID and units. Omit fields that should stay unchanged.',
      z.object({ stageId: idSchema, title: stageSchema.shape.title.optional(), position }).strict(), (args) => {
        const value = stage(args.stageId), previous = draft.stages.indexOf(value);
        const at = index(args.position, previous, draft.stages.length - 1);
        if (args.title !== undefined) value.title = args.title;
        draft.stages.splice(previous, 1); draft.stages.splice(at, 0, value);
        return { stageId: value.id, title: value.title };
      }),
    tool('update_route_unit', '调整学习单元', 'Edit or move one unit, retaining its ID and learning records. Started or active units retain their goals: only correct title/summary wording or move them; put new teaching objectives in supplemental units. Unstarted units can be retargeted. Omit fields that should stay unchanged.',
      unitContent.partial().extend({ unitId: idSchema, stageId: idSchema.optional(), position }).strict(), (args) => {
        const { parent, value } = unit(args.unitId), target = args.stageId ? stage(args.stageId) : parent;
        const previous = parent.units.indexOf(value), length = target.units.length - (target === parent ? 1 : 0);
        const at = index(args.position, target === parent ? previous : length, length);
        if (protectedUnits.has(value.id) && args.goals !== undefined && JSON.stringify(args.goals) !== JSON.stringify(value.goals)) {
          throw new Error('Started or active units must retain their goals. Add a supplemental unit for new objectives.');
        }
        if (args.title !== undefined) value.title = args.title;
        if (args.summary !== undefined) value.summary = args.summary;
        if (args.goals !== undefined) value.goals = args.goals;
        parent.units.splice(previous, 1); target.units.splice(at, 0, value);
        return { stageId: target.id, unitId: value.id, title: value.title };
      }),
    tool('remove_route_unit', '移除未开始单元', 'Remove a unit with no saved learning activity or active task, including an unstarted unit from the applied route. Started or active units cannot be removed; move them or add supplements instead. Empty sessions or blank drafts alone do not count as learning.',
      z.object({ unitId: idSchema }).strict(), (args) => {
        const { parent, value } = unit(args.unitId);
        if (protectedUnits.has(value.id)) throw new Error('Started or active units cannot be removed; move the unit or add supplements instead.');
        parent.units.splice(parent.units.indexOf(value), 1);
        return { removed: value.id };
      }),
    tool('remove_route_stage', '移除空阶段', 'Remove an empty stage. Move its units first; this never removes units implicitly.',
      z.object({ stageId: idSchema }).strict(), (args) => {
        const value = stage(args.stageId);
        if (value.units.length) throw new Error('Move or remove the stage’s units before removing this stage.');
        draft.stages.splice(draft.stages.indexOf(value), 1);
        return { removed: value.id };
      }),
    tool('submit_route_proposal', '提交路线调整', 'Submit the assembled adjustment for user confirmation, without repeating the whole route. The planning rationale note is optional. Every stage must contain a unit. Actual content or order changes after submission require resubmission; unchanged updates do not.',
      z.object({ note: routeContentSchema.shape.note.optional() }).strict(), (args) => {
        submitted = routeContentSchema.parse({ ...draft, note: args.note ?? '' });
        return { status: 'staged', stages: submitted.stages.length, units: submitted.stages.reduce((n, stage) => n + stage.units.length, 0),
          next: 'Successful completion stages an adjustment for user confirmation.' };
      }),
  ];
  return { tools, proposal() {
    if (changed && !submitted) throw new BusinessError(422, '路线草稿尚未完整提交，未保存生成产物。');
    return submitted;
  } };
}

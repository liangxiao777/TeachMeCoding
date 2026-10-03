import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { idSchema, routeContentSchema, type RouteContent } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';

const stageSchema = routeContentSchema.shape.stages.element;
const unitSchema = stageSchema.shape.units.element;
const unitContent = unitSchema.omit({ id: true });
const position = z.number().int().positive().optional().describe('1-based position; omit to keep the current position, or append a new/moved item.');

// This draft belongs to one run. Nothing reaches the business tables until the
// model submits it and the runtime commits a normally completed run.
export function createRouteTools(current: RouteContent | null) {
  const draft: RouteContent = structuredClone(current ?? { note: '', stages: [] });
  const existingUnits = new Set(current?.stages.flatMap((stage) => stage.units.map((unit) => unit.id)));
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
  function tool<S extends z.ZodType>(name: string, label: string, description: string, schema: S, edit: (args: z.output<S>) => unknown): AgentTool {
    return { name, label, description, parameters: Type.Unsafe(JSON.parse(JSON.stringify(schema.toJSONSchema()))),
      async execute(_id, args) {
        const result = edit(schema.parse(args));
        if (name !== 'submit_route_proposal') { submitted = undefined; changed = true; }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
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
    tool('add_route_unit', '添加学习单元', 'Add one unit to a stage. Copy stageId from the route or tool result. The host returns unitId.',
      unitContent.extend({ stageId: idSchema, position }).strict(), (args) => {
        const parent = stage(args.stageId), at = index(args.position, parent.units.length, parent.units.length);
        const value = { id: randomUUID(), title: args.title, summary: args.summary, goals: args.goals };
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
    tool('update_route_unit', '调整学习单元', 'Edit or move one unit, retaining its ID and learning records. Omit fields that should stay unchanged.',
      unitContent.partial().extend({ unitId: idSchema, stageId: idSchema.optional(), position }).strict(), (args) => {
        const { parent, value } = unit(args.unitId), target = args.stageId ? stage(args.stageId) : parent;
        const previous = parent.units.indexOf(value), length = target.units.length - (target === parent ? 1 : 0);
        const at = index(args.position, target === parent ? previous : length, length);
        if (args.title !== undefined) value.title = args.title;
        if (args.summary !== undefined) value.summary = args.summary;
        if (args.goals !== undefined) value.goals = args.goals;
        parent.units.splice(previous, 1); target.units.splice(at, 0, value);
        return { stageId: target.id, unitId: value.id, title: value.title };
      }),
    tool('remove_route_unit', '移除草稿单元', 'Undo a newly added unit. Units from the existing published route cannot be removed.',
      z.object({ unitId: idSchema }).strict(), (args) => {
        const { parent, value } = unit(args.unitId);
        if (existingUnits.has(value.id)) throw new Error('Existing units cannot be removed; update or move the unit instead.');
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
    tool('submit_route_proposal', '提交学习路线', 'Finish the assembled route. Supply only the planning rationale. Every stage must contain a unit. Further edits require resubmission.',
      z.object({ note: routeContentSchema.shape.note }).strict(), (args) => {
        submitted = undefined;
        submitted = routeContentSchema.parse({ ...draft, note: args.note });
        return { status: 'staged', stages: submitted.stages.length, units: submitted.stages.reduce((n, stage) => n + stage.units.length, 0),
          next: current ? 'Successful completion stages an adjustment for user confirmation.' : 'Successful completion applies the initial route.' };
      }),
  ];
  return { tools, proposal() {
    if (changed && !submitted) throw new BusinessError(422, '路线草稿尚未完整提交，未保存生成产物。');
    return submitted;
  } };
}

import { Type } from '@earendil-works/pi-ai';
import { structuredLessonSchema } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';

export const baseline = (input: FrozenContext) => ({ requirement: input.requirement.revision, route: input.route!.revision, lesson: input.lesson?.revision ?? 0 });
export function createTask(learning: Learning, input: FrozenContext): ScenarioRun {
  let lesson: ReturnType<typeof structuredLessonSchema.parse> | undefined;
  return { tools: [{ name: 'submit_lesson', label: '生成课件', description: 'Submit structured lesson for this unit. Does not mark any assessment passed.',
    parameters: Type.Unsafe<ReturnType<typeof structuredLessonSchema.parse>>(JSON.parse(JSON.stringify(structuredLessonSchema.toJSONSchema()))),
    async execute(_id, args) {
      const value = structuredLessonSchema.parse(args);
      const headings = value.blocks.filter((b) => b.type === 'h2').map((b) => b.id);
      if (new Set(headings).size !== headings.length) throw new Error('Heading IDs must be unique.');
      lesson = value;
      return { content: [{ type: 'text', text: '课件已暂存。' }], details: {} };
    },
  }], commit() {
    if (!lesson) throw new BusinessError(422, '模型没有提交有效课件；旧课件保持不变。');
    learning.saveLesson(input.spaceId, input.unitId!, lesson, baseline(input));
  } };
}

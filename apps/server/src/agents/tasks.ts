import { Type } from '@earendil-works/pi-ai';
import { lessonSubmissionSchema } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';
import { assessmentArtifactSchema, Assessments, evaluationArtifactSchema } from '../modules/assessments.js';

export const baseline = (input: FrozenContext) => ({ requirement: input.requirement.revision, route: input.route!.revision, lesson: input.lesson?.revision ?? 0 });
export function createTask(learning: Learning, input: FrozenContext): ScenarioRun {
  if (input.scenario === 'assessment') {
    let artifact: ReturnType<typeof assessmentArtifactSchema.parse> | undefined;
    return { tools: [{ name: 'submit_assessment', label: '生成测评题目', description: 'Submit public questions separately from private grading rubric. Never expose private answers in public fields.',
      parameters: Type.Unsafe<ReturnType<typeof assessmentArtifactSchema.parse>>(JSON.parse(JSON.stringify(assessmentArtifactSchema.toJSONSchema()))),
      async execute(_id, args) {
        artifact = assessmentArtifactSchema.parse(args);
        return { content: [{ type: 'text', text: '题目和私有标准已暂存。' }], details: {} };
      },
    }], commit() {
      if (!artifact) throw new BusinessError(422, '模型未提交有效题目。');
      new Assessments(learning).saveSpec(input.spaceId, input.unitId!, artifact, baseline(input), input.assessmentRevision!);
    } };
  }
  if (input.scenario === 'evaluation') {
    let artifact: ReturnType<typeof evaluationArtifactSchema.parse> | undefined;
    return { tools: [{ name: 'submit_evaluation', label: '评估固定作答', description: 'Evaluate the immutable submitted answers against the private rubric. Static reasoning and fixtures never prove executed code correctness.',
      parameters: Type.Unsafe<ReturnType<typeof evaluationArtifactSchema.parse>>(JSON.parse(JSON.stringify(evaluationArtifactSchema.toJSONSchema()))),
      async execute(_id, args) {
        artifact = evaluationArtifactSchema.parse(args);
        return { content: [{ type: 'text', text: '评估已暂存。' }], details: {} };
      },
    }], commit() {
      if (!artifact) throw new BusinessError(422, '模型未提交有效评估；没有通过记录。');
      new Assessments(learning).grade(input.spaceId, input.unitId!, input.evaluation!, artifact);
    } };
  }
  let lesson: ReturnType<typeof lessonSubmissionSchema.parse> | undefined;
  return { tools: [{ name: 'submit_lesson', label: '生成课件', description: 'Submit the complete lesson as a title and Markdown content. Write explanations, headings, examples and exercises naturally; do not supply block or heading IDs. Code fences may include file=demo.py. Optional > [!TIP] / > [!WARNING] callouts and ::::practice containers with :::hint / :::solution enrich teaching; none are mandatory. Does not run code or mark assessments passed.',
    parameters: Type.Unsafe<ReturnType<typeof lessonSubmissionSchema.parse>>(JSON.parse(JSON.stringify(lessonSubmissionSchema.toJSONSchema()))),
    async execute(_id, args) {
      lesson = lessonSubmissionSchema.parse(args);
      return { content: [{ type: 'text', text: '课件已暂存。' }], details: {} };
    },
  }], commit() {
    if (!lesson) throw new BusinessError(422, '模型没有提交有效课件；旧课件保持不变。');
    learning.saveLesson(input.spaceId, input.unitId!, lesson, baseline(input));
  } };
}

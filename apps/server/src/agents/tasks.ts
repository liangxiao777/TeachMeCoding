import { Type } from '@earendil-works/pi-ai';
import { lessonSubmissionSchema } from '@teach-me-coding/contracts';
import { BusinessError, type Learning } from '../modules/learning.js';
import type { FrozenContext } from './context.js';
import type { ScenarioRun } from './runtime.js';
import { assessmentArtifactSchema, Assessments, evaluationArtifactSchema } from '../modules/assessments.js';
import { createLessonReadTools } from './lesson-tools.js';

export const baseline = (input: FrozenContext) => ({ requirement: input.requirement.revision, route: input.route!.revision, lesson: input.lesson?.revision ?? 0 });
export function createTask(learning: Learning, input: FrozenContext, taskId: string): ScenarioRun {
  if (input.scenario === 'assessment') {
    let artifact: ReturnType<typeof assessmentArtifactSchema.parse> | undefined;
    return { tools: [{ name: 'submit_assessment', label: '生成测评题目', description: 'Submit two clear, concrete questions that help this learner consolidate the current lesson, separately from the private grading rubric. Each question asks for one clear task, with only the reasoning needed to answer it. Do not append independently answerable follow-ups to cover more topics, or bundle behavior, limitations, improvements and scale calculations into one question. Prefer focused understanding over broad coverage; lesson extensions and challenges are not mandatory. q1 is an explanation question. Explicitly choose q2Kind: prefer reasoning, which may include short code to read; use code only when implementing or changing code is necessary to assess the learning goal. Code answers must run as one self-contained source file without other source, configuration, test or data files or an existing project. Supply unrelated argument parsing and input/output boilerplate in starter. Code questions require public.execution with a supported language and public test cases; reasoning questions omit execution. Never expose private answers in public fields. Omitted starter defaults to an empty string.',
      parameters: Type.Unsafe<ReturnType<typeof assessmentArtifactSchema.parse>>(JSON.parse(JSON.stringify(assessmentArtifactSchema.toJSONSchema({ io: 'input' })))),
      async execute(_id, args) {
        const submitted = assessmentArtifactSchema.parse(args);
        if (submitted.public.q2Kind === 'code' && !submitted.public.execution) throw new BusinessError(422, { code: 'CODE_PLAN_UNAVAILABLE' });
        artifact = submitted;
        return { content: [{ type: 'text', text: '题目和私有标准已暂存。' }], details: {} };
      },
    }], commit() {
      if (!artifact) throw new BusinessError(422, { code: 'ASSESSMENT_ARTIFACT_MISSING' });
      new Assessments(learning).saveSpec(input.spaceId, input.unitId!, artifact, baseline(input), input.assessmentRevision!);
    } };
  }
  if (input.scenario === 'evaluation') {
    let artifact: ReturnType<typeof evaluationArtifactSchema.parse> | undefined;
    return { tools: [{ name: 'submit_evaluation', label: '评估固定作答', description: 'Evaluate the immutable submitted answers against the private rubric. Omitted mastered, concerns, evidence and toVerify arrays default to empty arrays. Static reasoning and fixtures never prove executed code correctness.',
      parameters: Type.Unsafe<ReturnType<typeof evaluationArtifactSchema.parse>>(JSON.parse(JSON.stringify(evaluationArtifactSchema.toJSONSchema({ io: 'input' })))),
      async execute(_id, args) {
        artifact = evaluationArtifactSchema.parse(args);
        return { content: [{ type: 'text', text: '评估已暂存。' }], details: {} };
      },
    }], commit() {
      if (!artifact) throw new BusinessError(422, { code: 'EVALUATION_ARTIFACT_MISSING' });
      new Assessments(learning).grade(input.spaceId, input.unitId!, input.evaluation!, artifact);
    } };
  }
  let lesson: ReturnType<typeof lessonSubmissionSchema.parse> | undefined;
  const references = createLessonReadTools(learning, input);
  return { tools: [...references.tools, { name: 'submit_lesson', label: '生成课件', description: 'Submit the complete lesson as a title and Markdown content, written for the learner described in the requirement so they come away understanding it, not as an API reference or source walkthrough. The title is displayed separately; start the content with the introduction. First courseware publishes after normal completion; replacing existing courseware stages a proposal requiring explicit user acceptance. Do not supply block or heading IDs. Put an optional file name on the opening fence line, e.g. ```python file=demo.py. Optional > [!TIP] / > [!WARNING] callouts and ::::practice containers with :::hint / :::solution; none are mandatory. You did not run the code: describe results as expectations. Does not mark assessments passed.',
    parameters: Type.Unsafe<ReturnType<typeof lessonSubmissionSchema.parse>>(JSON.parse(JSON.stringify(lessonSubmissionSchema.toJSONSchema()))),
    async execute(_id, args) {
      lesson = lessonSubmissionSchema.parse(args);
      return { content: [{ type: 'text', text: '课件已暂存。' }], details: {} };
    },
  }], commit() {
    if (!lesson) throw new BusinessError(422, { code: 'LESSON_ARTIFACT_MISSING' });
    learning.assertUnitUnlocked(input.spaceId, input.unitId!);
    learning.checkLessonReferences(input.spaceId, references.consumed());
    if (input.lesson) learning.proposeLesson(input.spaceId, input.unitId!, lesson, baseline(input), { kind: 'task', id: taskId }, references.consumed(), input.approvalSessionId);
    else learning.saveLesson(input.spaceId, input.unitId!, lesson, baseline(input));
  } };
}

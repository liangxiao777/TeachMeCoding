'use client'

import { ArrowLeft, ClipboardCheck, Play, Save, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Generating, RichText } from '@/components/shared'
import { RunContent } from '@/components/agent/run-content'
import { RunContext } from '@/components/agent/run-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { CodeEditor } from '@/components/workbench/ide-panel'
import { findUnit } from '@/app/selectors'
import { pendingDecision } from '@/app/lesson-proposals'
import { useApp, useSpace } from '@/app/context'
import { codeCommands } from '@teach-me-coding/contracts'
import { ExecutionResult } from './execution-result'

function QuestionHeader({ n, title, prompt }: { n: number; title: string; prompt: string }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2.5">
        <Badge className="size-6 rounded-full p-0 font-mono">{n}</Badge>
        {title}
      </CardTitle>
      <CardDescription className="min-w-0 text-sm leading-relaxed text-foreground">
        <RichText text={prompt} />
      </CardDescription>
    </CardHeader>
  )
}

export function AssessmentView() {
  const { t } = useTranslation('assessment')
  const space = useSpace()
  const { updateDraft, runDraft, submitAssessment, leaveAssessment, assessment: getAssessment, capabilities, persistence } = useApp()
  const draft = space.draft
  const unit = findUnit(space, draft?.unitId ?? space.currentUnitId)
  if (!draft || !unit) return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={leaveAssessment}>
          <ArrowLeft data-icon="inline-start" />
          {t('controls.backWithAnswers')}
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>{t('form.unavailable')}</CardTitle>
            <CardDescription>{t('form.noDraft')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
  const spec = getAssessment(unit)
  const canRun = !!spec && !spec.stale && capabilities.assessment && capabilities.terminal && !!spec.execution
  const execution = persistence.execution
  const executing = !!execution && ['pending', 'running'].includes(execution.state)
  const storageBusy = !persistence.ready || persistence.busy || pendingDecision(persistence)
  const task = persistence.tasks.filter((t) => t.unitId === unit.id && ['assessment', 'evaluation'].includes(t.kind)).at(-1)
  const activeTask = task && ['pending', 'running'].includes(task.state)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <div className="flex flex-col gap-5">
          <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={leaveAssessment}>
            <ArrowLeft data-icon="inline-start" />
            {t('controls.backWithAnswers')}
          </Button>
          <div className="flex flex-col gap-2">
            <Badge variant="outline" className="gap-1.5">
              <ClipboardCheck aria-hidden />
              {t('form.attempt', { number: draft.attempt })}
            </Badge>
            <h1 className="text-balance text-3xl font-semibold tracking-tight">{unit.title}</h1>
          </div>
          {spec && (
            <div className="flex flex-col gap-2.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('form.abilities')}</p>
              <ul className="flex flex-wrap gap-2">
                {spec.abilities.map((a) => (
                  <li key={a}>
                    <Badge variant="secondary" className="h-7 px-3 font-normal">
                      {a}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {capabilities.assessment && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm" role="status">
            <span className="flex-1">{activeTask ? task.kind === 'evaluation'
              ? spec?.execution ? t('form.runningSubmission') : t('form.staticSubmission') : t('form.generatingQuestions')
              : task && ['failed', 'interrupted'].includes(task.state) ? t('form.taskFailed') : spec?.stale ? t('form.stale') : spec?.execution ? t('form.executionHint') : t('form.staticHint')}</span>
            <RunContext runId={task?.id} />
            {activeTask ? <Button size="sm" variant="outline" onClick={() => persistence.stopTask(task.id)}>{t('form.stopTask')}</Button> : <>
              {task && ['failed', 'interrupted'].includes(task.state) && <Button size="sm" variant="outline" disabled={storageBusy} onClick={() => persistence.retryTask(task.id)}>{t('form.retryTask')}</Button>}
              <Button size="sm" variant="outline" disabled={storageBusy} onClick={persistence.generateAssessment}>{spec ? t('form.regenerateQuestions') : t('form.generateQuestions')}</Button>
            </>}
          </div>
        )}
        {draft.state === 'generating' && capabilities.assessment ? (
          <Card>
            <CardContent>
              <Generating title={t('form.generationTitle')} steps={[t('form.analyzeLesson'), t('form.generate'), t('form.validate'), t('form.save')]}
                parts={persistence.taskParts[task?.id ?? ''] ?? []} />
            </CardContent>
          </Card>
        ) : (
          <>
            {task?.kind === 'evaluation' && <RunContent parts={persistence.taskParts[task.id]} streaming={activeTask} />}
            <Card>
              {spec ? <QuestionHeader n={1} title={spec.q1.title} prompt={spec.q1.prompt} /> : (
                <CardHeader>
                  <CardTitle>{t('form.questionsUnavailable')}</CardTitle>
                  <CardDescription>{t('form.questionsUnavailableHint')}</CardDescription>
                </CardHeader>
              )}
              <CardContent className="flex flex-col gap-4">
                {spec?.q1.code && (
                  <pre className="overflow-x-auto rounded-lg bg-ide p-4 font-mono text-[13px] leading-6 text-ide-foreground">
                    {spec.q1.code.split('\n').map((l, i) => (
                      <div key={i}>
                        <span className="mr-4 inline-block w-4 text-right opacity-40">{i + 1}</span>
                        {l}
                      </div>
                    ))}
                  </pre>
                )}
                <Field>
                  <FieldLabel htmlFor="q1">{t('form.answer')}</FieldLabel>
                  <Textarea
                    id="q1"
                    rows={5}
                    value={draft.q1}
                    onChange={(e) => updateDraft({ q1: e.target.value })}
                    placeholder={spec ? t('form.answerPlaceholder') : t('form.draftPlaceholder')}
                    className="resize-y leading-relaxed"
                  />
                  <FieldDescription>{spec ? t('form.answerHint') : t('form.noQuestionsHint')}</FieldDescription>
                </Field>
              </CardContent>
            </Card>

            <Card>
              {spec ? <QuestionHeader n={2} title={spec.q2.title} prompt={spec.q2.prompt} /> : (
                <CardHeader><CardTitle>{t('form.codeDraft')}</CardTitle></CardHeader>
              )}
              <CardContent>
                {spec?.execution && <div className="mb-4 space-y-2 text-xs">
                  <p>{t('form.permissions')}</p>
                  <details><summary className="cursor-pointer">{t('form.commands')}</summary>
                    {codeCommands(spec.execution).map((command, i) => <pre key={i} className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{t('form.expectedStdout', { command, expected: spec.execution!.cases[i]!.expected })}</pre>)}
                  </details>
                </div>}
                {spec?.q2Kind === 'reasoning' ? <Textarea aria-label={t('form.reasoningAnswer')} rows={6} value={draft.q2} onChange={(e) => updateDraft({ q2: e.target.value })} /> : <div className="dark flex flex-col overflow-hidden rounded-lg border bg-ide text-ide-foreground">
                  <div className="flex items-center justify-between border-b py-1.5 pr-1.5 pl-3">
                    <span className="font-mono text-xs text-muted-foreground">{spec?.q2.file ?? t('form.codeDraft')}</span>
                    {spec?.q2.starter && !draft.q2 && <Button size="xs" variant="outline" onClick={() => updateDraft({ q2: spec.q2.starter })}>{t('form.loadStarter')}</Button>}
                    <Button size="xs" disabled={!canRun || executing || storageBusy || !!activeTask} onClick={runDraft}>
                      <Play data-icon="inline-start" />
                      {t('controls.run')}
                    </Button>
                  </div>
                  <CodeEditor className="h-64" label={spec ? t('form.editCode', { file: spec.q2.file }) : t('form.codeDraft')} filename={spec?.q2.file} language={spec?.execution?.language ?? (space.kind === 'pytorch' ? 'python' : 'rust')} value={draft.q2} onChange={(v) => updateDraft({ q2: v })} />
                  <div className="min-h-16 border-t px-3 py-2 font-mono text-xs leading-5" aria-live="polite">
                    <p className="text-muted-foreground">{execution ? t('form.executionBelow') : canRun ? t('form.outputHint') : t('form.runUnavailable')}</p>
                  </div>
                </div>}
                {execution && <div className="mt-4 space-y-2">
                  {execution.code !== draft.q2 && <p role="status" className="text-xs text-muted-foreground">{t('form.olderCode')}</p>}
                  {execution.specRevision !== spec?.revision && <p role="status" className="text-xs text-muted-foreground">{t('form.olderSpec', { revision: execution.specRevision })}</p>}
                  <ExecutionResult execution={execution} />
                  {executing && <Button size="sm" variant="outline" onClick={() => persistence.stopExecution(execution.id)}>{t('form.stopExecution')}</Button>}
                </div>}
              </CardContent>
            </Card>

            <div className="sticky bottom-0 -mx-8 flex items-center justify-between gap-4 border-t bg-background/85 px-8 py-4 backdrop-blur">
              <p className="text-sm text-muted-foreground">
                {capabilities.assessment && spec ? t('form.submitHint') : t('form.evaluationUnavailable')}
                <span role="status" className="ml-2">{persistence.assessmentDirty ? t('controls.unsaved') : t('controls.saved')}</span>
              </p>
              <Button
                size="lg"
                variant="outline"
                disabled={!persistence.ready || persistence.busy || !persistence.assessmentDirty}
                onClick={persistence.saveAssessment}
              >
                <Save data-icon="inline-start" />
                {t('controls.saveDraft')}
              </Button>
              <Button size="lg" onClick={submitAssessment} disabled={!spec || spec.stale || !capabilities.assessment || storageBusy || executing || !!activeTask || !draft.q1.trim()}>
                <Send data-icon="inline-start" />
                {t('controls.submit')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

'use client'

import { useTranslation } from 'react-i18next'
import { localizedAssessmentSummary, localizedExecutionFeedback } from '@/i18n/execution'
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  HelpCircle,
  MessageSquareQuote,
  Quote,
  RotateCcw,
  Trophy,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { InlineText } from '@/components/shared'
import { findUnit, nextUnit, relativeTime } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { ExecutionResult } from './execution-result'

function Section({
  icon: Icon,
  title,
  items,
  tone,
  onAsk,
}: {
  icon: typeof Quote
  title: string
  items: string[]
  tone: 'primary' | 'accent' | 'muted'
  onAsk?: (item: string) => void
}) {
  const { t } = useTranslation('assessment')
  if (!items.length) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon
            className={cn(
              'size-4',
              tone === 'primary' && 'text-primary',
              tone === 'accent' && 'text-accent-foreground',
              tone === 'muted' && 'text-muted-foreground',
            )}
            aria-hidden
          />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {items.map((i, idx) => (
            <li key={i} className="flex flex-col">
              {idx > 0 && <Separator className="my-2.5" />}
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words text-sm leading-relaxed"><InlineText text={i} /></span>
                {onAsk && (
                  <Button variant="ghost" size="xs" className="shrink-0 text-primary" onClick={() => onAsk(i)}>
                    <MessageSquareQuote data-icon="inline-start" />
                    {t('controls.ask')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export function ResultView() {
  const { t } = useTranslation(['assessment', 'common'])
  const space = useSpace()
  const { goNextUnit, backToStudy, startAssessment, setQuote, setView } = useApp()
  const record = space.records.find((r) => r.id === space.viewingRecordId)
  if (!record) return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Card>
          <CardHeader>
            <CardTitle>{t('result.unavailable')}</CardTitle>
            <CardDescription>{t('result.unavailableHint')}</CardDescription>
          </CardHeader>
        </Card>
        <Button size="lg" variant="ghost" onClick={() => setView('route')}>{t('controls.viewPath')}</Button>
      </div>
    </div>
  )
  const passed = record.result === 'pass'
  const unverified = record.result === 'unverified'
  const expired = ['non-execution', 'execution-verified'].includes(record.verification ?? '') && record.valid === false
  const unit = findUnit(space, record.unitId)
  const historicalPass = record.valid === false && passed && unit?.historicalPass?.recordId === record.id
  const deferredPass = historicalPass && unit?.status === 'learning'
  const next = nextUnit(space, record.unitId)
  const isLatest = [...space.records].reverse().find((r) => r.unitId === record.unitId)?.id === record.id
  const ask = (text: string) => setQuote({ source: 'advice', label: t('common:chat.assessmentQuote', { title: record.unitTitle }), caption: { kind: 'assessment', name: record.unitTitle }, text })
  const execution = record.execution && localizedExecutionFeedback(record.execution)
  const nextStep = historicalPass ? deferredPass ? t('result.historicalDeferredNext') : t('result.historicalNext')
    : expired ? t('result.expiredNext')
    : unverified ? execution?.nextStep ?? t('result.unverifiedNext')
    : passed ? next ? t('result.passedNext') : t('result.completedNext')
    : execution?.nextStep ?? t('result.needsWorkNext')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Card className={cn('overflow-hidden', passed ? 'border-primary/30' : 'border-accent-foreground/25')}>
          <div className={cn('h-1.5', passed ? 'bg-primary' : 'bg-accent-foreground/70')} aria-hidden />
          <CardHeader className="gap-4">
            <div className="flex items-center justify-between gap-4">
              <p className="font-mono text-xs text-muted-foreground">
                {t('result.attempt', { title: record.unitTitle, number: record.attempt, time: relativeTime(record.createdAt) })}
              </p>
              {!isLatest && <Badge variant="outline">{t('result.history')}</Badge>}
            </div>
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex size-12 shrink-0 items-center justify-center rounded-full',
                  passed ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground',
                )}
              >
                {passed ? <CheckCircle2 className="size-6" aria-hidden /> : <RotateCcw className="size-6" aria-hidden />}
              </div>
              <div className="flex flex-col gap-1">
                <Badge variant={passed ? 'default' : 'secondary'} className="w-fit">
                  {historicalPass ? t('result.historicalPass') : expired ? t('result.expired') : unverified ? t('result.unverified') : passed ? t('result.passed') : t('result.needsWork')}
                </Badge>
                <CardTitle className="text-2xl tracking-tight">
                  {historicalPass ? t(deferredPass ? 'result.historicalUnassessedTitle' : 'result.historicalTitle') : expired ? t('result.expiredTitle') : unverified ? t('result.unverifiedTitle') : passed ? t('result.passedTitle') : t('result.needsWorkTitle')}
                </CardTitle>
              </div>
            </div>
            <CardDescription className="text-base leading-relaxed text-foreground"><InlineText text={localizedAssessmentSummary(record)} /></CardDescription>
            {unverified && <p className="text-sm text-muted-foreground">{t('result.unverifiedHint')}</p>}
            <p className="text-sm leading-relaxed"><span className="font-medium">{t('result.next')}</span>{nextStep}</p>
          </CardHeader>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          {passed && (!expired && isLatest || deferredPass) && next ? (
            <Button size="lg" onClick={goNextUnit}>
              {t('result.nextUnit', { title: next.title })}
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : (!passed || expired && !historicalPass) && isLatest ? (
            <>
              <Button size="lg" onClick={startAssessment}>
                <RotateCcw data-icon="inline-start" />
                {t('result.retry')}
              </Button>
              <Button size="lg" variant="outline" onClick={backToStudy}>
                <BookOpen data-icon="inline-start" />
                {t('result.backToStudy', { title: unit?.title ?? '' })}
              </Button>
            </>
          ) : null}
          {historicalPass && <Button size="lg" variant="outline" onClick={startAssessment}>{t('result.assessNewVersion')}</Button>}
          {/* Going back to the unit is the header's job; the path is the next step only once it is finished. */}
          {isLatest && passed && !next && (
            <Button size="lg" variant="ghost" onClick={() => setView('route')}>
              {t('controls.viewPath')}
            </Button>
          )}
        </div>

        {passed && !expired && space.completed && !next && isLatest && (
          <Alert>
            <Trophy aria-hidden />
            <AlertTitle>{t('result.pathCompleted')}</AlertTitle>
            <AlertDescription>{t('result.pathCompletedHint')}</AlertDescription>
          </Alert>
        )}

        <Section icon={Quote} title={unverified ? t('result.unverifiedEvidence') : t('result.evidence')} items={record.evidence} tone="muted" />
        <Section icon={CircleAlert} title={t('result.concerns')} items={record.concerns} tone="accent" onAsk={ask} />
        {(record.lessonRevision !== undefined || record.specRevision !== undefined) && <p className="text-xs leading-relaxed text-muted-foreground" data-testid="assessment-record-source">
          {t('result.source', { lesson: record.lessonRevision !== undefined ? t('result.lessonRevision', { revision: record.lessonRevision }) : t('result.unknownLessonRevision'), spec: record.specRevision !== undefined ? t('result.specRevision', { revision: record.specRevision }) : '' })}
        </p>}
        {record.execution && <ExecutionResult execution={record.execution} showSummary={record.result === 'pass' || record.result === 'needs_work' && !!record.summary} />}
        {(record.mastered.length > 0 || record.toVerify.length > 0) && <Collapsible className="result-disclosure rounded-xl border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
            {t('result.additional')}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-4 border-t p-4">
              <Section icon={CheckCircle2} title={t('result.mastered')} items={record.mastered} tone="primary" />
              <Section icon={HelpCircle} title={t('result.notCovered')} items={record.toVerify} tone="muted" onAsk={ask} />
            </div>
          </CollapsibleContent>
        </Collapsible>}

        <Collapsible className="result-disclosure rounded-xl border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
            {t('result.viewAnswers')}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 border-t px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('result.explanation')}</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.answers.q1 || t('result.unanswered')}</p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t(record.q2Kind === 'reasoning' ? 'result.analysis' : 'result.code')}</p>
              {record.q2Kind === 'reasoning' ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.answers.q2 || t('result.unanswered')}</p>
                : <pre className="overflow-x-auto rounded-lg bg-ide p-3 font-mono text-xs leading-relaxed text-ide-foreground">{record.answers.q2}</pre>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}

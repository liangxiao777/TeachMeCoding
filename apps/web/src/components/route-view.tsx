'use client'

import { ArrowRight, Lightbulb, Lock, Route, Sparkles, Trophy } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNotice, notice, type NoticeValue } from '@/i18n/notice'
import type { Proposal } from '@teach-me-coding/contracts'
import { StatusIcon, StatusPill, isComposing } from '@/components/shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Progress } from '@/components/ui/progress'
import { allUnits, availableUnitIds, recommendedUnit } from '@/app/selectors'
import { pendingDecision } from '@/app/lesson-proposals'
import { diffRoute, routeDiffSummary, type UnitDiff } from '@/app/route-diff'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { uiMotion } from '@/lib/motion'
import type { Space, Unit } from '@/app/types'

const removedText = 'text-red-700 dark:text-red-400'
const addedText = 'text-green-700 dark:text-green-400'

function InlineDiff({ before, after }: { before?: string; after?: string }) {
  const { t } = useTranslation('learning')
  if (before === after) return <span className="whitespace-pre-wrap break-words">{after}</span>
  return (
    <span className="flex min-w-0 flex-col gap-1 whitespace-pre-wrap break-words">
      {before !== undefined && (
        <del className={removedText}>
          <span className="sr-only">{after === undefined ? t('route.removedPrefix') : t('route.beforePrefix')}</span>
          <span aria-hidden>− </span>{before || t('route.emptyValue')}
        </del>
      )}
      {after !== undefined && (
        <ins className={cn('no-underline', addedText)}>
          <span className="sr-only">{before === undefined ? t('route.addedPrefix') : t('route.afterPrefix')}</span>
          <span aria-hidden>+ </span>{after || t('route.emptyValue')}
        </ins>
      )}
    </span>
  )
}

function GoalDiff({ before, after }: { before?: string[]; after?: string[] }) {
  const { t } = useTranslation('learning')
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  const versions = unchanged ? [{ goals: after, label: t('route.goals'), tone: '' }] : [
    { goals: before, label: after === undefined ? t('route.removedGoals') : t('route.beforeGoals'), tone: removedText },
    { goals: after, label: before === undefined ? t('route.addedGoals') : t('route.afterGoals'), tone: addedText },
  ]
  return (
    <div className="flex flex-col gap-2">
      {versions.filter((version) => version.goals !== undefined).map(({ goals, label, tone }) => (
        <div key={label} className="flex flex-col gap-1.5">
          <p className={cn('text-xs', tone || 'text-muted-foreground')}>{label}</p>
          <ul className="flex flex-wrap gap-1.5" aria-label={label}>
            {goals?.length ? goals.map((goal, index) => (
              <li key={index}>
                <Badge variant="outline" className={cn('h-auto whitespace-normal text-left font-normal', tone, tone === removedText && 'line-through')}>
                  {goal}
                </Badge>
              </li>
            )) : <li className={cn('text-xs', tone || 'text-muted-foreground')}>{t('route.noGoals')}</li>}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ChangeBadge({ change }: { change: UnitDiff['change'] }) {
  const { t } = useTranslation('learning')
  if (change === 'unchanged') return null
  return (
    <Badge variant="outline" className={cn(change === 'added' && addedText, change === 'removed' && removedText)}>
      {t(`route.${change}`)}
    </Badge>
  )
}

function ProposalUnitRow({ diff, unit, index, isLast, available, isCurrent }: {
  diff: UnitDiff; unit?: Unit; index: string; isLast: boolean; available: boolean; isCurrent: boolean
}) {
  const { t } = useTranslation('learning')
  const { enterUnit } = useApp()
  // Preview entries never generate lessons. Only retained, accessible units
  // with already-saved courseware have a navigation action.
  const canView = !!diff.before && !!diff.after && !!unit && available && (unit.hasLesson ?? unit.contentState === 'ready')
  return (
    <li className="relative flex gap-4">
      <div className="flex flex-col items-center">
        {unit ? <StatusIcon status={unit.status} /> : <span aria-hidden className="size-6 rounded-full border bg-background" />}
        {!isLast && <span aria-hidden className="my-1 w-px flex-1 bg-border" />}
      </div>
      <Card
        className={cn('mb-4 min-w-0 flex-1 border shadow-none ring-0', diff.change === 'added' && 'border-green-600/30', diff.change === 'removed' && 'border-red-600/30')}
        data-unit-id={diff.id}
        data-change={diff.change === 'unchanged' && diff.movedFrom ? 'moved' : diff.change}
        data-moved={!!diff.movedFrom}
      >
        <CardHeader>
          <CardTitle className="flex flex-col gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-normal text-muted-foreground">{index}</span>
              <ChangeBadge change={diff.change} />
              {unit && <StatusPill status={unit.status} />}
              {isCurrent && <Badge variant="outline">{t('route.currentViewing')}</Badge>}
              {diff.movedFrom && <Badge variant="outline">{t('route.moved')}</Badge>}
            </span>
            <InlineDiff before={diff.before?.title} after={diff.after?.title} />
          </CardTitle>
          <CardDescription className="leading-relaxed">
            <InlineDiff before={diff.before?.summary} after={diff.after?.summary} />
          </CardDescription>
          {canView && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => enterUnit(diff.id)}>
                {t('route.viewExistingLesson')}<ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <GoalDiff before={diff.before?.goals} after={diff.after?.goals} />
          {diff.movedFrom && <p className="text-xs text-muted-foreground">{diff.movedFrom}</p>}
          {unit?.status === 'needs_work' && unit.lastAdvice?.[0] && (
            <Alert>
              <Lightbulb />
              <AlertDescription>{t('route.lastAdvice', { advice: unit.lastAdvice[0] })}</AlertDescription>
            </Alert>
          )}
          {diff.change === 'added' && <p className="text-xs text-muted-foreground">{t('route.addedUnitHint')}</p>}
          {diff.change === 'removed' && <p className="text-xs text-muted-foreground">{t('route.removedUnitHint')}</p>}
          {diff.before && diff.after && !canView && (
            <p className="text-xs text-muted-foreground">{available ? t('route.previewHint') : t('route.lockedPreviewHint')}</p>
          )}
        </CardContent>
      </Card>
    </li>
  )
}

function ProposalRoute({ proposal, space }: { proposal: Proposal; space: Space }) {
  const { t } = useTranslation('learning')
  const diff = diffRoute(space.stages.length ? { note: space.routeNote, stages: space.stages } : null, proposal.content)
  const units = new Map(allUnits(space).map((unit) => [unit.id, unit]))
  const available = availableUnitIds(space)
  return (
    <section className="flex flex-col gap-6" aria-labelledby="route-proposal-title" data-testid="route-proposal" data-proposal-id={proposal.id}>
      <div className="flex flex-col gap-2 border-b pb-4">
        <h2 id="route-proposal-title" className="flex items-center gap-2 text-lg font-semibold">
          <Route className="size-4" aria-hidden />{t('route.preview')}<Badge variant="outline">{t('route.pending')}</Badge>
        </h2>
        <p className="text-sm leading-relaxed">{routeDiffSummary(diff)}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('route.diffHint')}</p>
      </div>

      {(diff.note.before || diff.note.after) && (
        <Alert>
          <Sparkles />
          <AlertTitle>{t('route.rationale')}</AlertTitle>
          <AlertDescription className="leading-relaxed"><InlineDiff before={space.stages.length ? diff.note.before : undefined} after={diff.note.after} /></AlertDescription>
        </Alert>
      )}

      {diff.stages.map((stage) => {
        const oldIndex = space.stages.findIndex((previous) => previous.id === stage.id)
        const newIndex = proposal.content.stages.findIndex((next) => next.id === stage.id)
        return (
          <section key={stage.id} aria-labelledby={`stage-${stage.id}`} className="flex flex-col gap-5" data-change={stage.change === 'unchanged' && stage.moved ? 'moved' : stage.change}>
            <h3 id={`stage-${stage.id}`} className="flex flex-wrap items-center gap-3 text-lg font-semibold tracking-tight">
              <span className="flex h-6 items-center rounded-md bg-foreground px-2 font-mono text-xs text-background">
                {stage.after ? t('route.stage', { number: newIndex + 1 }) : t('route.originalStage', { number: oldIndex + 1 })}
              </span>
              <InlineDiff before={stage.before?.title} after={stage.after?.title} />
              <ChangeBadge change={stage.change} />
              {stage.moved && <Badge variant="outline">{t('route.movedStage', { number: oldIndex + 1 })}</Badge>}
            </h3>
            <ol className="flex flex-col">
              {stage.units.map((unit, index) => (
                <ProposalUnitRow
                  key={unit.id}
                  diff={unit}
                  unit={units.get(unit.id)}
                  index={unit.after ? `${newIndex + 1}.${stage.after!.units.findIndex((next) => next.id === unit.id) + 1}` : t('route.originalUnit', { number: `${oldIndex + 1}.${stage.before!.units.findIndex((previous) => previous.id === unit.id) + 1}` })}
                  isLast={index === stage.units.length - 1}
                  available={available.has(unit.id)}
                  isCurrent={unit.id === space.currentUnitId && !!unit.after}
                />
              ))}
            </ol>
            {!stage.units.length && <p className="text-sm text-muted-foreground">{t('route.transferred')}</p>}
          </section>
        )
      })}
    </section>
  )
}

function UnitRow({ unit, index, isCurrent, isLast, locked }: { unit: Unit; index: string; isCurrent: boolean; isLast: boolean; locked: boolean }) {
  const { t } = useTranslation('learning')
  const { enterUnit, capabilities } = useApp()
  const finished = unit.status === 'passed' || unit.status === 'skipped'
  const verb = finished ? t('route.review') : unit.status === 'not_started' ? t('route.enter') : t('route.continue')
  return (
    <li className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <StatusIcon status={unit.status} />
        {!isLast && (
          <span aria-hidden className={cn('my-1 w-px flex-1', finished ? 'bg-primary/50' : 'bg-border')} />
        )}
      </div>
      <Card
        className={cn(
          'mb-4 flex-1 transition-shadow',
          isCurrent ? 'shadow-md ring-2 ring-primary/60' : 'hover:shadow-sm',
          unit.status === 'skipped' && 'opacity-70',
          locked && 'bg-muted/30',
        )}
      >
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-normal text-muted-foreground">{index}</span>
            {unit.title}
            <StatusPill status={unit.status} />
            {isCurrent && <Badge variant="outline" className="border-primary/40 text-primary">{t('route.currentUnit')}</Badge>}
          </CardTitle>
          <CardDescription className="leading-relaxed">{unit.summary}</CardDescription>
          {unit.historicalPass && unit.status !== 'passed' && <p className="text-xs leading-relaxed text-muted-foreground">{unit.status === 'needs_work' ? t('route.historicalNeedsWork') : t('route.historicalUnassessed')}</p>}
          <CardAction>
            <Button variant={isCurrent ? 'default' : 'outline'} size="sm" disabled={locked} onClick={() => enterUnit(unit.id)}>
              {locked ? t('route.locked') : verb}
              {locked ? <Lock data-icon="inline-end" /> : <ArrowRight data-icon="inline-end" />}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-1.5" aria-label={t('route.goals')}>
            {unit.goals.map((g) => (
              <li key={g}>
                <Badge variant="secondary" className="font-normal">
                  {g}
                </Badge>
              </li>
            ))}
          </ul>
          {unit.status === 'needs_work' && unit.lastAdvice?.[0] && (
            <Alert className="border-accent-foreground/20 bg-accent/60 text-accent-foreground">
              <Lightbulb />
              <AlertDescription className="text-accent-foreground">{t('route.lastAdvice', { advice: unit.lastAdvice[0] })}</AlertDescription>
            </Alert>
          )}
          {locked ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" aria-hidden />
              {t('route.unlockHint')}
            </p>
          ) : unit.contentState !== 'ready' && unit.status !== 'skipped' && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="size-3" aria-hidden />
              {capabilities.agent ? t('route.generateHint') : t('route.noLesson')}
            </p>
          )}
        </CardContent>
      </Card>
    </li>
  )
}

export function RouteView() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { session, enterUnit, sendMessage, setRouteSuggestion, setView, capabilities, persistence } = useApp()
  const suggestion = session?.routeSuggestion ?? ''
  const latest = useRef<{ sessionId: string | undefined; suggestion: string } | null>(null)
  latest.current = { sessionId: session?.id, suggestion }
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<NoticeValue>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (space.agentOpen) document.getElementById('agent-input')?.focus({ preventScroll: true })
  }, [space.agentOpen])

  useEffect(() => () => { latest.current = null }, [])
  useEffect(() => setSendError(null), [session?.id, session?.messages.length])

  const proposal = persistence?.proposals.findLast((proposal) => proposal.state === 'pending')
  const adjusting = persistence?.routeAdjustmentRun?.state === 'pending' || persistence?.routeAdjustmentRun?.state === 'running'
  const busy = sending || adjusting || !!persistence && (persistence.busy || !persistence.ready || !!pendingDecision(persistence)) || capabilities.agent && !!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming')
  const submitSuggestion = async () => {
    if (!suggestion.trim() || proposal || busy || sendingRef.current) return
    const submittedSessionId = session?.id
    sendingRef.current = true
    setSending(true)
    setSendError(null)
    try {
      const sent = await sendMessage(suggestion)
      if (sent && latest.current?.sessionId === submittedSessionId && latest.current?.suggestion === suggestion) {
        setRouteSuggestion('')
      }
    } catch (error) {
      setSendError(error instanceof Error ? error : notice('learning', 'route.suggestionSaveFailed'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const units = allUnits(space)
  const available = availableUnitIds(space)
  const done = units.filter((u) => u.status === 'passed' || u.status === 'skipped').length
  const recommended = recommendedUnit(space)
  const req = space.requirement

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-8 py-10">
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Badge variant="outline" className="w-fit font-mono">
              {t('controls.learningPath')}
            </Badge>
            <h1 className="text-balance text-4xl font-semibold tracking-tight">{space.name}</h1>
            {req?.rows.some((row) => row.answer.trim()) && <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{req.rows.find((row) => row.answer.trim())?.answer}</p>}
          </div>

          {!proposal && (persistence && units.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('route.noPath')}</CardTitle>
                <CardDescription>{capabilities.agent ? t('route.noPathHint') : t('route.unavailableNoPathHint')}</CardDescription>
                <CardAction>
                  <Button variant="outline" onClick={() => setView('onboarding')}>{t('route.viewRequirements')}</Button>
                </CardAction>
              </CardHeader>
            </Card>
          ) : space.completed ? (
            <Alert className="border-primary/30 bg-primary/10">
              <Trophy />
              <AlertTitle>{t('route.completed')}</AlertTitle>
              <AlertDescription>{capabilities.agent ? t('route.completedHint') : t('route.unavailableCompletedHint')}</AlertDescription>
            </Alert>
          ) : (
            recommended && (
              <Card className="bg-primary text-primary-foreground ring-0">
                <CardHeader>
                  <CardDescription className="text-primary-foreground/75">{t('route.recommendation')}</CardDescription>
                  <CardTitle className="text-xl">{recommended.title}</CardTitle>
                  <CardAction>
                    <Button size="lg" variant="secondary" onClick={() => enterUnit(recommended.id)}>
                      {recommended.status === 'not_started' ? t('route.startLearning') : t('route.continueLearning')}
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm leading-relaxed text-primary-foreground/85">{recommended.summary}</p>
                  <div className="flex items-center gap-3">
                    <Progress
                      value={(done / Math.max(units.length, 1)) * 100}
                      aria-label={t('route.progress')}
                      className="flex-1 [&_[data-slot=progress-indicator]]:bg-primary-foreground [&_[data-slot=progress-track]]:bg-primary-foreground/25"
                    />
                    <span className="font-mono text-xs text-primary-foreground/85">
                      {t('route.unitProgress', { done, count: units.length })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )
          ))}

          {!proposal && req && (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
              {req.rows.map((row, index) => (
                <div key={index} className="flex flex-col gap-1.5 rounded-xl border bg-card p-4">
                  <dt className="text-xs font-medium text-muted-foreground">{row.question}</dt>
                  <dd className="whitespace-pre-wrap break-words leading-relaxed">{row.answer || t('controls.pendingAnswer')}</dd>
                </div>
              ))}
            </dl>
          )}

          {!proposal && space.routeNote && (
            <Alert>
              <Sparkles />
              <AlertTitle>{t('route.rationale')}</AlertTitle>
              <AlertDescription className="leading-relaxed">{space.routeNote}</AlertDescription>
            </Alert>
          )}
        </section>

        {proposal ? <ProposalRoute proposal={proposal} space={space} /> : space.stages.map((stage, si) => (
          <section key={stage.id} aria-labelledby={`stage-${stage.id}`} className="flex flex-col gap-5">
            <h2 id={`stage-${stage.id}`} className="flex items-center gap-3 text-lg font-semibold tracking-tight">
              <span className="flex h-6 items-center rounded-md bg-foreground px-2 font-mono text-xs text-background">
                {t('route.stage', { number: si + 1 })}
              </span>
              {stage.title}
            </h2>
            <ol className="flex flex-col">
              {stage.units.map((u, ui) => (
                <UnitRow
                  key={u.id}
                  unit={u}
                  index={`${si + 1}.${ui + 1}`}
                  isCurrent={u.id === space.currentUnitId && !space.completed}
                  isLast={ui === stage.units.length - 1}
                  locked={!available.has(u.id)}
                />
              ))}
            </ol>
          </section>
        ))}

        {!proposal && <section aria-labelledby="route-feedback-title" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="route-feedback-title" className="text-base font-medium">{t('route.feedbackTitle')}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{capabilities.agent ? t('route.feedbackHint') : t('route.unavailableFeedbackHint')}</p>
          </div>
          <div>
            <motion.div
              initial={false}
              animate={{ gridTemplateRows: space.agentOpen ? '0fr' : '1fr', opacity: space.agentOpen ? 0 : 1 }}
              transition={{ duration: reducedMotion ? 0 : uiMotion.panel }}
              className="grid"
              inert={space.agentOpen}
              aria-hidden={space.agentOpen}
            >
              <div className="min-h-0 overflow-hidden">
                <PromptInput className="p-1" onReset={(event) => event.preventDefault()} onSubmit={() => submitSuggestion()}>
                    <PromptInputTextarea
                      aria-label={t('route.suggestion')}
                      placeholder={t('route.suggestionPlaceholder')}
                      rows={2}
                      value={suggestion}
                      onChange={(e) => setRouteSuggestion(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                          e.preventDefault()
                          void submitSuggestion()
                        }
                      }}
                    />
                    <PromptInputFooter>
                      <span className="text-xs font-normal">{adjusting ? t('route.adjusting') : busy ? persistence ? t('route.storageBusy') : t('route.replying') : capabilities.agent ? t('route.sendHint') : t('route.saveHint')}</span>
                      <PromptInputSubmit className="ml-auto" disabled={busy || !suggestion.trim()} aria-label={capabilities.agent ? t('route.sendSuggestion') : t('route.saveSuggestion')} />
                    </PromptInputFooter>
                </PromptInput>
                {!!sendError && <p role="alert" className="text-xs text-destructive">{formatNotice(sendError)}</p>}
              </div>
            </motion.div>
            {space.agentOpen && (
              <Button
                variant="link"
                className="h-8 px-0"
                aria-controls="agent-input"
                onClick={() => document.getElementById('agent-input')?.focus({ preventScroll: true })}
              >
                {capabilities.agent ? t('route.continueAgent') : t('route.continueConversation')}
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
          </div>
        </section>}
      </div>
    </div>
  )
}

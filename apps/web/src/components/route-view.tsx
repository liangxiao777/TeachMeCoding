'use client'

import { ArrowRight, Lightbulb, Lock, Route, Sparkles, Trophy } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { StatusIcon, StatusPill, isComposing } from '@/components/shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Progress } from '@/components/ui/progress'
import { allUnits, availableUnitIds, findUnit } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { uiMotion } from '@/lib/motion'
import type { Unit } from '@/app/types'

function UnitRow({ unit, index, isCurrent, isLast, locked }: { unit: Unit; index: string; isCurrent: boolean; isLast: boolean; locked: boolean }) {
  const { enterUnit, capabilities } = useApp()
  const finished = unit.status === 'passed' || unit.status === 'skipped'
  const verb = finished ? '复习' : unit.status === 'not_started' ? '进入' : '继续'
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
            {isCurrent && <Badge variant="outline" className="border-primary/40 text-primary">当前单元</Badge>}
          </CardTitle>
          <CardDescription className="leading-relaxed">{unit.summary}</CardDescription>
          <CardAction>
            <Button variant={isCurrent ? 'default' : 'outline'} size="sm" disabled={locked} onClick={() => enterUnit(unit.id)}>
              {locked ? '未解锁' : verb}
              {locked ? <Lock data-icon="inline-end" /> : <ArrowRight data-icon="inline-end" />}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-1.5" aria-label="单元目标">
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
              <AlertDescription className="text-accent-foreground">上次测评建议：{unit.lastAdvice[0]}</AlertDescription>
            </Alert>
          )}
          {locked ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" aria-hidden />
              前序单元的课件全部保存后解锁，无需测评通过
            </p>
          ) : unit.contentState !== 'ready' && unit.status !== 'skipped' && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="size-3" aria-hidden />
              {capabilities.agent ? '进入后为你生成课件' : '尚无课件 · Agent 暂不可用'}
            </p>
          )}
        </CardContent>
      </Card>
    </li>
  )
}

export function RouteView() {
  const space = useSpace()
  const { session, enterUnit, sendMessage, setRouteSuggestion, setView, capabilities, persistence } = useApp()
  const suggestion = session?.routeSuggestion ?? ''
  const latest = useRef<{ sessionId: string | undefined; suggestion: string } | null>(null)
  latest.current = { sessionId: session?.id, suggestion }
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (space.agentOpen) document.getElementById('agent-input')?.focus({ preventScroll: true })
  }, [space.agentOpen])

  useEffect(() => () => { latest.current = null }, [])
  useEffect(() => setSendError(''), [session?.id, session?.messages.length])

  const busy = sending || !!persistence && (persistence.busy || !persistence.ready) || capabilities.agent && !!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming')
  const submitSuggestion = async () => {
    if (!suggestion.trim() || busy || sendingRef.current) return
    const submittedSessionId = session?.id
    sendingRef.current = true
    setSending(true)
    setSendError('')
    try {
      const sent = await sendMessage(suggestion)
      if (sent && latest.current?.sessionId === submittedSessionId && latest.current?.suggestion === suggestion) {
        setRouteSuggestion('')
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '路线调整想法未保存，请重试。')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const units = allUnits(space)
  const available = availableUnitIds(space)
  const done = units.filter((u) => u.status === 'passed' || u.status === 'skipped').length
  const selectedUnit = findUnit(space, space.currentUnitId)
  const current = selectedUnit && available.has(selectedUnit.id) ? selectedUnit : units.find((unit) => available.has(unit.id))
  const req = space.requirement

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-8 py-10">
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Badge variant="outline" className="w-fit font-mono">
              学习路线
            </Badge>
            <h1 className="text-balance text-4xl font-semibold tracking-tight">{space.name}</h1>
            {req?.rows.some((row) => row.answer.trim()) && <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{req.rows.find((row) => row.answer.trim())?.answer}</p>}
          </div>

          {persistence && units.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>尚无学习路线</CardTitle>
                <CardDescription>{capabilities.agent ? '尚未保存学习路线。确认需求并应用路线提案后，学习单元会显示在这里。' : 'Agent 暂不可用，不会自动生成路线。已有路线提案需手动确认；目前没有学习单元或进度。'}</CardDescription>
                <CardAction>
                  <Button variant="outline" onClick={() => setView('onboarding')}>查看学习需求</Button>
                </CardAction>
              </CardHeader>
            </Card>
          ) : space.completed ? (
            <Alert className="border-primary/30 bg-primary/10">
              <Trophy />
              <AlertTitle>你已完成这条学习路线</AlertTitle>
              <AlertDescription>{capabilities.agent ? '随时可以回到任一单元复习，或和 Agent 讨论下一步学什么。' : '随时可以回到任一单元复习，或记录下一步想学习的问题。Agent 暂不可用。'}</AlertDescription>
            </Alert>
          ) : (
            current && (
              <Card className="bg-primary text-primary-foreground ring-0">
                <CardHeader>
                  <CardDescription className="text-primary-foreground/75">推荐从这里继续</CardDescription>
                  <CardTitle className="text-xl">{current.title}</CardTitle>
                  <CardAction>
                    <Button size="lg" variant="secondary" onClick={() => enterUnit(current.id)}>
                      {current.status === 'not_started' ? '开始学习' : '继续学习'}
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm leading-relaxed text-primary-foreground/85">{current.summary}</p>
                  <div className="flex items-center gap-3">
                    <Progress
                      value={(done / Math.max(units.length, 1)) * 100}
                      aria-label="路线进度"
                      className="flex-1 [&_[data-slot=progress-indicator]]:bg-primary-foreground [&_[data-slot=progress-track]]:bg-primary-foreground/25"
                    />
                    <span className="font-mono text-xs text-primary-foreground/85">
                      {done}/{units.length} 单元
                    </span>
                  </div>
                </CardContent>
              </Card>
            )
          )}

          {req && (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
              {req.rows.map((row, index) => (
                <div key={index} className="flex flex-col gap-1.5 rounded-xl border bg-card p-4">
                  <dt className="text-xs font-medium text-muted-foreground">{row.question}</dt>
                  <dd className="whitespace-pre-wrap break-words leading-relaxed">{row.answer || '待补充'}</dd>
                </div>
              ))}
            </dl>
          )}

          {space.routeNote && (
            <Alert>
              <Sparkles />
              <AlertTitle>为什么这样安排</AlertTitle>
              <AlertDescription className="leading-relaxed">{space.routeNote}</AlertDescription>
            </Alert>
          )}
        </section>

        {persistence?.proposals.filter((proposal) => proposal.state === 'pending').map((proposal) => (
          <Card key={proposal.id} size="sm" className="ring-primary/30" data-testid="route-proposal" data-proposal-id={proposal.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Route className="size-4 text-primary" aria-hidden />
                待确认的路线调整
              </CardTitle>
              <CardDescription className="text-xs leading-relaxed">{proposal.content.note || '确认后才会更新学习路线。'}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                {proposal.content.stages.map((stage) => (
                  <li key={stage.id}>{stage.title}：{stage.units.map((unit) => unit.title).join('、')}</li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button size="sm" disabled={persistence.busy || !persistence.ready} onClick={() => persistence.applyProposal(proposal.id)}>
                确认调整路线
              </Button>
            </CardFooter>
          </Card>
        ))}

        {space.stages.map((stage, si) => (
          <section key={stage.id} aria-labelledby={`stage-${stage.id}`} className="flex flex-col gap-5">
            <h2 id={`stage-${stage.id}`} className="flex items-center gap-3 text-lg font-semibold tracking-tight">
              <span className="flex h-6 items-center rounded-md bg-foreground px-2 font-mono text-xs text-background">
                阶段 {si + 1}
              </span>
              {stage.title}
            </h2>
            <ol className="flex flex-col">
              {stage.units.map((u, ui) => (
                <UnitRow
                  key={u.id}
                  unit={u}
                  index={`${si + 1}.${ui + 1}`}
                  isCurrent={u.id === current?.id && !space.completed}
                  isLast={ui === stage.units.length - 1}
                  locked={!available.has(u.id)}
                />
              ))}
            </ol>
          </section>
        ))}

        <section aria-labelledby="route-feedback-title" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="route-feedback-title" className="text-base font-medium">觉得路线不合适？</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{capabilities.agent ? '直接告诉 Agent 你的想法，它会给出调整建议，你确认后路线才会更新。' : 'Agent 暂不可用。可以保存路线调整想法，但不会生成建议或自动更新路线。'}</p>
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
                      aria-label="路线调整想法"
                      placeholder="说说你想怎么调整，例如：基础语法我已经会了，想先做项目…"
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
                      <span className="text-xs font-normal">{busy ? persistence ? '正在读取或保存…' : 'Agent 正在回复…' : capabilities.agent ? 'Enter 发送 · Shift + Enter 换行' : 'Enter 保存想法 · Shift + Enter 换行'}</span>
                      <PromptInputSubmit className="ml-auto" disabled={busy || !suggestion.trim()} aria-label={capabilities.agent ? '发送路线调整想法' : '保存路线调整想法'} />
                    </PromptInputFooter>
                </PromptInput>
                {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
              </div>
            </motion.div>
            {space.agentOpen && (
              <Button
                variant="link"
                className="h-8 px-0"
                aria-controls="agent-input"
                onClick={() => document.getElementById('agent-input')?.focus({ preventScroll: true })}
              >
                {capabilities.agent ? '在 Agent 中继续' : '在会话中继续记录'}
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

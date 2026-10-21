'use client'

import { ArrowLeft, Check, ClipboardList, Pencil, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNotice, notice, type NoticeValue } from '@/i18n/notice'
import { AgentMessage, SessionMenu } from '@/components/agent/agent-panel'
import { RunContent } from '@/components/agent/run-content'
import { RunContext } from '@/components/agent/run-context'
import { YoloSwitch } from '@/components/agent/yolo-switch'
import { PromptQueue } from '@/components/agent/prompt-queue'
import { RouteProposalDecision } from '@/components/agent/route-proposal-decision'
import { LessonProposalDecision } from '@/components/agent/lesson-proposal-decision'
import { pendingDecision } from '@/app/lesson-proposals'
import { QuestionRoundCard, ResearchCard } from '@/components/intake-panel'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Generating, isComposing } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApp, useSpace, type RequirementDraft } from '@/app/context'
import { ThemeToggle } from '@/app/theme'
import { LibraryButton } from '@/components/library-page'

function RequirementCard() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { updateRequirement, confirmRequirement, setView, capabilities, persistence } = useApp()
  const [previewEditing, setEditing] = useState(false)
  const [previewDraft, setPreviewDraft] = useState<RequirementDraft | null>(null)
  const draft = persistence ? persistence.requirementDraft : previewDraft
  const setDraft = persistence ? persistence.setRequirementDraft : setPreviewDraft
  const editing = persistence ? draft !== null : previewEditing
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<NoticeValue>(null)
  const savingRef = useRef(false)
  const req = space.requirement
  const busy = saving || !!persistence && (persistence.busy || !persistence.ready || !!pendingDecision(persistence))
  const validRows = !draft || draft.rows.every((row) => row.question.trim())

  const save = async () => {
    if (!draft || busy || savingRef.current || !validRows) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await updateRequirement(draft)
      if (saved === false) {
        setSaveError(notice('learning', 'requirement.saveFailed'))
        return
      }
      setEditing(false)
    } catch (error) {
      setSaveError(error instanceof Error ? error : notice('learning', 'requirement.saveFailed'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if ((!space.onboarding.summaryReady && !persistence) || !req) {
    return (
      <Card className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
        <CardHeader>
          <CardTitle>{t('requirement.title')}</CardTitle>
          {!capabilities.agent && <CardDescription>{t('requirement.manualHint')}</CardDescription>}
        </CardHeader>
        <CardContent>
          <div className="space-y-4" aria-label={t('requirement.preparing')}>
            <div className="grid grid-cols-[2fr_3fr] gap-4 text-xs font-medium text-muted-foreground"><span>{t('requirement.question')}</span><span>{t('requirement.answer')}</span></div>
            {[0, 1, 2].map((index) => <div key={index} className="grid grid-cols-[2fr_3fr] gap-4"><Skeleton className="h-3 animate-none" /><Skeleton className="h-3 animate-none" /></div>)}
          </div>
        </CardContent>
      </Card>
    )
  }

  const current: RequirementDraft = editing && draft ? draft : { ...req, intake: persistence?.intake }
  const awaitingSummary = !req.rows.some((row) => row.answer.trim())
  const readinessIssues = persistence && !persistence.readiness?.ready
    ? persistence.readiness?.issues.filter((issue) => issue.code !== 'REQUIREMENT_EMPTY' || !editing && current.rows.length > 0)
      ?? [notice('learning', 'requirement.loadingReadiness')]
    : []
  const editRow = (index: number, field: 'question' | 'answer', value: string) => setDraft({ ...current,
    rows: current.rows.map((row, at) => at === index ? { ...row, [field]: value } : row) })
  return (
    <Card aria-labelledby="req-title" className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
      <CardHeader>
        <CardTitle id="req-title" className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" aria-hidden />
          {t('requirement.title')}
        </CardTitle>
        {!capabilities.agent && <CardDescription>{t('requirement.manualHint')}</CardDescription>}
        <CardAction>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setDraft(null); setSaveError(null) }}>
              {t('controls.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy || !validRows}
              onClick={() => void save()}
            >
              {saving ? t('controls.saving') : t('controls.save')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft({ ...req, rows: req.rows.length ? structuredClone(req.rows) : [{ question: '', answer: '' }], intake: persistence?.intake })
              setSaveError(null)
              setEditing(true)
            }}
          >
            <Pencil data-icon="inline-start" />
            {t('requirement.modify')}
          </Button>
        )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {!!saveError && <p role="alert" className="mb-3 text-sm text-destructive">{formatNotice(saveError)}</p>}
        {current.rows.length > 0 ? <table aria-label={t('requirement.table')} className="w-full table-fixed text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="w-2/5 px-2 pb-3 font-medium">{t('requirement.question')}</th>
            <th scope="col" className="px-2 pb-3 font-medium">{t('requirement.answer')}</th>
          </tr></thead>
          <tbody>{current.rows.map((row, index) => <tr key={index} className="border-b last:border-0">
            <td className="px-2 py-3 align-top whitespace-pre-wrap break-words font-medium leading-relaxed">
              {editing ? <Textarea aria-label={t('requirement.questionNumber', { number: index + 1 })} rows={2} maxLength={10_000}
                value={row.question} onChange={(event) => editRow(index, 'question', event.target.value)} className="resize-y leading-relaxed" /> : row.question}
            </td>
            <td className="px-2 py-3 align-top whitespace-pre-wrap break-words leading-relaxed">
              {editing ? <div className="space-y-2"><Textarea aria-label={t('requirement.answerNumber', { number: index + 1 })} rows={3} maxLength={100_000}
                value={row.answer} onChange={(event) => editRow(index, 'answer', event.target.value)} className="resize-y leading-relaxed" />
                <Button variant="ghost" size="xs" disabled={saving} aria-label={t('requirement.removeRow', { number: index + 1 })}
                  onClick={() => setDraft({ ...current, rows: current.rows.filter((_, at) => at !== index) })}><Trash2 aria-hidden />{t('controls.remove')}</Button>
              </div> : row.answer || <span className="text-muted-foreground">{t('controls.pendingAnswer')}</span>}
            </td>
          </tr>)}</tbody>
        </table> : <p className="py-3 text-sm leading-relaxed text-muted-foreground">{t('requirement.empty')}</p>}
        {editing && <div className="mt-4 space-y-3">
          <Button variant="outline" size="sm" disabled={saving || current.rows.length >= 100}
            onClick={() => setDraft({ ...current, rows: [...current.rows, { question: '', answer: '' }] })}><Plus aria-hidden />{t('requirement.addQuestion')}</Button>
          {!validRows && <p role="status" className="text-xs text-muted-foreground">{t('requirement.questionRequired')}</p>}
        </div>}
        {!editing && current.intake?.researchRef && <ResearchCard key={`${space.id}:${current.intake.researchRef.id}`} researchRef={current.intake.researchRef} />}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 border-t">
        {readinessIssues.length > 0 && <div id="req-readiness" role="status" className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          {readinessIssues.map((reason, index) => <p key={index} className="whitespace-pre-wrap break-words">{formatNotice(reason)}</p>)}
        </div>}
        <Button size="lg" aria-describedby={readinessIssues.length > 0 ? 'req-readiness' : undefined}
          disabled={editing || busy || awaitingSummary || persistence?.requirementConfirmed || !!persistence && !persistence.readiness?.ready} onClick={confirmRequirement}>
          <Check data-icon="inline-start" />
          {persistence?.requirementConfirmed ? t('requirement.confirmed') : capabilities.agent ? t('requirement.confirmAndPlan') : t('requirement.confirm')}
        </Button>
        {persistence?.requirementConfirmed && (
          <Button variant="outline" size="lg" disabled={editing || busy} onClick={() => setView(!space.stages.length && persistence.planning.run ? 'planning' : 'route')}>
            {!space.stages.length && persistence.planning.run ? t('requirement.viewPlanning') : t('requirement.viewPath')}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

function Chat() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { onboardSend, sendMessage, stopReply, session, setComposerText, capabilities, persistence } = useApp()
  const [previewText, setPreviewText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<NoticeValue>(null)
  const sendingRef = useRef(false)
  const text = persistence ? session?.composerText ?? '' : previewText
  const setText = persistence ? setComposerText : setPreviewText
  const { messages } = space.onboarding
  const proposal = persistence?.proposals.findLast((proposal) => proposal.state === 'pending')
  const lessonProposal = persistence?.lessonProposals.findLast((proposal) => proposal.state === 'pending')
  const replying = capabilities.agent && space.onboarding.agentTyping
  const busy = !!proposal || !!lessonProposal || !persistence && replying || sending || !!persistence && (persistence.busy || !persistence.ready)

  useEffect(() => setSendError(null), [session?.id, messages.length])

  const send = async (value: string, fromComposer = false) => {
    if (!value.trim() || busy || sendingRef.current) return
    if (!persistence) {
      onboardSend(value)
      setPreviewText('')
      return
    }
    sendingRef.current = true
    setSending(true)
    setSendError(null)
    try {
      // Keep the provider draft intact through failed, retried, or delayed requests.
      await sendMessage(fromComposer ? undefined : value)
    } catch (error) {
      setSendError(error instanceof Error ? error : notice('learning', 'onboarding.saveQuestionFailed'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  return (
    <div className="flex h-[70dvh] min-h-[28rem] min-w-0 flex-1 flex-col lg:h-auto lg:min-h-0">
      {persistence && <div className="flex h-12 shrink-0 items-center border-b px-4 sm:px-6"><SessionMenu /></div>}
      <Conversation key={session?.id ?? space.id} className="min-h-0" initial="instant" resize="instant" aria-label={t('onboarding.conversation')}>
        <ConversationContent className="gap-6 px-4 py-8 sm:px-6"
          scrollClassName="[scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
          {(!persistence || messages.length === 0) && <Message from="assistant">
            <MessageContent>
              {capabilities.agent ? t('onboarding.greeting') : t('onboarding.unavailableGreeting')}
            </MessageContent>
          </Message>}
          {messages.map((m) =>
            m.role === 'user' ? (
              <Message key={m.id} from="user"><MessageContent><p className="whitespace-pre-wrap">{m.text}</p></MessageContent></Message>
            ) : (
              <div key={m.id} className="min-w-0 space-y-3">
                <AgentMessage msg={{ ...m, createdAt: 0 }} />
                {persistence?.questions.filter((round) => round.runId === m.id && (round.state !== 'pending' || m.status === 'done')).map((round) => (
                  <QuestionRoundCard key={round.id} round={round} disabled={busy || !capabilities.agent} onAnswer={persistence.answerQuestions} />
                ))}
              </div>
            ),
          )}
          {!persistence && replying && (
            <div role="status" className="text-sm text-muted-foreground">
              <Shimmer>{t('onboarding.waiting')}</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton className="left-auto right-0 translate-x-0 sm:right-2" aria-label={t('onboarding.latest')} />
      </Conversation>

      <PromptQueue className="px-4 sm:px-6" />
      {proposal ? <RouteProposalDecision key={proposal.id} proposal={proposal} /> : lessonProposal ? <LessonProposalDecision key={lessonProposal.id} proposal={lessonProposal} /> : <div className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-6 sm:px-6">
        <PromptInput onReset={(event) => event.preventDefault()} onSubmit={() => send(text, true)}>
            <label htmlFor="ob-input" className="sr-only">
              {t('onboarding.reply')}
            </label>
            <PromptInputTextarea
              id="ob-input"
              rows={2}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                  e.preventDefault()
                  void send(text, true)
                }
              }}
              placeholder={t('onboarding.placeholder')}
              className="leading-relaxed"
            />
            <PromptInputFooter>
              <YoloSwitch />
              <RunContext runId={session?.messages.findLast((m) => m.role === 'agent')?.runId ?? session?.messages.findLast((m) => m.role === 'agent')?.id} />
              <span className="hidden text-xs text-muted-foreground sm:inline">
                <Kbd>Enter</Kbd>{capabilities.agent ? t('onboarding.sendShortcut') : t('onboarding.saveShortcut')}<Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>{t('onboarding.newline')}
              </span>
              {persistence && replying && <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" onClick={stopReply} aria-label={t('controls.stop')}><Square /></Button>}
              <PromptInputSubmit className={persistence && replying ? undefined : 'ml-auto'} status="ready"
                disabled={!text.trim() || busy} aria-label={persistence && replying ? t('queue.enqueue', { ns: 'workbench' }) : capabilities.agent ? t('controls.send') : t('controls.saveQuestion')} />
            </PromptInputFooter>
        </PromptInput>
        {!!sendError && <p role="alert" className="text-xs text-destructive">{formatNotice(sendError)}</p>}
      </div>}
    </div>
  )
}

export function Onboarding() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { goSpaces, renameSpace, setView, retryReply, stopReply, capabilities, persistence } = useApp()
  const planning = persistence?.planning
  const planningStopped = planning?.run && ['failed', 'interrupted'].includes(planning.run.state)
  const planningParts = space.sessions.flatMap((s) => s.messages).find((m) => m.id === planning?.run?.id)?.parts ?? []

  if (space.view === 'planning') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6 py-8">
        <div className="fixed top-3 right-3 z-10 flex items-center gap-2"><LibraryButton /><ThemeToggle /></div>
        <Card className="w-full max-w-xl shadow-lg">
          <CardContent>
            {planningStopped || persistence && (!capabilities.agent || persistence.error) ? (
              <div className="flex flex-col gap-3">
                <h1 className="text-base font-semibold">{planning?.run?.state === 'interrupted' ? t('onboarding.planningStopped') : t('onboarding.planningIncomplete')}</h1>
                <p role="alert" className="text-sm text-muted-foreground">{formatNotice(planning?.error || persistence?.error) || t('onboarding.planningFallback')}</p>
                <RunContent parts={planningParts} />
              </div>
            ) : <Generating
              title={t('onboarding.planningTitle', { name: space.name })}
              steps={persistence ? [t('onboarding.analyzeRequirements'), t('onboarding.generatePath'), t('onboarding.validatePath'), t('onboarding.savePath')] : [t('onboarding.analyzeBackground'), t('onboarding.splitStages'), t('onboarding.arrangeUnits'), t('onboarding.prepareNotes')]}
              note={t('onboarding.planningNote')}
              parts={persistence ? planningParts : undefined}
              context={<RunContext runId={planning?.run?.id} />}
            />}
            {persistence && <div className="mt-6 flex flex-wrap gap-2">
              {planning?.run && ['failed', 'interrupted'].includes(planning.run.state) ? (
                <Button disabled={persistence.busy || !capabilities.agent} onClick={() => retryReply(planning.run!.id)}>{t('onboarding.retryPlanning')}</Button>
              ) : planning?.run && ['pending', 'running'].includes(planning.run.state) ? (
                <Button variant="outline" disabled={persistence.busy} onClick={stopReply}>{t('onboarding.stopPlanning')}</Button>
              ) : null}
              <Button variant="ghost" onClick={goSpaces}>{t('controls.allSpaces')}</Button>
              {(!planning?.run || planningStopped) && <Button variant="ghost" onClick={() => setView('onboarding')}>{t('onboarding.editRequirements')}</Button>}
            </div>}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="shrink-0 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={goSpaces}>
            <ArrowLeft data-icon="inline-start" />
            {t('controls.allSpaces')}
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <label htmlFor="space-name" className="sr-only">
            {t('onboarding.spaceName')}
          </label>
          <Input
            id="space-name"
            value={space.name}
            onChange={(e) => renameSpace(e.target.value)}
            onBlur={persistence?.saveName}
            className="min-w-0 flex-1 border-transparent bg-transparent font-semibold shadow-none hover:border-input sm:w-64 sm:flex-none dark:bg-transparent"
          />
          <Badge variant="outline" className="ml-auto hidden gap-1.5 lg:inline-flex">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            {t('onboarding.step')}
          </Badge>
          <LibraryButton iconOnly />
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 grid-cols-1 gap-6 overflow-y-auto px-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-10 lg:overflow-visible lg:px-6">
        <Chat />
        <aside className="flex min-w-0 flex-col pb-8 [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent] lg:-mx-8 lg:overflow-y-auto lg:px-8 lg:py-8">
          <div className="relative isolate shrink-0">
            <div aria-hidden className="pointer-events-none absolute -inset-x-8 -inset-y-16 -z-10 bg-radial from-foreground/8 via-foreground/3 to-transparent to-70%" />
            <RequirementCard />
          </div>
        </aside>
      </div>
    </div>
  )
}

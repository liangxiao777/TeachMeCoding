'use client'

import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  FileText,
  History,
  Info,
  Lightbulb,
  Plus,
  RotateCcw,
  Route,
  Sparkles,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react'
import { motion, useIsPresent, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/i18n/format'
import { formatNotice, notice, type NoticeValue } from '@/i18n/notice'
import { localizedActionReceipt, quoteLabel, receiptProposal, sessionTitle } from '@/i18n/presentation'
import { BrandMark, isComposing } from '@/components/shared'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message as ChatMessage, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Suggestion } from '@/components/ai-elements/suggestion'
import { RunContent } from './run-content'
import { RunContext } from './run-context'
import { YoloSwitch } from './yolo-switch'
import { PromptQueue } from './prompt-queue'
import { RouteProposalDecision } from './route-proposal-decision'
import { LessonProposalDecision } from './lesson-proposal-decision'
import { LocalAction } from './local-action'
import { pendingDecision } from '@/app/lesson-proposals'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { conversationMessages, findUnit, scopedSessions, sessionScope, sessionUnitId } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { uiMotion } from '@/lib/motion'
import type { Message, Quote, QuoteSource } from '@/app/types'

const SOURCE_ICON: Record<QuoteSource, typeof FileText> = {
  lesson: FileText,
  code: Code2,
  terminal: SquareTerminal,
  advice: Lightbulb,
}

function QuoteCard({ quote, onRemove, compact }: { quote: Quote; onRemove?: () => void; compact?: boolean }) {
  const { t } = useTranslation('workbench')
  const Icon = SOURCE_ICON[quote.source]
  const mono = quote.source === 'code' || quote.source === 'terminal'
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-muted/60 px-3 py-2',
        compact && 'border-primary-foreground/20 bg-primary-foreground/10',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('flex items-center gap-1.5 text-xs font-medium', compact ? 'opacity-80' : 'text-muted-foreground')}>
          <Icon className="size-3.5" aria-hidden />
          {quoteLabel(quote)}
        </span>
        {onRemove && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} aria-label={t('agent.removeQuote')}>
            <X />
          </Button>
        )}
      </div>
      <p className={cn('line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed', mono && 'font-mono')}>{quote.text}</p>
    </div>
  )
}

export function AgentMessage({ msg }: { msg: Message }) {
  const { t } = useTranslation('workbench')
  const { retryReply, applyRouteAction, bringToIde, capabilities, persistence } = useApp()
  const space = useSpace()
  const lang = space.kind === 'pytorch' ? 'python' : 'rust'
  const awaitingDecision = persistence && pendingDecision(persistence)

  const receipt = receiptProposal(msg, persistence?.actions ?? [])
  const text = receipt ? localizedActionReceipt(receipt) : msg.notice
    ? formatNotice(notice('common', 'notices.autoApproval', { error: msg.notice })) : msg.text

  return (
    <ChatMessage from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3 leading-relaxed">
      <RunContent parts={msg.parts} text={text} streaming={capabilities.agent && (msg.status === 'thinking' || msg.status === 'streaming')}
        onCode={(code, language) => bringToIde(code, `agent_example.${({ python: 'py', rust: 'rs', javascript: 'js', typescript: 'ts', json: 'json', bash: 'sh' } as Record<string, string>)[language || lang] ?? 'txt'}`)} />
      {msg.status === 'stopped' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Square className="size-3" aria-hidden />
          {t('agent.stopped')}
          <Button variant="link" size="xs" className="h-auto p-0" disabled={!capabilities.agent || awaitingDecision} onClick={() => retryReply(msg.runId ?? msg.id)}>
            {msg.runId ? t('queue.regenerateFirst') : t('controls.regenerate')}
          </Button>
        </div>
      )}
      {msg.status === 'error' && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{msg.error ? formatNotice(msg.error) : t('agent.replyFailed')}</AlertTitle>
          <div className="col-start-2 mt-2">
            <Button size="xs" variant="outline" disabled={!capabilities.agent || awaitingDecision} onClick={() => retryReply(msg.runId ?? msg.id)}>
              <RotateCcw data-icon="inline-start" />
              {msg.runId ? t('queue.retryFirst') : t('controls.retry')}
            </Button>
          </div>
        </Alert>
      )}
      {persistence?.conclusions.filter((c) => c.runId === msg.id).map((c) => (
        <Card key={c.id} size="sm" className="ring-primary/30">
          <CardHeader><CardTitle className="text-sm">{t('agent.conclusion', { status: c.valid ? c.adopted ? t('agent.adopted') : t('agent.pendingAdoption') : t('agent.sourceChanged') })}</CardTitle>
            <CardDescription>{c.text}</CardDescription></CardHeader>
          <CardFooter><Button size="xs" variant="outline" disabled={persistence.busy || !c.valid && !c.adopted} onClick={() => persistence.decideConclusion(c.id, !c.adopted)}>
            {c.adopted ? t('agent.undoAdoption') : t('agent.adopt')}
          </Button></CardFooter>
        </Card>
      ))}
      {persistence?.proposals.filter((proposal) => proposal.runId === msg.id).map((proposal) => (
        <Card key={proposal.id} size="sm" data-testid="route-decision-history">
          <CardHeader>
            <CardTitle className="text-sm">{t('agent.routeProposal', { status: t(`agent.proposalStatus.${proposal.state}`) })}</CardTitle>
            <CardDescription className="whitespace-pre-wrap break-words">{proposal.content.note}</CardDescription>
          </CardHeader>
          {proposal.feedback && <CardContent className="text-xs leading-relaxed"><p className="font-medium">{t('agent.feedback')}</p><p className="mt-1 whitespace-pre-wrap break-words">{proposal.feedback}</p></CardContent>}
        </Card>
      ))}
      {persistence?.lessonProposals.filter((proposal) => proposal.source.kind === 'run' && proposal.source.id === msg.id).map((proposal) => (
        <Card key={proposal.id} size="sm" data-testid="lesson-decision-history">
          <CardHeader><CardTitle className="text-sm">{t('agent.lessonProposal', { status: t(`agent.proposalStatus.${proposal.state}`) })}</CardTitle>
            <CardDescription className="whitespace-pre-wrap break-words">{proposal.content.title} · {proposal.note}</CardDescription></CardHeader>
          {proposal.feedback && <CardContent className="text-xs leading-relaxed"><p className="font-medium">{t('agent.feedback')}</p><p className="mt-1 whitespace-pre-wrap break-words">{proposal.feedback}</p></CardContent>}
        </Card>
      ))}
      {persistence?.actions.filter((p) => p.runId === msg.id).map((p) => (
        <LocalAction key={p.id} proposal={p} />
      ))}
      {!persistence && msg.action && msg.status === 'done' && (
        <Card size="sm" className="ring-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Route className="size-4 text-primary" aria-hidden />
              {msg.action.kind === 'skip-basics' ? t('agent.skipBasicsTitle') : t('agent.projectFirstTitle')}
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">{msg.action.kind === 'skip-basics' ? t('agent.skipBasicsText') : t('agent.projectFirstText')}</CardDescription>
          </CardHeader>
          <CardFooter>
            {msg.action.applied ? (
              <Badge variant="secondary" className="text-primary">
                <Check data-icon="inline-start" />
                {t('agent.routeUpdated')}
              </Badge>
            ) : (
              <Button size="sm" onClick={() => applyRouteAction(msg.id)}>
                {t('agent.confirmRoute')}
              </Button>
            )}
          </CardFooter>
        </Card>
      )}
      </MessageContent>
    </ChatMessage>
  )
}

export function SessionMenu() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { session: active, switchSession, newSession, persistence } = useApp()
  const sessions = scopedSessions(space)
  const busy = !!persistence && !persistence.ready
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t('agent.switchSession')} render={<Button variant="ghost" size="sm" className="max-w-full min-w-0" />}>
        <History data-icon="inline-start" className="text-muted-foreground" />
        <span className="truncate">{active ? sessionTitle(active, active.id === sessions[0]?.id) : t('agent.newSessionFallback')}</span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('w-80', space.ideFullscreen && 'dark')}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('agent.history')}</DropdownMenuLabel>
          {sessions.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('agent.noSessions')}</p>}
          {sessions.map((s) => (
            <DropdownMenuItem key={s.id} disabled={busy} onClick={() => switchSession(s.id)} className="items-start gap-2 py-2">
              <Check className={cn('mt-0.5 size-4', s.id === active?.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{sessionTitle(s, s.id === sessions[0]?.id)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {s.updatedAt ? formatRelativeTime(s.updatedAt) : t('agent.noMessages')}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={newSession}>
          <Plus />
          {t('agent.newSession')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Composer() {
  const { t } = useTranslation('workbench')
  const { session, setComposerText, setQuote, sendMessage, stopReply, capabilities, persistence } = useApp()
  const space = useSpace()
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<NoticeValue>(null)
  const text = session?.composerText ?? ''
  const quote = session?.composerQuote
  const replying = capabilities.agent && (!!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming')
    || sessionScope(space) === 'route' && !!persistence?.routeAdjustmentRun)
  const busy = !persistence && replying || sending || !!persistence && (persistence.busy || !persistence.ready
    || sessionScope(space) === 'route' && !!persistence.routeAdjustmentRun && persistence.routeAdjustmentRun.sessionId !== session?.id)
  const canSend = !busy && (text.trim() || quote)

  useEffect(() => {
    if (quote || text) ref.current?.focus({ preventScroll: true })
  }, [quote, text])

  useEffect(() => setSendError(null), [session?.id, session?.messages.length])

  const send = async () => {
    if (!canSend || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setSendError(null)
    try {
      // The provider owns clearing only the submitted draft after a successful save.
      await sendMessage()
    } catch (error) {
      setSendError(error instanceof Error ? error : notice('workbench', 'agent.saveFailed'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <div className="p-3">
      <PromptInput onReset={(event) => event.preventDefault()} onSubmit={() => send()} className="[&>[data-slot=input-group]]:bg-background">
          {quote && (
            <PromptInputHeader className="pb-0">
              <div className="w-full">
                <QuoteCard quote={quote} onRemove={() => setQuote(null)} />
              </div>
            </PromptInputHeader>
          )}
          <label htmlFor="agent-input" className="sr-only">
            {t('controls.askAgent')}
          </label>
          <PromptInputTextarea
            id="agent-input"
            ref={ref}
            rows={3}
            value={text}
            disabled={!!persistence && !session}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={quote ? t('agent.quotePlaceholder') : t('agent.placeholder')}
            className="min-h-16 leading-relaxed"
          />
          <PromptInputFooter>
            <YoloSwitch />
            {sessionScope(space) === 'route' && persistence?.routeAdjustmentRun && <span className="text-xs text-muted-foreground">{t('agent.adjusting')}</span>}
            <RunContext runId={session?.messages.findLast((m) => m.role === 'agent')?.runId ?? session?.messages.findLast((m) => m.role === 'agent')?.id} />
            {persistence && replying && <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" onClick={stopReply} aria-label={t('controls.stop')}><Square /></Button>}
            <PromptInputSubmit className={persistence && replying ? undefined : 'ml-auto'} status={!persistence && replying ? 'streaming' : 'ready'} onStop={stopReply}
              disabled={!(!persistence && replying) && !canSend} aria-label={persistence && replying ? t('queue.enqueue') : replying ? t('controls.stop') : capabilities.agent ? t('controls.send') : t('controls.saveQuestion')} />
          </PromptInputFooter>
      </PromptInput>
      {!!sendError && <p role="alert" className="mt-2 text-xs text-destructive">{formatNotice(sendError)}</p>}
    </div>
  )
}

function EmptyChat() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { setComposerText, capabilities, persistence } = useApp()
  const awaitingDecision = persistence && pendingDecision(persistence)
  const unit = findUnit(space, sessionUnitId(space))
  const prompts =
    space.view === 'route'
      ? [t('agent.prompts.basics'), t('agent.prompts.project'), t('agent.prompts.duration')]
      : unit
        ? [t('agent.prompts.example', { title: unit.title }), t('agent.prompts.pitfalls'), t('agent.prompts.exercise')]
        : [t('agent.prompts.start')]
  return (
    <Empty className="flex-1 justify-end gap-4 p-4">
      <EmptyHeader className="items-start text-left">
        <EmptyMedia>
          <BrandMark className="size-9" />
        </EmptyMedia>
        <EmptyTitle>{awaitingDecision ? t('agent.awaitingDecision') : t('agent.emptyTitle')}</EmptyTitle>
        <EmptyDescription className="text-left">
          {awaitingDecision ? t('agent.decisionHint') : !capabilities.agent
            ? t('agent.unavailableHint')
            : space.view === 'route'
            ? t('agent.routeHint')
            : t('agent.lessonHint')}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none items-stretch gap-1.5">
        {!awaitingDecision && prompts.map((p) => (
          <Suggestion key={p} suggestion={p} className="h-auto justify-start whitespace-normal rounded-lg py-2 text-left font-normal" onClick={setComposerText}>
            <Sparkles data-icon="inline-start" className="text-primary" />
            {p}
          </Suggestion>
        ))}
      </EmptyContent>
    </Empty>
  )
}

export function AgentPanel() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { session, newSession, toggleAgent, capabilities, persistence } = useApp()
  const proposal = persistence?.proposals.findLast((proposal) => proposal.state === 'pending')
  const lessonProposal = persistence?.lessonProposals.findLast((proposal) => proposal.state === 'pending')
  const isPresent = useIsPresent()
  const reducedMotion = useReducedMotion()

  return (
    <motion.aside
      aria-label="Agent"
      aria-hidden={!isPresent}
      inert={!isPresent}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion || space.view !== 'route' ? 0 : uiMotion.panel }}
      className="flex h-full min-w-0 flex-1 flex-col border-l bg-sidebar"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div className="min-w-0 flex-1">
          <SessionMenu />
        </div>
        <Button variant="ghost" size="icon-sm" disabled={persistence?.busy} onClick={newSession} aria-label={t('agent.newSession')}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!!proposal || !!lessonProposal} onClick={() => {
          document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')?.focus({ preventScroll: true })
          toggleAgent(false)
        }} aria-label={t('agent.collapse')}>
          <X />
        </Button>
      </div>

      {!capabilities.agent && (
        <div className="border-b p-3">
          <Alert>
            <Info />
            <AlertDescription className="text-xs">{t('agent.unavailable')}</AlertDescription>
          </Alert>
        </div>
      )}

      {space.view === 'assessment' && (
        <div className="border-b p-3">
          <Alert className="border-accent-foreground/20 bg-accent/60">
            <Info className="text-accent-foreground" />
            <AlertDescription className="text-xs text-accent-foreground">
              {capabilities.agent ? t('agent.assessmentHint') : t('agent.unavailableAssessmentHint')}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {!session || session.messages.length === 0 ? (
        <EmptyChat />
      ) : (
        <Conversation key={session.id} className="min-h-0" initial="instant" resize="instant" aria-label={t('agent.conversation')}>
          <ConversationContent>
            <ol className="flex flex-col gap-5">
            {conversationMessages(session.messages).map((m) => (
              <li key={m.id} className="min-w-0">
                {m.role === 'user' ? (
                  <ChatMessage from="user">
                    <MessageContent>
                    {m.quote && <QuoteCard quote={m.quote} />}
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    </MessageContent>
                  </ChatMessage>
                ) : (
                  <div className="text-sm leading-relaxed">
                    <AgentMessage msg={m} />
                  </div>
                )}
              </li>
            ))}
            </ol>
          </ConversationContent>
          <ConversationScrollButton aria-label={t('agent.latest')} />
        </Conversation>
      )}
      <PromptQueue />
      {proposal ? <RouteProposalDecision key={proposal.id} proposal={proposal} /> : lessonProposal ? <LessonProposalDecision key={lessonProposal.id} proposal={lessonProposal} /> : <Composer />}
    </motion.aside>
  )
}

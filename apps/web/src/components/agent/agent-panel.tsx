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
import { BrandMark, isComposing } from '@/components/shared'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message as ChatMessage, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Suggestion } from '@/components/ai-elements/suggestion'
import { RunContent } from './run-content'
import { RunContext } from './run-context'
import { RouteProposalDecision } from './route-proposal-decision'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { findUnit, relativeTime, scopedSessions, sessionScope, sessionUnitId } from '@/app/selectors'
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
          {quote.label}
        </span>
        {onRemove && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} aria-label="移除引用">
            <X />
          </Button>
        )}
      </div>
      <p className={cn('line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed', mono && 'font-mono')}>{quote.text}</p>
    </div>
  )
}

const ACTION_COPY = {
  'skip-basics': { title: '将「基础语法」标记为已跳过', text: '当前单元会切换到「所有权」，其他单元保持不变。' },
  'project-first': { title: '在「所有权」之后插入一个练习项目', text: '新增单元「练习项目：单词计数器」，后续单元顺延。' },
}

export function AgentMessage({ msg }: { msg: Message }) {
  const { retryReply, applyRouteAction, bringToIde, capabilities, persistence } = useApp()
  const space = useSpace()
  const lang = space.kind === 'pytorch' ? 'python' : 'rust'
  const awaitingDecision = persistence?.proposals.some((proposal) => proposal.state === 'pending')

  return (
    <ChatMessage from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-3 leading-relaxed">
      <RunContent parts={msg.parts} text={msg.text} streaming={capabilities.agent && (msg.status === 'thinking' || msg.status === 'streaming')}
        onCode={(code, language) => bringToIde(code, `agent_example.${({ python: 'py', rust: 'rs', javascript: 'js', typescript: 'ts', json: 'json', bash: 'sh' } as Record<string, string>)[language || lang] ?? 'txt'}`)} />
      {msg.status === 'stopped' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Square className="size-3" aria-hidden />
          已停止生成
          <Button variant="link" size="xs" className="h-auto p-0" disabled={!capabilities.agent || awaitingDecision} onClick={() => retryReply(msg.id)}>
            重新生成
          </Button>
        </div>
      )}
      {msg.status === 'error' && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>回复失败，你的问题已保留</AlertTitle>
          <AlertAction>
            <Button size="xs" variant="outline" disabled={!capabilities.agent || awaitingDecision} onClick={() => retryReply(msg.id)}>
              <RotateCcw data-icon="inline-start" />
              重试
            </Button>
          </AlertAction>
        </Alert>
      )}
      {persistence?.conclusions.filter((c) => c.runId === msg.id).map((c) => (
        <Card key={c.id} size="sm" className="ring-primary/30">
          <CardHeader><CardTitle className="text-sm">学习结论 · {c.valid ? c.adopted ? '已采纳' : '待采纳' : '来源已变化'}</CardTitle>
            <CardDescription>{c.text}</CardDescription></CardHeader>
          <CardFooter><Button size="xs" variant="outline" disabled={persistence.busy || !c.valid && !c.adopted} onClick={() => persistence.decideConclusion(c.id, !c.adopted)}>
            {c.adopted ? '撤销采纳' : '采纳结论'}
          </Button></CardFooter>
        </Card>
      ))}
      {persistence?.proposals.filter((proposal) => proposal.runId === msg.id).map((proposal) => (
        <Card key={proposal.id} size="sm" data-testid="route-decision-history">
          <CardHeader>
            <CardTitle className="text-sm">路线提案 · {{ pending: '待确认', applied: '已接受', rejected: '已拒绝', superseded: '已失效' }[proposal.state]}</CardTitle>
            <CardDescription className="whitespace-pre-wrap break-words">{proposal.content.note}</CardDescription>
          </CardHeader>
          {proposal.feedback && <CardContent className="text-xs leading-relaxed"><p className="font-medium">修改意见</p><p className="mt-1 whitespace-pre-wrap break-words">{proposal.feedback}</p></CardContent>}
        </Card>
      ))}
      {persistence?.actions.filter((p) => p.runId === msg.id).map((p) => (
        <Card key={p.id} size="sm" data-testid="local-action">
          <CardHeader><CardTitle className="text-sm">{p.action.kind === 'file' ? '文件修改提案' : '本机命令提案'} · {{ pending: '待确认', running: '执行中', succeeded: '成功', failed: '失败', rejected: '已拒绝', expired: '已过期', cancelled: '已取消', interrupted: '已中断' }[p.state]}</CardTitle>
            <CardDescription>{p.action.reason}</CardDescription></CardHeader>
          <CardContent className="min-w-0 space-y-2 text-xs">
            <p className="break-all">工作目录：{p.action.cwd}</p>
            {p.action.kind === 'file' ? <>
              <p className="break-all">文件：{p.action.path}</p>
              <details><summary className="cursor-pointer">查看完整修改前后内容</summary>
                <p className="mt-2">修改前{p.action.before === null ? '（新文件）' : ''}</p><pre className="max-h-64 overflow-auto whitespace-pre rounded bg-muted p-2">{p.action.before ?? ''}</pre>
                <p className="mt-2">修改后</p><pre className="max-h-64 overflow-auto whitespace-pre rounded bg-muted p-2">{p.action.content}</pre>
              </details>
            </> : <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{p.action.command}</pre>}
            <p className="text-muted-foreground">在本机执行，不是沙箱；拥有服务账号权限。取消不能撤销已发生的修改。命令最多 30 秒、256 KiB 输出；不自动安装环境。</p>
            {p.state === 'interrupted' && <p>服务已重启，执行结果可能不完整；没有自动重放，请检查磁盘。</p>}
            {p.result && <><p>结果：{p.result.status} · 退出码 {p.result.exitCode ?? '无'}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{p.result.output}</pre></>}
            {p.state === 'pending' && persistence.unsavedFiles.length > 0 && <p role="status">请先保存所有编辑器文件，再确认执行。</p>}
          </CardContent>
          {(p.state === 'pending' || p.state === 'running') && <CardFooter className="gap-2">
            {p.state === 'pending' ? <>
              <Button size="xs" disabled={persistence.busy || persistence.unsavedFiles.length > 0} onClick={() => persistence.decideAction(p.id, 'confirm')}>确认执行</Button>
              <Button size="xs" variant="outline" disabled={persistence.busy} onClick={() => persistence.decideAction(p.id, 'reject')}>拒绝</Button>
            </> : <Button size="xs" variant="outline" onClick={() => persistence.decideAction(p.id, 'cancel')}>取消执行</Button>}
          </CardFooter>}
        </Card>
      ))}
      {!persistence && msg.action && msg.status === 'done' && (
        <Card size="sm" className="ring-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Route className="size-4 text-primary" aria-hidden />
              {ACTION_COPY[msg.action.kind].title}
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">{ACTION_COPY[msg.action.kind].text}</CardDescription>
          </CardHeader>
          <CardFooter>
            {msg.action.applied ? (
              <Badge variant="secondary" className="text-primary">
                <Check data-icon="inline-start" />
                路线已更新
              </Badge>
            ) : (
              <Button size="sm" onClick={() => applyRouteAction(msg.id)}>
                确认调整路线
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
  const space = useSpace()
  const { session: active, switchSession, newSession, persistence } = useApp()
  const sessions = scopedSessions(space)
  const busy = !!persistence && !persistence.ready
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="切换会话" render={<Button variant="ghost" size="sm" className="max-w-full min-w-0" />}>
        <History data-icon="inline-start" className="text-muted-foreground" />
        <span className="truncate">{active?.title ?? '新会话'}</span>
        <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('w-80', space.ideFullscreen && 'dark')}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>历史会话</DropdownMenuLabel>
          {sessions.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">还没有会话</p>}
          {sessions.map((s) => (
            <DropdownMenuItem key={s.id} disabled={busy} onClick={() => switchSession(s.id)} className="items-start gap-2 py-2">
              <Check className={cn('mt-0.5 size-4', s.id === active?.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{s.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {s.updatedAt ? relativeTime(s.updatedAt) : '暂无消息'}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={newSession}>
          <Plus />
          新建会话
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Composer() {
  const { session, setComposerText, setQuote, sendMessage, stopReply, capabilities, persistence } = useApp()
  const space = useSpace()
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendingRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const text = session?.composerText ?? ''
  const quote = session?.composerQuote
  const replying = capabilities.agent && (!!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming')
    || sessionScope(space) === 'route' && !!persistence?.routeAdjustmentRun)
  const busy = replying || sending || !!persistence && (persistence.busy || !persistence.ready)
  const canSend = !busy && (text.trim() || quote)

  useEffect(() => {
    if (quote || text) ref.current?.focus({ preventScroll: true })
  }, [quote, text])

  useEffect(() => setSendError(''), [session?.id, session?.messages.length])

  const send = async () => {
    if (!canSend || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setSendError('')
    try {
      // The provider owns clearing only the submitted draft after a successful save.
      await sendMessage()
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '问题未保存，请重试。')
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
            向 Agent 提问
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
            placeholder={quote ? '针对引用的内容，你想问什么？' : '说说你的想法…'}
            className="min-h-16 leading-relaxed"
          />
          <PromptInputFooter>
            {sessionScope(space) === 'route' && persistence?.routeAdjustmentRun && <span className="text-xs text-muted-foreground">正在生成路线调整…</span>}
            <RunContext runId={session?.messages.findLast((m) => m.role === 'agent')?.id} />
            <PromptInputSubmit className="ml-auto" status={replying ? 'streaming' : 'ready'} onStop={stopReply}
              disabled={!replying && !canSend} aria-label={replying ? '停止' : capabilities.agent ? '发送' : '保存问题'} />
          </PromptInputFooter>
      </PromptInput>
      {sendError && <p role="alert" className="mt-2 text-xs text-destructive">{sendError}</p>}
    </div>
  )
}

function EmptyChat() {
  const space = useSpace()
  const { setComposerText, capabilities, persistence } = useApp()
  const awaitingDecision = persistence?.proposals.some((proposal) => proposal.state === 'pending')
  const unit = findUnit(space, sessionUnitId(space))
  const prompts =
    space.view === 'route'
      ? ['基础语法我已经会了', '我想先做项目', '这条路线大概要多久？']
      : unit
        ? [`用一个例子解释「${unit.title}」`, '这一单元最容易踩的坑是什么？', '给我出一道练习题']
        : ['我该从哪里开始？']
  return (
    <Empty className="flex-1 justify-end gap-4 p-4">
      <EmptyHeader className="items-start text-left">
        <EmptyMedia>
          <BrandMark className="size-9" />
        </EmptyMedia>
        <EmptyTitle>{awaitingDecision ? '等待路线选择' : '有什么想问的？'}</EmptyTitle>
        <EmptyDescription className="text-left">
          {awaitingDecision ? '这份路线提案属于整个学习空间，切换或新建会话不会取消它。请先在下方接受或拒绝。' : !capabilities.agent
            ? 'Agent 暂不可用。你仍可提交问题，但不会生成回复或调整路线。'
            : space.view === 'route'
            ? '告诉我你想怎样调整学习安排，我会结合你的目标和基础给出建议，确认后再更新路线。'
            : '围绕这节课继续讨论。在课件、代码或终端里选中内容，也可以直接引用过来提问。'}
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
  const space = useSpace()
  const { session, newSession, toggleAgent, capabilities, persistence } = useApp()
  const proposal = persistence?.proposals.findLast((proposal) => proposal.state === 'pending')
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
        <Button variant="ghost" size="icon-sm" disabled={persistence?.busy} onClick={newSession} aria-label="新建会话">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!!proposal} onClick={() => {
          document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')?.focus({ preventScroll: true })
          toggleAgent(false)
        }} aria-label="收起 Agent">
          <X />
        </Button>
      </div>

      {!capabilities.agent && (
        <div className="border-b p-3">
          <Alert>
            <Info />
            <AlertDescription className="text-xs">Agent 暂不可用 · 仅保存问题，不会生成回复。</AlertDescription>
          </Alert>
        </div>
      )}

      {space.view === 'assessment' && (
        <div className="border-b p-3">
          <Alert className="border-accent-foreground/20 bg-accent/60">
            <Info className="text-accent-foreground" />
            <AlertDescription className="text-xs text-accent-foreground">
              {capabilities.agent ? '测评进行中：可以问题意不清的地方，Agent 会引导你思考，但不会直接给出答案。' : '测评进行中：可以记录问题，Agent 暂不可用，不会生成引导或答案。'}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {!session || session.messages.length === 0 ? (
        <EmptyChat />
      ) : (
        <Conversation key={session.id} className="min-h-0" initial="instant" resize="instant" aria-label="Agent 会话">
          <ConversationContent>
            <ol className="flex flex-col gap-5">
            {session.messages.map((m) => (
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
          <ConversationScrollButton aria-label="滚动到最新消息" />
        </Conversation>
      )}
      {proposal ? <RouteProposalDecision key={proposal.id} proposal={proposal} /> : <Composer />}
    </motion.aside>
  )
}

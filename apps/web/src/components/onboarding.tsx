'use client'

import { ArrowLeft, Check, ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentMessage, SessionMenu } from '@/components/agent/agent-panel'
import { RunContent } from '@/components/agent/run-content'
import { RunContext } from '@/components/agent/run-context'
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
  const space = useSpace()
  const { updateRequirement, confirmRequirement, setView, capabilities, persistence } = useApp()
  const [previewEditing, setEditing] = useState(false)
  const [previewDraft, setPreviewDraft] = useState<RequirementDraft | null>(null)
  const draft = persistence ? persistence.requirementDraft : previewDraft
  const setDraft = persistence ? persistence.setRequirementDraft : setPreviewDraft
  const editing = persistence ? draft !== null : previewEditing
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const req = space.requirement
  const busy = saving || !!persistence && (persistence.busy || !persistence.ready)
  const validRows = !draft || draft.rows.every((row) => row.question.trim())

  const save = async () => {
    if (!draft || busy || savingRef.current || !validRows) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    try {
      const saved = await updateRequirement(draft)
      if (saved === false) {
        setSaveError('需求未保存，请重试。')
        return
      }
      setEditing(false)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '需求未保存，请重试。')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if ((!space.onboarding.summaryReady && !persistence) || !req) {
    return (
      <Card className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
        <CardHeader>
          <CardTitle>学习需求摘要</CardTitle>
          <CardDescription className="leading-relaxed">
            {capabilities.agent ? 'Agent 了解你的目标、基础和期望后，会在这里整理出一份需求摘要。你确认之后才会生成学习路线。' : 'Agent 暂不可用。学习需求需手动填写并确认，不会自动生成学习路线。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4" aria-label="正在整理需求表格">
            <div className="grid grid-cols-[2fr_3fr] gap-4 text-xs font-medium text-muted-foreground"><span>问题</span><span>回答</span></div>
            {[0, 1, 2].map((index) => <div key={index} className="grid grid-cols-[2fr_3fr] gap-4"><Skeleton className="h-3 animate-none" /><Skeleton className="h-3 animate-none" /></div>)}
          </div>
        </CardContent>
      </Card>
    )
  }

  const current: RequirementDraft = editing && draft ? draft : { ...req, intake: persistence?.intake }
  const awaitingSummary = !req.rows.some((row) => row.answer.trim())
  const editRow = (index: number, field: 'question' | 'answer', value: string) => setDraft({ ...current,
    rows: current.rows.map((row, at) => at === index ? { ...row, [field]: value } : row) })
  return (
    <Card aria-labelledby="req-title" className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
      <CardHeader>
        <CardTitle id="req-title" className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" aria-hidden />
          学习需求摘要
        </CardTitle>
        <CardDescription>{capabilities.agent ? awaitingSummary ? 'Agent 会根据对话整理需求，你也可以直接填写。确认后才会规划路线。' : '确认后 Agent 会据此规划路线' : '手动保存并确认学习需求；Agent 暂不可用，不会自动规划路线'}</CardDescription>
        <CardAction>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setDraft(null); setSaveError('') }}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={busy || !validRows}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDraft({ ...req, rows: req.rows.length ? structuredClone(req.rows) : [{ question: '', answer: '' }], intake: persistence?.intake })
              setSaveError('')
              setEditing(true)
            }}
          >
            <Pencil data-icon="inline-start" />
            修改
          </Button>
        )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {saveError && <p role="alert" className="mb-3 text-sm text-destructive">{saveError}</p>}
        {current.rows.length > 0 ? <table aria-label="学习需求" className="w-full table-fixed text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="w-2/5 px-2 pb-3 font-medium">问题</th>
            <th scope="col" className="px-2 pb-3 font-medium">回答</th>
          </tr></thead>
          <tbody>{current.rows.map((row, index) => <tr key={index} className="border-b last:border-0">
            <td className="px-2 py-3 align-top whitespace-pre-wrap break-words font-medium leading-relaxed">
              {editing ? <Textarea aria-label={`问题 ${index + 1}`} rows={2} maxLength={10_000}
                value={row.question} onChange={(event) => editRow(index, 'question', event.target.value)} className="resize-y leading-relaxed" /> : row.question}
            </td>
            <td className="px-2 py-3 align-top whitespace-pre-wrap break-words leading-relaxed">
              {editing ? <div className="space-y-2"><Textarea aria-label={`回答 ${index + 1}`} rows={3} maxLength={100_000}
                value={row.answer} onChange={(event) => editRow(index, 'answer', event.target.value)} className="resize-y leading-relaxed" />
                <Button variant="ghost" size="xs" disabled={saving} aria-label={`移除第 ${index + 1} 行`}
                  onClick={() => setDraft({ ...current, rows: current.rows.filter((_, at) => at !== index) })}><Trash2 aria-hidden />移除</Button>
              </div> : row.answer || <span className="text-muted-foreground">待补充</span>}
            </td>
          </tr>)}</tbody>
        </table> : <p className="py-3 text-sm leading-relaxed text-muted-foreground">还没有整理好的需求。可以继续对话，也可以直接添加问题和回答。</p>}
        {editing && <div className="mt-4 space-y-3">
          <Button variant="outline" size="sm" disabled={saving || current.rows.length >= 100}
            onClick={() => setDraft({ ...current, rows: [...current.rows, { question: '', answer: '' }] })}><Plus aria-hidden />添加问题</Button>
          {!validRows && <p role="status" className="text-xs text-muted-foreground">请填写每行的问题；暂不确定的回答可以留空。</p>}
        </div>}
        {!editing && current.intake?.researchRef && <ResearchCard key={`${space.id}:${current.intake.researchRef.id}`} researchRef={current.intake.researchRef} />}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 border-t">
        {persistence && !persistence.readiness?.ready && <div id="req-readiness" role="status" className="space-y-2 text-sm">
          <p className="font-medium">暂不能确认并规划</p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {(persistence.readiness?.reasons.length ? persistence.readiness.reasons : ['正在读取需求准入状态，请稍后重试。']).map((reason, index) => <li key={index} className="whitespace-pre-wrap break-words">{reason}</li>)}
          </ul>
        </div>}
        <Button size="lg" aria-describedby={persistence && !persistence.readiness?.ready ? 'req-readiness' : undefined}
          disabled={editing || busy || awaitingSummary || persistence?.requirementConfirmed || !!persistence && !persistence.readiness?.ready} onClick={confirmRequirement}>
          <Check data-icon="inline-start" />
          {persistence?.requirementConfirmed ? '已确认学习需求' : capabilities.agent ? '确认，开始规划路线' : '确认学习需求'}
        </Button>
        {persistence?.requirementConfirmed && (
          <Button variant="outline" size="lg" disabled={editing || busy} onClick={() => setView(!space.stages.length && persistence.planning.run ? 'planning' : 'route')}>
            {!space.stages.length && persistence.planning.run ? '查看规划进度' : '查看学习路线'}
          </Button>
        )}
        <p className="text-center text-xs text-muted-foreground">{capabilities.agent ? '不准确？直接修改，或在左侧继续告诉 Agent' : '不准确？直接修改。左侧仅保存问题，不会自动整理需求或生成路线。'}</p>
      </CardFooter>
    </Card>
  )
}

function Chat() {
  const space = useSpace()
  const { onboardSend, sendMessage, stopReply, session, setComposerText, capabilities, persistence } = useApp()
  const [previewText, setPreviewText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const sendingRef = useRef(false)
  const text = persistence ? session?.composerText ?? '' : previewText
  const setText = persistence ? setComposerText : setPreviewText
  const { messages } = space.onboarding
  const replying = capabilities.agent && space.onboarding.agentTyping
  const busy = replying || sending || !!persistence && (persistence.busy || !persistence.ready)

  useEffect(() => setSendError(''), [session?.id, messages.length])

  const send = async (value: string, fromComposer = false) => {
    if (!value.trim() || busy || sendingRef.current) return
    if (!persistence) {
      onboardSend(value)
      setPreviewText('')
      return
    }
    sendingRef.current = true
    setSending(true)
    setSendError('')
    try {
      // Keep the provider draft intact through failed, retried, or delayed requests.
      await sendMessage(fromComposer ? undefined : value)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '问题未保存，请重试。')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  return (
    <div className="flex h-[70dvh] min-h-[28rem] min-w-0 flex-1 flex-col lg:h-auto lg:min-h-0">
      {persistence && <div className="flex h-12 shrink-0 items-center border-b px-4 sm:px-6"><SessionMenu /></div>}
      <Conversation key={session?.id ?? space.id} className="min-h-0" initial="instant" resize="instant" aria-label="学习需求会话">
        <ConversationContent className="gap-6 px-4 py-8 sm:px-6"
          scrollClassName="[scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]">
          {(!persistence || messages.length === 0) && <Message from="assistant">
            <MessageContent>
              {capabilities.agent ? '你好，我是你的学习 Agent。先告诉我你想学什么、想学成什么样，我来帮你规划一条适合你的路线。' : 'Agent 暂不可用。这里仅保存你的问题，不会生成回复；请在右侧手动修改并确认学习需求。'}
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
              <Shimmer>等待模型响应…</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton className="left-auto right-0 translate-x-0 sm:right-2" aria-label="滚动到最新消息" />
      </Conversation>

      <div className="flex shrink-0 flex-col gap-3 px-4 pt-4 pb-6 sm:px-6">
        <PromptInput onReset={(event) => event.preventDefault()} onSubmit={() => send(text, true)}>
            <label htmlFor="ob-input" className="sr-only">
              回复 Agent
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
              placeholder="告诉 Agent 你的学习目标，或继续回复…"
              className="leading-relaxed"
            />
            <PromptInputFooter>
              <RunContext runId={session?.messages.findLast((m) => m.role === 'agent')?.id} />
              <span className="hidden text-xs text-muted-foreground sm:inline">
                <Kbd>Enter</Kbd>{capabilities.agent ? ' 发送 · ' : ' 保存问题 · '}<Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行
              </span>
              <PromptInputSubmit className="ml-auto" status={persistence && replying ? 'streaming' : 'ready'} onStop={stopReply}
                disabled={!(persistence && replying) && (!text.trim() || busy)} aria-label={persistence && replying ? '停止' : capabilities.agent ? '发送' : '保存问题'} />
            </PromptInputFooter>
        </PromptInput>
        {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      </div>
    </div>
  )
}

export function Onboarding() {
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
                <h1 className="text-base font-semibold">{planning?.run?.state === 'interrupted' ? '路线规划已停止' : '路线规划未完成'}</h1>
                <p role="alert" className="text-sm text-muted-foreground">{planning?.error || persistence?.error || '完整路线尚未保存。请重新规划，或返回修改学习需求。'}</p>
                <RunContent parts={planningParts} />
              </div>
            ) : <Generating
              title={`正在为「${space.name}」规划学习路线`}
              steps={persistence ? ['分析学习需求', '生成路线内容', '校验路线结构', '保存完整路线'] : ['分析你的已有基础与目标', '拆分学习阶段', '安排单元顺序与目标', '整理路线说明']}
              note="这一步只生成路线和单元概要。每个单元的课件，会在你进入该单元时结合你当时的学习情况再生成。"
              parts={persistence ? planningParts : undefined}
              context={<RunContext runId={planning?.run?.id} />}
            />}
            {persistence && <div className="mt-6 flex flex-wrap gap-2">
              {planning?.run && ['failed', 'interrupted'].includes(planning.run.state) ? (
                <Button disabled={persistence.busy || !capabilities.agent} onClick={() => retryReply(planning.run!.id)}>重试规划</Button>
              ) : planning?.run && ['pending', 'running'].includes(planning.run.state) ? (
                <Button variant="outline" disabled={persistence.busy} onClick={stopReply}>停止规划</Button>
              ) : null}
              <Button variant="ghost" onClick={goSpaces}>全部学习空间</Button>
              {(!planning?.run || planningStopped) && <Button variant="ghost" onClick={() => setView('onboarding')}>返回修改需求</Button>}
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
            全部学习空间
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <label htmlFor="space-name" className="sr-only">
            学习空间名称
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
            第 1 步 · 确认学习需求
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

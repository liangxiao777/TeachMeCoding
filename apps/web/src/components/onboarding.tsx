'use client'

import { ArrowLeft, Check, ClipboardList, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentMessage, SessionMenu } from '@/components/agent/agent-panel'
import { RunContent } from '@/components/agent/run-content'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Suggestion } from '@/components/ai-elements/suggestion'
import { BrandMark, Generating, isComposing } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApp, useSpace } from '@/app/context'
import type { Requirement } from '@/app/types'

const SUGGESTIONS = [
  ['我想学习 Rust，最后能写一个命令行工具', '我想用 PyTorch 训练一个图像分类模型'],
  ['熟悉 Python，写过一些自动化脚本，没接触过 C/C++'],
  ['每周大概 5 小时，希望两个月内完成'],
  ['我还想顺便了解一下并发编程', '每周改成 8 小时'],
]

const FIELDS: { key: keyof Requirement; label: string }[] = [
  { key: 'goal', label: '学习目标' },
  { key: 'background', label: '已有基础' },
  { key: 'outcome', label: '期望达成' },
  { key: 'schedule', label: '时间安排' },
]

function RequirementCard() {
  const space = useSpace()
  const { updateRequirement, confirmRequirement, setView, capabilities, persistence } = useApp()
  const [previewEditing, setEditing] = useState(false)
  const [previewDraft, setPreviewDraft] = useState<Requirement | null>(null)
  const draft = persistence ? persistence.requirementDraft : previewDraft
  const setDraft = persistence ? persistence.setRequirementDraft : setPreviewDraft
  const editing = persistence ? draft !== null : previewEditing
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const req = space.requirement
  const busy = saving || !!persistence && (persistence.busy || !persistence.ready)

  const save = async () => {
    if (!draft || busy || savingRef.current) return
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
          <ul className="flex flex-col gap-4">
            {FIELDS.map((f) => (
              <li key={f.key} className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{f.label}</span>
                <Skeleton className="h-3 w-3/4 animate-none" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    )
  }

  const current = editing && draft ? draft : req
  const awaitingSummary = !!persistence && !Object.values(req).some((value) => value.trim())
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
              disabled={busy || !!persistence && !current.goal.trim()}
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
              setDraft(req)
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
        {editing ? (
          <FieldGroup className="gap-4">
            {FIELDS.map((f) => (
              <Field key={f.key}>
                <FieldLabel htmlFor={`req-${f.key}`}>{f.label}</FieldLabel>
                <Textarea
                  id={`req-${f.key}`}
                  rows={2}
                  value={current[f.key]}
                  onChange={(e) => setDraft({ ...current, [f.key]: e.target.value })}
                  className="resize-none leading-relaxed"
                />
              </Field>
            ))}
          </FieldGroup>
        ) : (
          <dl className="flex flex-col gap-4">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{f.label}</dt>
                <dd className="text-sm leading-relaxed">{current[f.key] || (persistence ? '待补充' : '')}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 border-t">
        <Button size="lg" disabled={editing || busy || persistence?.requirementConfirmed || !!persistence && !req.goal.trim()} onClick={confirmRequirement}>
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
  const { messages, step } = space.onboarding
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
  const suggestions = SUGGESTIONS[Math.min(step, SUGGESTIONS.length - 1)]!

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {persistence && <div className="flex h-12 shrink-0 items-center border-b"><SessionMenu /></div>}
      <Conversation key={session?.id ?? space.id} className="min-h-0" initial="instant" resize="instant" aria-label="学习需求会话">
        <ConversationContent className="gap-6 px-0 py-8">
          {(!persistence || messages.length === 0) && <Message from="assistant">
            <MessageContent>
              {capabilities.agent ? '你好，我是你的学习 Agent。先告诉我你想学什么、想学成什么样，我来帮你规划一条适合你的路线。' : 'Agent 暂不可用。这里仅保存你的问题，不会生成回复；请在右侧手动修改并确认学习需求。'}
            </MessageContent>
          </Message>}
          {messages.map((m) =>
            m.role === 'user' ? (
              <Message key={m.id} from="user"><MessageContent><p className="whitespace-pre-wrap">{m.text}</p></MessageContent></Message>
            ) : (
              <AgentMessage key={m.id} msg={{ ...m, createdAt: 0 }} />
            ),
          )}
          {!persistence && replying && (
            <div role="status" className="text-sm text-muted-foreground">
              <Shimmer>等待模型响应…</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="滚动到最新消息" />
      </Conversation>

      <div className="flex flex-col gap-3 pb-6">
        {!replying && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Suggestion key={s} suggestion={s} className="font-normal" disabled={busy} onClick={(value) => void send(value)} />
            ))}
          </div>
        )}
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
              placeholder={step === 0 ? '比如：我想学习 Rust，最后能写一个命令行工具' : '回复 Agent…'}
              className="leading-relaxed"
            />
            <PromptInputFooter>
              <span className="text-xs text-muted-foreground">
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
              steps={persistence ? ['模型规划学习路线', '校验路线结构', '保存完整路线'] : ['分析你的已有基础与目标', '拆分学习阶段', '安排单元顺序与目标', '整理路线说明']}
              note="这一步只生成路线和单元概要。每个单元的课件，会在你进入该单元时结合你当时的学习情况再生成。"
              parts={persistence ? planningParts : undefined}
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
    <div className="flex h-dvh flex-col">
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-6">
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
            className="w-64 border-transparent bg-transparent font-semibold shadow-none hover:border-input dark:bg-transparent"
          />
          <Badge variant="outline" className="ml-auto gap-1.5">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            第 1 步 · 确认学习需求
          </Badge>
        </div>
      </header>
      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-[1fr_380px] gap-10 px-6">
        <Chat />
        <aside className="-mx-8 flex flex-col overflow-y-auto px-8 py-8">
          <div className="relative isolate shrink-0">
            <div aria-hidden className="pointer-events-none absolute -inset-x-8 -inset-y-16 -z-10 bg-radial from-foreground/8 via-foreground/3 to-transparent to-70%" />
            <RequirementCard />
          </div>
        </aside>
      </div>
    </div>
  )
}

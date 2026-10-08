'use client'

import { ArrowLeft, Check, ClipboardList, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { intakeMetadataSchema, type LearningTarget } from '@teach-me-coding/contracts'
import { AgentMessage, SessionMenu } from '@/components/agent/agent-panel'
import { RunContent } from '@/components/agent/run-content'
import { QuestionRoundCard, ResearchCard } from '@/components/intake-panel'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Generating, isComposing } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApp, useSpace, type RequirementDraft } from '@/app/context'
import { ThemeToggle } from '@/app/theme'
import type { Requirement } from '@/app/types'

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
  const [previewDraft, setPreviewDraft] = useState<RequirementDraft | null>(null)
  const draft = persistence ? persistence.requirementDraft : previewDraft
  const setDraft = persistence ? persistence.setRequirementDraft : setPreviewDraft
  const editing = persistence ? draft !== null : previewEditing
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const req = space.requirement
  const busy = saving || !!persistence && (persistence.busy || !persistence.ready)
  const validIntake = !draft?.intake || intakeMetadataSchema.safeParse(draft.intake).success

  const save = async () => {
    if (!draft || busy || savingRef.current || !validIntake) return
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

  const current: RequirementDraft = editing && draft ? draft : { ...req, intake: persistence?.intake }
  const target = current.intake?.target
  const editTarget = (value: LearningTarget | null) => setDraft({ ...current, intake: value ? { target: value, researchRef: null } : null })
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
              disabled={busy || !validIntake || !!persistence && !current.goal.trim()}
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
              setDraft(persistence ? { ...req, intake: persistence.intake } : req)
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
                  onChange={(e) => setDraft({ ...current, [f.key]: e.target.value,
                    ...(persistence && (f.key === 'goal' || f.key === 'outcome') ? { intake: null } : {}) })}
                  className="resize-none leading-relaxed"
                />
              </Field>
            ))}
            {persistence && <>
              <Field>
                <FieldLabel htmlFor="req-target-kind">学习对象类型</FieldLabel>
                <select id="req-target-kind" disabled={saving} value={target?.kind ?? ''}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  onChange={(event) => editTarget(event.target.value === 'concept'
                    ? { kind: 'concept', name: target?.name ?? '', scope: target?.scope ?? '' }
                    : event.target.value === 'technology' ? { kind: 'technology', name: target?.name ?? '', scope: target?.scope ?? '', version: '' } : null)}>
                  <option value="">待明确</option><option value="concept">概念学习（无需技术版本）</option><option value="technology">具体技术</option>
                </select>
              </Field>
              {target && <>
                <Field>
                  <FieldLabel htmlFor="req-target-name">{target.kind === 'technology' ? '技术对象' : '概念名称'}</FieldLabel>
                  <Input id="req-target-name" disabled={saving} maxLength={500} value={target.name} onChange={(event) => editTarget({ ...target, name: event.target.value })} />
                </Field>
                {target.kind === 'technology' && <Field>
                  <FieldLabel htmlFor="req-target-version">具体适用版本</FieldLabel>
                  <Input id="req-target-version" disabled={saving} maxLength={500} value={target.version} placeholder="填写具体版本，不使用最新版 / latest"
                    onChange={(event) => editTarget({ ...target, version: event.target.value })} />
                </Field>}
                <Field>
                  <FieldLabel htmlFor="req-target-scope">学习 / 核验范围</FieldLabel>
                  <Textarea id="req-target-scope" disabled={saving} rows={2} maxLength={10_000} value={target.scope} onChange={(event) => editTarget({ ...target, scope: event.target.value })} />
                </Field>
              </>}
              {!validIntake && <p role="status" className="text-xs text-destructive">请填写对象名称、范围；具体技术还需明确版本，不能使用“最新版”。</p>}
              <p className="text-xs leading-relaxed text-muted-foreground">修改目标或期望会清除对象与核验资料；修改技术、版本或范围会清除资料引用，需重新核验。仅修改基础或时间可保留资料。</p>
            </>}
          </FieldGroup>
        ) : (
          <dl className="flex flex-col gap-4">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1">
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{f.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-sm leading-relaxed">{current[f.key] || (persistence ? '待补充' : '')}</dd>
              </div>
            ))}
            {persistence && <>
              <div className="flex flex-col gap-1">
                <dt className="text-xs font-medium tracking-wider text-muted-foreground">{target?.kind === 'concept' ? '概念对象' : '技术对象'}</dt>
                <dd className="break-words text-sm">{target?.name || '待明确'}</dd>
              </div>
              {target?.kind === 'technology' && <div className="flex flex-col gap-1">
                <dt className="text-xs font-medium tracking-wider text-muted-foreground">具体适用版本</dt>
                <dd className="break-words text-sm">{target.version}</dd>
              </div>}
              <div className="flex flex-col gap-1">
                <dt className="text-xs font-medium tracking-wider text-muted-foreground">学习 / 核验范围</dt>
                <dd className="whitespace-pre-wrap break-words text-sm">{target?.scope || '待明确'}</dd>
              </div>
            </>}
          </dl>
        )}
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
          disabled={editing || busy || persistence?.requirementConfirmed || !!persistence && (!req.goal.trim() || !persistence.readiness?.ready)} onClick={confirmRequirement}>
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
        <ConversationScrollButton aria-label="滚动到最新消息" />
      </Conversation>

      <div className="flex flex-col gap-3 pb-6">
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
        <ThemeToggle className="fixed top-3 right-3 z-10" />
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
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
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
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-1 gap-6 overflow-y-auto px-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-10 lg:overflow-visible lg:px-6">
        <Chat />
        <aside className="flex min-w-0 flex-col pb-8 lg:-mx-8 lg:overflow-y-auto lg:px-8 lg:py-8">
          <div className="relative isolate shrink-0">
            <div aria-hidden className="pointer-events-none absolute -inset-x-8 -inset-y-16 -z-10 bg-radial from-foreground/8 via-foreground/3 to-transparent to-70%" />
            <RequirementCard />
          </div>
        </aside>
      </div>
    </div>
  )
}

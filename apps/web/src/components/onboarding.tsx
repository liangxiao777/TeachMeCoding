'use client'

import { ArrowLeft, ArrowUp, Check, ClipboardList, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BrandMark, Generating, isComposing } from '@/components/shared'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApp, useSpace } from '@/fixtures/store'
import type { Requirement } from '@/fixtures/types'

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
  const { updateRequirement, confirmRequirement } = useApp()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Requirement | null>(null)
  const req = space.requirement

  if (!space.onboarding.summaryReady || !req) {
    return (
      <Card className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
        <CardHeader>
          <CardTitle>学习需求摘要</CardTitle>
          <CardDescription className="leading-relaxed">
            Agent 了解你的目标、基础和期望后，会在这里整理出一份需求摘要。你确认之后才会生成学习路线。
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
  return (
    <Card aria-labelledby="req-title" className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
      <CardHeader>
        <CardTitle id="req-title" className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" aria-hidden />
          学习需求摘要
        </CardTitle>
        <CardDescription>确认后 Agent 会据此规划路线</CardDescription>
        <CardAction>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (draft) updateRequirement(draft)
                setEditing(false)
              }}
            >
              保存
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(req)
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
                <dd className="text-sm leading-relaxed">{current[f.key]}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 border-t">
        <Button size="lg" disabled={editing} onClick={confirmRequirement}>
          <Check data-icon="inline-start" />
          确认，开始规划路线
        </Button>
        <p className="text-center text-xs text-muted-foreground">不准确？直接修改，或在左侧继续告诉 Agent</p>
      </CardFooter>
    </Card>
  )
}

function Chat() {
  const space = useSpace()
  const { onboardSend } = useApp()
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const { messages, agentTyping, step } = space.onboarding

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, agentTyping])

  const send = (value: string) => {
    if (!value.trim() || agentTyping) return
    onboardSend(value)
    setText('')
  }
  const suggestions = SUGGESTIONS[Math.min(step, SUGGESTIONS.length - 1)]!

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 py-8">
          <div className="flex gap-3">
            <BrandMark className="shrink-0" />
            <p className="max-w-lg rounded-2xl rounded-tl-sm bg-card px-4 py-3 text-sm leading-relaxed shadow-sm">
              你好，我是你的学习 Agent。先告诉我你想学什么、想学成什么样，我来帮你规划一条适合你的路线。
            </p>
          </div>
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-lg rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground">
                  {m.text}
                </p>
              </div>
            ) : (
              <div key={m.id} className="flex gap-3">
                <BrandMark className="shrink-0" />
                <p className="max-w-lg rounded-2xl rounded-tl-sm bg-card px-4 py-3 text-sm leading-relaxed shadow-sm">
                  {m.text}
                </p>
              </div>
            ),
          )}
          {agentTyping && (
            <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
              <Avatar aria-hidden className="size-7 rounded-lg after:rounded-lg">
                <AvatarFallback className="rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground shadow-sm">
                  {'>_'}
                </AvatarFallback>
              </Avatar>
              <span className="shimmer">Thinking...</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="flex flex-col gap-3 pb-6">
        {!agentTyping && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Button key={s} variant="outline" size="sm" className="rounded-full font-normal" onClick={() => send(s)}>
                {s}
              </Button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send(text)
          }}
        >
          <InputGroup className="rounded-xl bg-card shadow-sm">
            <label htmlFor="ob-input" className="sr-only">
              回复 Agent
            </label>
            <InputGroupTextarea
              id="ob-input"
              rows={2}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                  e.preventDefault()
                  send(text)
                }
              }}
              placeholder={step === 0 ? '比如：我想学习 Rust，最后能写一个命令行工具' : '回复 Agent…'}
              className="leading-relaxed"
            />
            <InputGroupAddon align="block-end">
              <span className="text-xs text-muted-foreground">
                <Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行
              </span>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                className="ml-auto rounded-full"
                disabled={!text.trim() || agentTyping}
                aria-label="发送"
              >
                <ArrowUp />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  )
}

export function Onboarding() {
  const space = useSpace()
  const { goSpaces, renameSpace } = useApp()

  if (space.view === 'planning') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent>
            <Generating
              title={`正在为「${space.name}」规划学习路线`}
              steps={['分析你的已有基础与目标', '拆分学习阶段', '安排单元顺序与目标', '整理路线说明']}
              note="这一步只生成路线和单元概要。每个单元的课件，会在你进入该单元时结合你当时的学习情况再生成。"
            />
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

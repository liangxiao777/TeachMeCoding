'use client'

import { ArrowRight, ArrowUpRight, LayoutGrid, Plus } from 'lucide-react'
import { useState } from 'react'
import { LearningHome } from '@/components/learning-home'
import { Brand, isComposing } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { SettingsButton } from '@/components/settings/settings-page'
import { Suggestion } from '@/components/ai-elements/suggestion'
import { allUnits, findUnit, relativeTime } from '@/app/selectors'
import { useApp } from '@/app/context'
import { ThemeToggle } from '@/app/theme'
import { cn } from '@/lib/utils'
import type { Space } from '@/app/types'

const EXAMPLES = [
  { label: 'Rust 命令行工具', goal: '我想学习 Rust，最后能写一个命令行工具' },
  { label: 'PyTorch 图像分类', goal: '我想用 PyTorch 训练一个图像分类模型' },
  { label: 'Go 后端服务', goal: '我想学会用 Go 写后端服务' },
]

function StartInput({ autoFocus }: { autoFocus?: boolean }) {
  const { createSpace, persistence } = useApp()
  const [text, setText] = useState('')
  const busy = !!persistence && (persistence.busy || !persistence.ready)
  const start = (value: string) => {
    if (!value.trim() || busy) return
    createSpace(value)
  }
  return (
    <div className="startup-composer mx-auto flex w-full max-w-[40rem] flex-col gap-5">
      <PromptInput className="startup-prompt" onReset={(event) => event.preventDefault()} onSubmit={() => start(text)}>
          <label htmlFor="goal-input" className="sr-only">
            你想学什么
          </label>
          <PromptInputTextarea
            id="goal-input"
            autoFocus={autoFocus}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isComposing(e)) e.preventDefault()
            }}
            placeholder="说说你想学什么，比如：我想学习 Rust，最后能写一个命令行工具"
            className="text-base"
          />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit className="startup-submit" aria-label="开始" size="sm" disabled={!text.trim() || busy}>
              开始
              <ArrowRight data-icon="inline-end" />
            </PromptInputSubmit>
          </PromptInputFooter>
      </PromptInput>
      <div className="startup-examples flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
        <span className="text-[13px] text-muted-foreground">试一试：</span>
        {EXAMPLES.map((ex) => (
          <Suggestion key={ex.goal} suggestion={ex.goal} aria-label={ex.goal} variant="ghost" className="startup-example" disabled={busy} onClick={setText}>
            {ex.label}
            <ArrowUpRight className="size-3" aria-hidden />
          </Suggestion>
        ))}
      </div>
    </div>
  )
}

function Home() {
  return (
    <LearningHome>
      <StartInput autoFocus />
    </LearningHome>
  )
}

function SpaceCard({ space }: { space: Space }) {
  const { openSpace } = useApp()
  const units = allUnits(space)
  const done = units.filter((u) => u.status === 'passed' || u.status === 'skipped').length
  const unit = findUnit(space, space.currentUnitId)
  const inOnboarding = space.view === 'onboarding' || space.view === 'planning'
  const position = inOnboarding
    ? '正在确认学习需求'
    : space.completed
      ? '已完成全部单元'
      : space.view === 'assessment' || space.draft
        ? `「${unit?.title}」测评进行中`
        : unit
          ? `正在学习「${unit.title}」`
          : '尚未开始'

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader>
        <CardTitle className="text-lg tracking-tight">{space.name}</CardTitle>
        <CardDescription className="line-clamp-2 leading-relaxed">
          {space.requirement?.rows.find((row) => row.answer.trim())?.answer ?? space.onboarding.messages[0]?.text ?? '尚未确定学习目标'}
        </CardDescription>
        <CardAction>
          <Badge variant="secondary" className="font-mono">
            {space.topic || '—'}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{position}</span>
          {units.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground">
              {done}/{units.length}
            </span>
          )}
        </div>
        {units.length > 0 && (
          <div className="flex gap-1" aria-hidden>
            {units.map((u) => (
              <span
                key={u.id}
                className={cn(
                  'h-1.5 flex-1 rounded-full bg-muted',
                  (u.status === 'passed' || u.status === 'skipped') && 'bg-primary',
                  u.id === space.currentUnitId && u.status !== 'passed' && 'bg-primary/40',
                )}
              />
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="mt-auto justify-between border-t bg-muted/40 py-3">
        <span className="text-xs text-muted-foreground">
          {space.sessions.length} 个会话 · {relativeTime(space.lastActive)}
        </span>
        <Button size="sm" onClick={() => openSpace(space.id)}>
          继续学习
          <ArrowRight data-icon="inline-end" />
        </Button>
      </CardFooter>
    </Card>
  )
}

export function SpaceList() {
  const { state, goHome, goSpaces } = useApp()
  const spaces = state.spaces
  const onHome = state.globalView === 'home'
  return (
    <div className={cn('min-h-dvh', onHome && 'startup-page relative isolate')}>
      <header className={cn('sticky top-0 z-10 border-b bg-background/80 backdrop-blur', onHome && 'startup-header')}>
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Brand onClick={goHome} />
          <div className="startup-actions flex items-center gap-2">
            <SettingsButton />
            {onHome ? (
              <Button variant="ghost" onClick={goSpaces}>
                <LayoutGrid data-icon="inline-start" />
                学习空间
              </Button>
            ) : (
              <Button onClick={goHome}>
                <Plus data-icon="inline-start" />
                创建学习空间
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6">
        {onHome ? (
          <Home />
        ) : (
          <div className="flex flex-col gap-8 py-12">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-3xl font-semibold tracking-tight">学习空间</h1>
              <p className="text-muted-foreground">
                {spaces.length ? '选择一个空间，从上次离开的地方继续。' : '还没有学习空间，先创建一个，开始你的学习之旅。'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-5 xl:grid-cols-3">
              {spaces.map((s) => (
                <SpaceCard key={s.id} space={s} />
              ))}
              <button
                type="button"
                onClick={goHome}
                className="group flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-muted transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Plus className="size-5" aria-hidden />
                </span>
                <span className="flex flex-col items-center gap-0.5">
                  <span className="text-sm font-medium">创建新的学习空间</span>
                  <span className="text-xs">告诉 Agent 你想学什么</span>
                </span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

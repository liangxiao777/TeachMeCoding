'use client'

import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleCheck,
  Copy,
  Lightbulb,
  MessageSquareQuote,
  RotateCcw,
  SquareTerminal,
  Target,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import { Generating, InlineText, RichText, StatusPill } from '@/components/shared'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from '@/components/ui/item'
import { findUnit } from '@/app/selectors'
import type { LessonBlock } from '@/app/types'
import { useApp, useSpace } from '@/app/context'

const scrollMemory = new Map<string, number>()
const lessonHighlighter = createHighlighterCore({
  themes: [bundledThemes['github-dark']], langs: [], engine: createJavaScriptRegexEngine(),
})

function CodeBlock({ block }: { block: Extract<LessonBlock, { type: 'code' }> }) {
  const { bringToIde, persistence } = useApp()
  const [copied, setCopied] = useState(false)
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; html: string } | null>(null)
  useEffect(() => {
    let active = true
    const language = block.language.toLowerCase() as BundledLanguage
    lessonHighlighter.then(async (highlighter) => {
      const lang = Object.hasOwn(bundledLanguages, language) ? language : 'text'
      if (lang !== 'text') await highlighter.loadLanguage(bundledLanguages[lang])
      return highlighter.codeToHtml(block.code, { lang, theme: 'github-dark' })
    })
      .then((html) => { if (active) setHighlighted({ code: block.code, language: block.language, html }) })
      .catch(() => { /* Preserve the raw snippet if highlighting cannot load. */ })
    return () => { active = false }
  }, [block.code, block.language])
  const html = highlighted?.code === block.code && highlighted.language === block.language ? highlighted.html : null
  return (
    <figure className="flex flex-col overflow-hidden rounded-xl bg-ide text-ide-foreground shadow-sm ring-1 ring-foreground/10">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="flex items-center gap-2 font-mono text-xs opacity-70">
          <span className="flex gap-1" aria-hidden>
            <span className="size-2 rounded-full bg-white/20" />
            <span className="size-2 rounded-full bg-white/20" />
            <span className="size-2 rounded-full bg-white/20" />
          </span>
          {block.file}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="text-ide-foreground/70 hover:bg-white/10 hover:text-ide-foreground"
            onClick={() => {
              navigator.clipboard?.writeText(block.code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? '已复制' : '复制'}
          </Button>
          <Button size="xs" disabled={persistence && (!persistence.ready || persistence.busy)} onClick={() => bringToIde(block.code, block.file)}>
            <SquareTerminal data-icon="inline-start" />
            带入 IDE
          </Button>
        </div>
      </div>
      {html ? <div className="[&_pre]:overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">{block.code}</pre>}
      {block.caption && (
        <figcaption className="border-t border-white/10 px-4 py-2 text-xs leading-relaxed opacity-70">{block.caption}</figcaption>
      )}
    </figure>
  )
}

function LessonText({ text }: { text: string }) {
  return <RichText text={text} renderCode={(code, language) => {
    const extensions: Record<string, string> = { rust: 'rs', python: 'py', typescript: 'ts', ts: 'ts', javascript: 'js', js: 'js', json: 'json', bash: 'sh', sh: 'sh' }
    return <CodeBlock block={{ type: 'code', code, language, file: `example.${extensions[language] ?? 'txt'}` }} />
  }} />
}

function MoveDiagram() {
  const Cell = ({ name, valid }: { name: string; valid: boolean }) => (
    <div
      className={
        valid
          ? 'flex items-center justify-between rounded-md border-2 border-primary bg-primary/5 px-3 py-2'
          : 'flex items-center justify-between rounded-md border-2 border-dashed border-input px-3 py-2 text-muted-foreground line-through'
      }
    >
      <span className="font-mono text-sm">{name}</span>
      <span className="font-mono text-xs">{valid ? 'ptr · len 5 · cap 5' : '已失效'}</span>
    </div>
  )
  return (
    <figure className="flex flex-col gap-3 rounded-lg border bg-card p-5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">栈 · 执行 let s2 = s1; 之后</p>
          <Cell name="s1" valid={false} />
          <Cell name="s2" valid />
        </div>
        <ArrowUpRight className="size-5 rotate-45 text-primary" aria-hidden />
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">堆</p>
          <div className="flex gap-1 font-mono text-sm">
            {'hello'.split('').map((c, i) => (
              <span key={i} className="flex size-9 items-center justify-center rounded border bg-muted">
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="text-xs leading-relaxed text-muted-foreground">
        只有 s2 指向堆上的数据。s2 离开作用域时释放这块内存，s1 不会再次释放它。
      </figcaption>
    </figure>
  )
}

function Block({ block }: { block: LessonBlock }) {
  switch (block.type) {
    case 'markdown':
      return <LessonText text={block.text} />
    case 'h2':
      return (
        <h2 id={block.id} className="scroll-mt-6 pt-4 text-xl font-semibold tracking-tight">
          <InlineText text={block.text} />
        </h2>
      )
    case 'p':
      return <LessonText text={block.text} />
    case 'list':
      return (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 leading-relaxed marker:text-muted-foreground">
          {block.items.map((i) => (
            <li key={i}>
              <InlineText text={i} />
            </li>
          ))}
        </ul>
      )
    case 'code':
      return <CodeBlock block={block} />
    case 'callout':
      return (
        <Alert className="border-primary/25 bg-primary/5">
          <Lightbulb className="text-primary" />
          <AlertTitle>{block.title}</AlertTitle>
          <AlertDescription className="min-w-0 leading-relaxed">
            <LessonText text={block.text} />
          </AlertDescription>
        </Alert>
      )
    case 'practice':
      return (
        <ItemGroup className="gap-2">
          {block.items.map((item, i) => (
            <Item key={item} variant="outline" size="sm" className="bg-card">
              <ItemMedia className="size-6 rounded-full bg-primary/10 font-mono text-xs text-primary">{i + 1}</ItemMedia>
              <ItemContent>
                <ItemDescription className="line-clamp-none text-sm leading-relaxed text-foreground">
                  <InlineText text={item} />
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )
    case 'diagram-move':
      return <MoveDiagram />
  }
}

export function LessonReader({ inDrawer = false, onAsk }: { inDrawer?: boolean; onAsk?: () => void }) {
  const space = useSpace()
  const { setQuote, retryGeneration, setView, viewRecord, lesson: getLesson, capabilities, persistence } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pop, setPop] = useState<{ x: number; y: number; text: string } | null>(null)
  const memKey = `${space.id}:${unit?.id}${inDrawer ? ':drawer' : ''}`
  const ready = unit?.contentState === 'ready'

  useEffect(() => {
    if (ready && scrollRef.current) scrollRef.current.scrollTop = scrollMemory.get(memKey) ?? 0
  }, [ready, memKey, space.ideFullscreen])

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!sel || text.length < 2 || !sel.rangeCount) {
      setPop(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setPop({ x: rect.left + rect.width / 2, y: rect.top, text })
  }, [])

  if (!unit) return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>单元暂不可用</EmptyTitle>
        <EmptyDescription>请返回学习路线选择可用单元。</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => setView('route')}>返回学习路线</Button>
      </EmptyContent>
    </Empty>
  )
  const lesson = ready ? getLesson(unit) : null
  const location = (() => {
    for (const [si, st] of space.stages.entries()) {
      const ui = st.units.findIndex((u) => u.id === unit.id)
      if (ui !== -1) return `阶段 ${si + 1} · ${st.title} · 单元 ${ui + 1}`
    }
    return ''
  })()
  const lastRecord = [...space.records].reverse().find((r) => r.unitId === unit.id)

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        if (!space.ideFullscreen || inDrawer) scrollMemory.set(memKey, e.currentTarget.scrollTop)
        if (pop) setPop(null)
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <article className="lesson-prose mx-auto flex max-w-3xl flex-col gap-5 px-10 py-10" onMouseUp={onMouseUp}>
        <header className="flex flex-col gap-4 pb-2">
          <p className="font-mono text-xs text-muted-foreground">{location}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-balance text-4xl font-semibold tracking-tight">{unit.title}</h1>
            <StatusPill status={unit.status} />
          </div>
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Target className="size-3.5" aria-hidden />
              本单元目标
            </p>
            <ul className="flex flex-col gap-1.5">
              {unit.goals.map((g) => (
                <li key={g} className="flex items-start gap-2 text-sm leading-relaxed">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  {g}
                </li>
              ))}
            </ul>
          </div>
        </header>

        {unit.status === 'needs_work' && unit.lastAdvice && unit.lastAdvice.length > 0 && (
          <Alert aria-label="测评建议" className="border-accent-foreground/25 bg-accent/50">
            <RotateCcw className="text-accent-foreground" />
            <AlertTitle className="text-accent-foreground">上次测评建议加强这些地方</AlertTitle>
            {lastRecord && (
              <AlertAction>
                <Button variant="outline" size="xs" onClick={() => viewRecord(lastRecord.id)}>
                  查看测评结果
                </Button>
              </AlertAction>
            )}
            <AlertDescription>
              <ul className="mt-2 flex w-full flex-col gap-1.5">
                {unit.lastAdvice.map((a) => (
                  <li key={a} className="flex items-start justify-between gap-3 rounded-md bg-card px-3 py-2 text-sm text-foreground">
                    <span className="leading-relaxed">{a}</span>
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto shrink-0 p-0"
                      onClick={() => { setQuote({ source: 'advice', label: '测评建议', text: a }); onAsk?.() }}
                    >
                      就此提问
                    </Button>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {unit.contentState === 'generating' && capabilities.agent && (
          <Generating
            className="py-6"
            title="正在为你生成课件"
            steps={persistence ? ['分析单元目标', '生成课件内容', '校验课件结构', '保存课件'] : ['回顾你的学习目标与背景', '参考之前单元的会话与测评', '组织讲解与示例代码', '准备练习']}
            parts={persistence ? persistence.taskParts[persistence.tasks.findLast((t) => t.unitId === unit.id && t.kind === 'lesson')?.id ?? ''] ?? [] : undefined}
            note="课件会结合你此刻的学习情况生成，所以和别人看到的可能不一样。"
          />
        )}

        {unit.contentState === 'failed' && (
          <Empty className="border border-destructive/30 bg-destructive/5">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
                <AlertTriangle />
              </EmptyMedia>
              <EmptyTitle>课件生成失败</EmptyTitle>
              <EmptyDescription>
                {capabilities.agent
                  ? '生成过程中出现了问题，你的路线、会话和代码都没有受影响。可以重新生成，或先向 Agent 提问。'
                  : '课件生成失败，当前生成服务暂不可用。你的路线、会话和代码都没有受影响。'}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button disabled={!capabilities.agent || !!persistence?.busy} onClick={() => retryGeneration(unit.id)}>
                <RotateCcw data-icon="inline-start" />
                重新生成
              </Button>
              <Button variant="outline" onClick={() => setView('route')}>
                返回学习路线
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {!lesson && unit.contentState !== 'failed' && (unit.contentState !== 'generating' || !capabilities.agent) && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>课件暂不可用</EmptyTitle>
              <EmptyDescription>当前单元尚无可读取的课件内容。你的学习路线、会话和代码不会受影响。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {persistence && capabilities.agent && <Button disabled={persistence.busy} onClick={() => retryGeneration(unit.id)}>生成课件</Button>}
              <Button variant="outline" onClick={() => setView('route')}>返回学习路线</Button>
            </EmptyContent>
          </Empty>
        )}

        {lesson && (
          <>
            {lesson.intro && <p className="border-l-2 border-primary pl-4 text-lg leading-relaxed text-muted-foreground">{lesson.intro}</p>}
            {lesson.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
            <footer className="mt-6 flex flex-col gap-2 border-t pt-6 text-sm text-muted-foreground">
              <p>{capabilities.assessment
                ? '读完并动手试过之后，可以点击右上角「开始单元测评」检验掌握情况。'
                : '测评运行与评估暂不可用，仍可保存答案草稿。'}</p>
            </footer>
          </>
        )}
      </article>

      {pop && (
        <Button
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuote({ source: 'lesson', label: `${unit.title} · 课件`, text: pop.text })
            window.getSelection()?.removeAllRanges()
            setPop(null)
            onAsk?.()
          }}
          style={{ left: pop.x, top: pop.y - 8 }}
          className="fixed z-30 -translate-x-1/2 -translate-y-full rounded-full shadow-lg"
        >
          <MessageSquareQuote data-icon="inline-start" />
          向 Agent 提问
        </Button>
      )}
    </div>
  )
}

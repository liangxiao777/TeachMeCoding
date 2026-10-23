'use client'

import {
  AlertTriangle,
  Check,
  CircleCheck,
  Copy,
  Lightbulb,
  MessageSquareQuote,
  RotateCcw,
  SquareTerminal,
  Target,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { lessonMarkdown, type LessonProposal } from '@teach-me-coding/contracts'
import { toString } from 'mdast-util-to-string'
import type { PluggableList } from 'unified'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import type { ExtraProps } from 'streamdown'
import { Generating, InlineText, RichText, StatusPill } from '@/components/shared'
import { RunContext } from '@/components/agent/run-context'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from '@/components/ui/item'
import { findUnit } from '@/app/selectors'
import type { LessonBlock } from '@/app/types'
import { useApp, useSpace } from '@/app/context'
import { lessonAllowedTags, lessonHeadingId, lessonHeadings, lessonRemarkPlugins, scopedLessonHeadings } from '@/lib/lesson-markdown'
import { diffLesson, lessonDiffAllowedTags, lessonDiffRemark } from '@/lib/lesson-diff'
import { pendingDecision } from '@/app/lesson-proposals'
import { cn } from '@/lib/utils'

const scrollMemory = new Map<string, number>()
const lessonHighlighter = createHighlighterCore({
  themes: [bundledThemes['github-dark']], langs: [], engine: createJavaScriptRegexEngine(),
})

function CodeBlock({ block, readOnly = false }: { block: Extract<LessonBlock, { type: 'code' }>; readOnly?: boolean }) {
  const { t } = useTranslation('workbench')
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
            {copied ? t('controls.copied') : t('controls.copy')}
          </Button>
          <Button size="xs" disabled={readOnly || !persistence.ready || persistence.busy} onClick={() => { if (!readOnly) bringToIde(block.code, block.file) }}>
            <SquareTerminal data-icon="inline-start" />
            {t('controls.bringToIde')}
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

function Practice({ question, children, onAsk, readOnly = false }: { question: string; children?: ReactNode; onAsk?: () => void; readOnly?: boolean }) {
  const { t } = useTranslation(['workbench', 'common'])
  const space = useSpace()
  const { setQuote, persistence } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  return (
    <section aria-label={t('lesson.practice')} className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
      <header className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Target className="size-4 text-primary" aria-hidden />{t('lesson.practice')}</p>
        <Button variant="outline" size="xs" disabled={readOnly || !question.trim() || !persistence.ready || persistence.busy}
          onClick={() => { if (readOnly) return; setQuote({ source: 'lesson', label: t('common:quotes.practice', { title: unit?.title ?? t('common:quotes.lessonFallback') }), caption: { kind: 'practice', name: unit?.title ?? '' }, text: question }); onAsk?.() }}>
          <MessageSquareQuote data-icon="inline-start" />{t('controls.ask')}
        </Button>
      </header>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  )
}

type TeachingProps = ExtraProps & { children?: ReactNode }
function LessonText({ text, enhanced = false, inDrawer = false, onAsk, readOnly = false, scope, diffPlugins }: {
  text: string; enhanced?: boolean; inDrawer?: boolean; onAsk?: () => void; readOnly?: boolean; scope?: string; diffPlugins?: PluggableList
}) {
  const { t } = useTranslation('workbench')
  return <RichText key={`${scope ?? 'normal'}:${inDrawer}:${readOnly}`} text={text} renderMermaid={enhanced}
    remarkPlugins={enhanced ? [...lessonRemarkPlugins, ...(scope ? [[scopedLessonHeadings, { scope, inDrawer }]] as PluggableList : []), ...(diffPlugins ?? [])] : undefined}
    allowedTags={enhanced ? { ...lessonAllowedTags, ...lessonDiffAllowedTags } : undefined}
    normalizeHtmlIndentation={enhanced ? false : undefined}
    components={enhanced ? {
      h2: ({ node, children }) => <h2 id={typeof node?.properties.id === 'string' ? node.properties.id : node?.position?.start.offset !== undefined ? lessonHeadingId(node.position.start.offset, inDrawer) : undefined}
        className="scroll-mt-6 pt-4 text-xl font-semibold tracking-tight">{children}</h2>,
      'lesson-change': ({ node, children }: TeachingProps) => {
        const change = String(node?.properties.change)
        return <section data-change={change} data-side={node?.properties.side} className={cn('min-w-0 space-y-3 rounded-lg px-4 py-3',
          change === 'removed' ? 'border-l-4 border-red-500 bg-red-500/10' : change === 'added' ? 'border-l-4 border-green-500 bg-green-500/10' : 'px-0')}>
          {change !== 'unchanged' && <p className={cn('text-xs font-medium', change === 'removed' ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300')}>{change === 'removed' ? t('lesson.removed') : t('lesson.added')}</p>}
          {children}
        </section>
      },
      'lesson-change-note': ({ node, children }: TeachingProps) => <aside data-testid="lesson-change-note" className="space-y-2 rounded-md border bg-background/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground [&_code]:break-all [&_code]:whitespace-pre-wrap">
        <p className="font-medium text-foreground">{String(node?.properties.label ?? t('lesson.changeNote'))}</p>
        {children}
      </aside>,
      'lesson-callout': ({ node, children }: TeachingProps) => {
        const warning = node?.properties.kind === 'warning'
        return <Alert className={warning ? 'border-accent-foreground/25 bg-accent/50' : 'border-primary/25 bg-primary/5'}>
          {warning ? <AlertTriangle className="text-accent-foreground" /> : <Lightbulb className="text-primary" />}
          <AlertTitle>{warning ? t('lesson.warning') : t('lesson.tip')}</AlertTitle>
          <AlertDescription className="min-w-0 space-y-3 leading-relaxed">{children}</AlertDescription>
        </Alert>
      },
      'lesson-practice': ({ node, children }: TeachingProps) => <Practice question={String(node?.properties.question ?? '')} onAsk={onAsk} readOnly={readOnly}>{children}</Practice>,
      'lesson-hint': ({ children }: TeachingProps) => <details open={readOnly || undefined} className="rounded-lg border bg-muted/30 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">{t('lesson.hint')}</summary>
        <div className="mt-3 min-w-0 space-y-3 text-sm leading-relaxed">{children}</div>
      </details>,
      'lesson-solution': ({ children }: TeachingProps) => <details open={readOnly || undefined} className="rounded-lg border bg-muted/30 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">{t('lesson.solution')}</summary>
        <div className="mt-3 min-w-0 space-y-3 text-sm leading-relaxed">{children}</div>
      </details>,
    } : undefined}
    renderCode={(code, language, meta) => {
      const extensions: Record<string, string> = { rust: 'rs', python: 'py', typescript: 'ts', ts: 'ts', javascript: 'js', js: 'js', json: 'json', bash: 'sh', sh: 'sh' }
      const file = /(?:^|\s)file=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta)
      return <CodeBlock readOnly={readOnly} block={{ type: 'code', code, language, file: file?.[1] ?? file?.[2] ?? file?.[3] ?? `example.${extensions[language] ?? 'txt'}` }} />
    }} />
}

function LessonProposalPreview({ proposal, inDrawer }: { proposal: LessonProposal; inDrawer: boolean }) {
  const { t } = useTranslation('workbench')
  const before = useMemo(() => lessonMarkdown(proposal.baseLesson), [proposal.baseLesson])
  const after = proposal.content.content
  const diff = useMemo(() => diffLesson(before, after), [before, after])
  const headings = useMemo(() => {
    if (diff.fallback) return [...lessonHeadings(before, inDrawer, `${proposal.id}-before`), ...lessonHeadings(after, inDrawer, `${proposal.id}-after`)]
    return diff.rows.flatMap((row) => {
      const side = row.change === 'removed' ? 'before' : 'after'
      const node = (side === 'before' ? row.before : row.after)?.node
      return node?.type === 'heading' && node.depth === 2 ? [{ id: lessonHeadingId(node.position!.start.offset!, inDrawer, `${proposal.id}-${side}`),
        text: `${row.change === 'removed' ? '− ' : row.change === 'added' ? '+ ' : ''}${toString(node)}` }] : []
    })
  }, [before, after, diff, proposal.id, inDrawer])
  const title = (side: 'before' | 'after', changed = false) => <div className={cn('rounded-lg p-4', changed && (side === 'before' ? 'border-l-4 border-red-500 bg-red-500/10' : 'border-l-4 border-green-500 bg-green-500/10'))}>
    {(changed || diff.fallback) && <p className="mb-2 text-xs text-muted-foreground">{side === 'before' ? t('lesson.beforeTitle') : t('lesson.afterTitle')}</p>}
    <h1 id={`${lessonHeadingId(0, inDrawer, `${proposal.id}-${side}`)}-title`} className="text-balance text-3xl font-semibold tracking-tight" data-testid={`lesson-title-${side}`}>
      {side === 'before' ? proposal.baseLesson.title : proposal.content.title}
    </h1>
  </div>
  const renderDocument = (side: 'before' | 'after') => <section className={cn('min-w-0 space-y-5 rounded-lg border-l-4 p-4', side === 'before' ? 'border-red-500 bg-red-500/5' : 'border-green-500 bg-green-500/5')} data-side={side}>
    {title(side)}
    <LessonText text={side === 'before' ? before : after} enhanced readOnly inDrawer={inDrawer} scope={`${proposal.id}-${side}`} />
  </section>
  return <div className="min-h-0 flex-1 overflow-y-auto" data-testid="lesson-proposal-preview" data-proposal-id={proposal.id} data-location={inDrawer ? 'drawer' : 'main'}>
    <article className="lesson-prose mx-auto flex max-w-3xl flex-col gap-5 px-8 py-8">
      {headings.length > 0 && <nav aria-label={t('lesson.proposalContents')} data-testid="lesson-preview-toc"><details><summary className="cursor-pointer text-sm">{t('lesson.contents')}</summary><ul className="mt-2 space-y-1">
        {headings.map((heading) => <li key={heading.id}><a href={`#${heading.id}`} className="text-sm text-muted-foreground hover:text-foreground" onClick={(event) => {
          event.preventDefault(); document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}>{heading.text}</a></li>)}
      </ul></details></nav>}
      {!diff.fallback && <>{proposal.baseLesson.title !== proposal.content.title ? <>{title('before', true)}{title('after', true)}</> : title('after')}</>}
      {diff.fallback ? <><p role="status" className="text-sm text-muted-foreground">{t('lesson.diffFallback')}</p>{renderDocument('before')}{renderDocument('after')}</>
        : <LessonText key="inline-diff" text={after} enhanced readOnly inDrawer={inDrawer} scope={`${proposal.id}-diff`}
          diffPlugins={[[lessonDiffRemark, { diff, proposalId: proposal.id, inDrawer }]]} />}
    </article>
  </div>
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
  }
}

export function LessonReader({ inDrawer = false, onAsk }: { inDrawer?: boolean; onAsk?: () => void }) {
  const { t } = useTranslation(['workbench', 'common'])
  const space = useSpace()
  const { setQuote, retryGeneration, setView, viewRecord, lesson: getLesson, capabilities, persistence } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  const proposal = persistence.lessonProposals.findLast((proposal) => proposal.state === 'pending' && proposal.unitId === unit?.id)
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
        <EmptyTitle>{t('lesson.unitUnavailable')}</EmptyTitle>
        <EmptyDescription>{t('lesson.chooseUnit')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => setView('route')}>{t('lesson.backToPath')}</Button>
      </EmptyContent>
    </Empty>
  )
  const lesson = ready ? getLesson(unit) : null
  const location = (() => {
    for (const [si, st] of space.stages.entries()) {
      const ui = st.units.findIndex((u) => u.id === unit.id)
      if (ui !== -1) return t('lesson.location', { stage: si + 1, title: st.title, unit: ui + 1 })
    }
    return ''
  })()
  const lastRecord = [...space.records].reverse().find((r) => r.unitId === unit.id)

  if (proposal) return <LessonProposalPreview key={proposal.id} proposal={proposal} inDrawer={inDrawer} />

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
            <h1 className="text-balance text-4xl font-semibold tracking-tight">{lesson?.title ?? unit.title}</h1>
            <StatusPill status={unit.status} />
          </div>
          {unit.historicalPass && unit.status !== 'passed' && <p className="text-sm leading-relaxed text-muted-foreground" data-testid="lesson-historical-pass">{unit.status === 'needs_work' ? t('lesson.historicalNeedsWork') : t('lesson.historicalUnassessed')}</p>}
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Target className="size-3.5" aria-hidden />
              {t('lesson.goals')}
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
          <Alert aria-label={t('lesson.advice')} className="border-accent-foreground/25 bg-accent/50">
            <RotateCcw className="text-accent-foreground" />
            <AlertTitle className="text-accent-foreground">{t('lesson.lastAdvice')}</AlertTitle>
            {lastRecord && (
              <AlertAction>
                <Button variant="outline" size="xs" onClick={() => viewRecord(lastRecord.id)}>
                  {t('lesson.viewResults')}
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
                      onClick={() => { setQuote({ source: 'advice', label: t('common:quotes.advice'), caption: { kind: 'advice' }, text: a }); onAsk?.() }}
                    >
                      {t('controls.ask')}
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
            title={t('lesson.generating')}
            steps={[t('lesson.analyzeUnit'), t('lesson.generateContent'), t('lesson.organizeContent'), t('lesson.save')]}
            parts={persistence.taskParts[persistence.tasks.findLast((t) => t.unitId === unit.id && t.kind === 'lesson')?.id ?? ''] ?? []}
            context={<RunContext runId={persistence.tasks.findLast((t) => t.unitId === unit.id && t.kind === 'lesson')?.id} />}
            note={t('lesson.generationNote')}
          />
        )}

        {unit.contentState === 'failed' && (
          <Empty className="border border-destructive/30 bg-destructive/5">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
                <AlertTriangle />
              </EmptyMedia>
              <EmptyTitle>{t('lesson.failed')}</EmptyTitle>
              <EmptyDescription>
                {capabilities.agent
                  ? t('lesson.failedHint')
                  : t('lesson.unavailableFailedHint')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button disabled={!capabilities.agent || persistence.busy || !!pendingDecision(persistence)} onClick={() => retryGeneration(unit.id)}>
                <RotateCcw data-icon="inline-start" />
                {t('controls.regenerate')}
              </Button>
              <Button variant="outline" onClick={() => setView('route')}>
                {t('lesson.backToPath')}
              </Button>
            </EmptyContent>
          </Empty>
        )}

        {!lesson && unit.contentState !== 'failed' && (unit.contentState !== 'generating' || !capabilities.agent) && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t('lesson.unavailable')}</EmptyTitle>
              <EmptyDescription>{t('lesson.unavailableHint')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {capabilities.agent && <Button disabled={persistence.busy || !!pendingDecision(persistence)} onClick={() => retryGeneration(unit.id)}>{t('lesson.generate')}</Button>}
              <Button variant="outline" onClick={() => setView('route')}>{t('lesson.backToPath')}</Button>
            </EmptyContent>
          </Empty>
        )}

        {lesson && (
          <>
            {lesson.intro && <p className="border-l-2 border-primary pl-4 text-lg leading-relaxed text-muted-foreground">{lesson.intro}</p>}
            {lesson.content !== undefined ? <LessonText text={lesson.content} enhanced inDrawer={inDrawer} onAsk={onAsk} /> : lesson.blocks.map((b, i) => (
              <Block key={i} block={b} />
            ))}
            <footer className="mt-6 flex flex-col gap-2 border-t pt-6 text-sm text-muted-foreground">
              <p>{capabilities.assessment
                ? t('lesson.assessmentHint')
                : t('lesson.assessmentUnavailable')}</p>
            </footer>
          </>
        )}
      </article>

      {pop && (
        <Button
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuote({ source: 'lesson', label: t('common:quotes.lesson', { title: unit.title }), caption: { kind: 'lesson', name: unit.title }, text: pop.text })
            window.getSelection()?.removeAllRanges()
            setPop(null)
            onAsk?.()
          }}
          style={{ left: pop.x, top: pop.y - 8 }}
          className="fixed z-30 -translate-x-1/2 -translate-y-full rounded-full shadow-lg"
        >
          <MessageSquareQuote data-icon="inline-start" />
          {t('controls.askAgent')}
        </Button>
      )}
    </div>
  )
}

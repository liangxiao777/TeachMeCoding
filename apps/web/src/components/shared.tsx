'use client'

import { Check, CircleDashed, CircleDot, RotateCcw, SkipForward } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'
import { RunContent } from '@/components/agent/run-content'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { UnitStatus } from '@/app/types'

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground shadow-sm',
        className,
      )}
    >
      {'>_'}
    </span>
  )
}

export function Brand({ onClick }: { onClick?: () => void }) {
  const inner = (
    <>
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight">TeachMeCoding</span>
    </>
  )
  if (!onClick) return <div className="flex items-center gap-2">{inner}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted"
      aria-label="返回首页"
    >
      {inner}
    </button>
  )
}

export function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 1)
          return (
            <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
              {p.slice(1, -1)}
            </code>
          )
        if (p.startsWith('**') && p.endsWith('**'))
          return (
            <strong key={i} className="font-semibold">
              {p.slice(2, -2)}
            </strong>
          )
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}

export function RichText({
  text,
  renderCode,
  components,
}: {
  text: string
  renderCode?: (code: string, lang: string) => ReactNode
  components?: MessageResponseProps['components']
}) {
  return (
    <MessageResponse mode="static" parseIncompleteMarkdown={false} controls={false}
      className="h-auto min-w-0 max-w-full space-y-3 break-words leading-relaxed"
      components={{
        p: ({ children }) => <p>{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>,
        pre: ({ node }) => {
          const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
          const value = code?.type === 'element' ? code.children.filter((child) => child.type === 'text').map((child) => child.value).join('') : ''
          const classes = code?.type === 'element' ? code.properties.className : undefined
          const language = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-'))?.toString().slice(9) ?? '' : ''
          return renderCode ? renderCode(value.replace(/\n$/, ''), language) : (
            <pre className="overflow-x-auto rounded-md bg-ide p-3 font-mono text-xs leading-relaxed text-ide-foreground">{value}</pre>
          )
        },
        ...components,
      }}
    >{text}</MessageResponse>
  )
}

export function Generating({
  title,
  steps,
  note,
  className,
  parts,
}: {
  title: string
  steps: string[]
  note?: string
  className?: string
  /** Omit only for the simulated preview; real work advances on durable events. */
  parts?: AgentDisplayPart[]
}) {
  const [simulated, setActive] = useState(0)
  const tool = parts?.findLast((p) => p.type === 'tool')
  const submitting = tool?.name.startsWith('submit_')
  const recordedStep = parts === undefined ? undefined : submitting && tool?.status === 'done' ? 3
    : submitting && tool?.status === 'running' ? 2 : tool ? 1 : 0
  const active = recordedStep ?? simulated
  useEffect(() => {
    if (recordedStep !== undefined) return
    const t = setInterval(() => setActive((a) => Math.min(a + 1, steps.length - 1)), 750)
    return () => clearInterval(t)
  }, [steps.length, recordedStep])
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-col gap-5', className)}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Spinner />
        </span>
        <p className="text-base font-semibold tracking-tight">{title}</p>
      </div>
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>执行进度</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
        {steps.map((s, i) => (
          <ChainOfThoughtStep key={s} label={s} status={i < active ? 'complete' : i === active ? 'active' : 'pending'}
            icon={i < active ? Check : i === active ? CircleDot : CircleDashed} />
        ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
      {parts !== undefined && <RunContent parts={parts} streaming />}
      {note && <p className="text-sm leading-relaxed text-muted-foreground">{note}</p>}
    </div>
  )
}

const STATUS_META: Record<
  UnitStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline'; className?: string }
> = {
  not_started: { label: '尚未开始', variant: 'outline' },
  learning: { label: '正在学习', variant: 'secondary', className: 'text-primary' },
  needs_work: { label: '建议加强', variant: 'secondary', className: 'bg-accent text-accent-foreground' },
  passed: { label: '已通过', variant: 'default' },
  skipped: { label: '已跳过', variant: 'secondary' },
}

export function StatusPill({ status, className }: { status: UnitStatus; className?: string }) {
  const m = STATUS_META[status]
  return (
    <Badge variant={m.variant} className={cn(m.className, className)}>
      {m.label}
    </Badge>
  )
}

export function StatusIcon({ status }: { status: UnitStatus }) {
  const base = 'flex size-7 shrink-0 items-center justify-center rounded-full border'
  if (status === 'passed')
    return (
      <span className={cn(base, 'border-primary bg-primary text-primary-foreground')}>
        <Check className="size-4" aria-hidden />
      </span>
    )
  if (status === 'learning')
    return (
      <span className={cn(base, 'border-primary bg-card text-primary')}>
        <CircleDot className="size-4" aria-hidden />
      </span>
    )
  if (status === 'needs_work')
    return (
      <span className={cn(base, 'border-accent-foreground/30 bg-accent text-accent-foreground')}>
        <RotateCcw className="size-3.5" aria-hidden />
      </span>
    )
  if (status === 'skipped')
    return (
      <span className={cn(base, 'border-border bg-muted text-muted-foreground')}>
        <SkipForward className="size-3.5" aria-hidden />
      </span>
    )
  return <span className={cn(base, 'border-dashed border-input bg-card')} aria-hidden />
}

export function isComposing(e: React.KeyboardEvent) {
  return e.nativeEvent.isComposing || e.keyCode === 229
}

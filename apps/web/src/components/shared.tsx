'use client'

import { Check, CircleDashed, CircleDot, RotateCcw, SkipForward } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { RunContent } from '@/components/agent/run-content'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
  streaming,
  renderCode,
}: {
  text: string
  streaming?: boolean
  renderCode?: (code: string, lang: string) => ReactNode
}) {
  const segments = text.split(/```(\w*)\n([\s\S]*?)(?:```|$)/g)
  const nodes: ReactNode[] = []
  for (let i = 0; i < segments.length; i += 3) {
    const prose = segments[i]
    if (prose) {
      prose
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .forEach((para, j) => {
          const lines = para.split('\n')
          const isList = lines.every((l) => /^\d+\.\s/.test(l.trim()))
          nodes.push(
            isList ? (
              <ol key={`p${i}-${j}`} className="flex list-decimal flex-col gap-1 pl-5">
                {lines.map((l, k) => (
                  <li key={k}>
                    <InlineText text={l.replace(/^\d+\.\s/, '')} />
                  </li>
                ))}
              </ol>
            ) : (
              <p key={`p${i}-${j}`}>
                <InlineText text={para} />
              </p>
            ),
          )
        })
    }
    const lang = segments[i + 1] ?? ''
    const code = segments[i + 2]
    if (code !== undefined) {
      nodes.push(
        <div key={`c${i}`}>
          {renderCode ? (
            renderCode(code.replace(/\n$/, ''), lang)
          ) : (
            <pre className="overflow-x-auto rounded-md bg-ide p-3 font-mono text-xs leading-relaxed text-ide-foreground">
              {code}
            </pre>
          )}
        </div>,
      )
    }
  }
  return (
    <div className="flex flex-col gap-3 leading-relaxed">
      {nodes}
      {streaming && <span className="stream-caret text-muted-foreground" aria-hidden />}
    </div>
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
  const recordedStep = parts === undefined ? undefined : tool?.status === 'done' ? 3
    : tool?.status === 'running' ? 2 : tool ? 1 : 0
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
      <div className="flex flex-col gap-2" aria-hidden>
        {[92, 78, 85, 60].map((w, i) => (
          <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
        ))}
      </div>
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

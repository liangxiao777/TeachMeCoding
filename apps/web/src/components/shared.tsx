'use client'

import { Check, CircleDashed, CircleDot, RotateCcw, SkipForward } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { defaultComponents } from 'streamdown'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'
import { RunContent } from '@/components/agent/run-content'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { UnitStatus } from '@/app/types'

export { Brand, BrandMark } from '@/components/brand'

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
  renderMermaid = false,
  components,
  ...markdownProps
}: {
  text: string
  renderCode?: (code: string, lang: string, meta: string) => ReactNode
  renderMermaid?: boolean
  components?: MessageResponseProps['components']
} & Pick<MessageResponseProps, 'plugins' | 'mermaid' | 'remarkPlugins' | 'allowedTags' | 'normalizeHtmlIndentation'>) {
  return (
    <MessageResponse mode="static" parseIncompleteMarkdown={false} controls={false}
      {...markdownProps}
      className="h-auto min-w-0 max-w-full space-y-3 break-words leading-relaxed [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1"
      components={{
        p: ({ children }) => <p>{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>,
        pre: ({ node }) => {
          const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
          const value = code?.type === 'element' ? code.children.filter((child) => child.type === 'text').map((child) => child.value).join('') : ''
          const classes = code?.type === 'element' ? code.properties.className : undefined
          const language = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-'))?.toString().slice(9) ?? '' : ''
          const meta = code?.type === 'element' && typeof code.properties.metastring === 'string' ? code.properties.metastring : ''
          if (renderMermaid && language === 'mermaid' && code?.type === 'element') {
            const MarkdownCode = defaultComponents.code
            return <MarkdownCode node={code} className="language-mermaid" data-block="true">{value}</MarkdownCode>
          }
          return renderCode ? renderCode(value.replace(/\n$/, ''), language, meta) : (
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
  context,
}: {
  title: string
  steps: string[]
  note?: string
  className?: string
  /** Progress advances only on durable run events. */
  parts: AgentDisplayPart[]
  context?: ReactNode
}) {
  const { t } = useTranslation('learning')
  const tool = parts.findLast((p) => p.type === 'tool')
  const submitting = tool?.name.startsWith('submit_')
  const active = submitting && tool?.status === 'done' ? 3
    : submitting && tool?.status === 'running' ? 2 : tool ? 1 : 0
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-col gap-5', className)}>
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Spinner />
        </span>
        <p className="min-w-0 flex-1 text-base font-semibold tracking-tight">{title}</p>
        {context}
      </div>
      <ChainOfThought defaultOpen>
        <ChainOfThoughtHeader>{t('progress')}</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
        {steps.map((s, i) => (
          <ChainOfThoughtStep key={s} label={s} status={i < active ? 'complete' : i === active ? 'active' : 'pending'}
            icon={i < active ? Check : i === active ? CircleDot : CircleDashed} />
        ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
      <RunContent parts={parts} streaming />
      {note && <p className="text-sm leading-relaxed text-muted-foreground">{note}</p>}
    </div>
  )
}

const STATUS_META: Record<
  UnitStatus,
  { variant: 'default' | 'secondary' | 'outline'; className?: string }
> = {
  not_started: { variant: 'outline' },
  learning: { variant: 'secondary', className: 'text-primary' },
  needs_work: { variant: 'secondary', className: 'bg-accent text-accent-foreground' },
  passed: { variant: 'default' },
  skipped: { variant: 'secondary' },
}

export function StatusPill({ status, className }: { status: UnitStatus; className?: string }) {
  const { t } = useTranslation('learning')
  const m = STATUS_META[status]
  return (
    <Badge variant={m.variant} className={cn(m.className, className)}>
      {t(`status.${status}`)}
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

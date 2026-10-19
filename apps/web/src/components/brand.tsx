'use client'

import { cn } from '@/lib/utils'

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

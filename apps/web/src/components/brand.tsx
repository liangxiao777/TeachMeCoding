'use client'

import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// 96 网格：底座圆角 96/φ³；气泡宽 96/φ；提示符高 22.66、> 宽 14、间距与笔画 5.35、_ 长 22.66。
// 与 public/icon.svg 保持同一份几何。
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 96 96"
      className={cn('size-7 shrink-0 rounded-[23.6%] shadow-sm', className)}
    >
      <rect width="96" height="96" rx="22.66" className="fill-primary" />
      <path
        className="fill-primary-foreground"
        d="M36.33 20H59.67A18 18 0 0 1 77.67 38V50A18 18 0 0 1 59.67 68H34L18.33 76V38A18 18 0 0 1 36.33 20Z"
      />
      <path
        d="M29.68 35.34 38.33 44 29.68 52.66"
        fill="none"
        className="stroke-primary"
        strokeWidth="5.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="46.35" y="49.98" width="22.66" height="5.35" rx="2.675" className="fill-primary" />
    </svg>
  )
}

export function Brand({ onClick }: { onClick?: () => void }) {
  const { t } = useTranslation('home')
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
      aria-label={t('backHome')}
    >
      {inner}
    </button>
  )
}

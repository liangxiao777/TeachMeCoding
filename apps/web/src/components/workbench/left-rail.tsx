'use client'

import { Hash } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatRelativeTime } from '@/i18n/format'
import { ProjectTree } from '@/components/workbench/project-tree'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { findUnit } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { lessonHeadings } from '@/lib/lesson-markdown'
import { cn } from '@/lib/utils'

function RailEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="mx-2 rounded-md border border-dashed px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

const railItem =
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

export function LeftRail() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { viewRecord, lesson: getLesson, persistence } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  const reviewing = persistence.lessonProposals.some((proposal) => proposal.state === 'pending' && proposal.unitId === unit?.id)
  const lesson = unit && unit.contentState === 'ready' ? getLesson(unit) : null
  const content = lesson?.content, blocks = content === undefined ? lesson?.blocks : undefined
  const headings = useMemo(() => content !== undefined ? lessonHeadings(content)
    : blocks?.flatMap((b) => (b.type === 'h2' ? [b] : [])) ?? [], [content, blocks])
  const records = [...space.records].reverse()

  return (
    <aside className="h-full min-w-0 bg-sidebar" aria-label={t('rail.materials')}>
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-3 p-2">
          <details open className={cn((space.ideFullscreen || reviewing) && 'hidden')}>
            <summary className="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground">{t('rail.contents')}</summary>
            {headings.length ? (
              <ul className="flex flex-col">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      className={railItem}
                    >
                      <Hash className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                      <span className="truncate">{h.text}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <RailEmpty>{t('rail.noContents')}</RailEmpty>
            )}
          </details>

          {!space.ideFullscreen && !reviewing && <Separator />}
          <ProjectTree />
          {!space.ideFullscreen && <Separator />}

          <details className={cn(space.ideFullscreen && 'hidden')}>
            <summary className="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground">
              {t('rail.records')} <span className="ml-1 opacity-60">{formatNumber(records.length)}</span>
            </summary>
            {records.length ? (
              <ul className="flex flex-col gap-0.5">
                {records.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => viewRecord(r.id)}
                      className={cn(railItem, 'flex-col items-stretch gap-1')}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-sidebar-foreground">{r.unitTitle}</span>
                        <Badge
                          variant={r.result === 'pass' ? 'default' : 'secondary'}
                          className={cn(r.result !== 'pass' && 'bg-accent text-accent-foreground')}
                        >
                          {r.result === 'unverified' ? t('rail.unverified') : r.result === 'pass' ? r.valid === false ? t('rail.historicalPass') : t('rail.pass') : r.valid === false ? t('rail.historicalNeedsWork') : t('rail.needsWork')}
                        </Badge>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('rail.attempt', { number: r.attempt, time: formatRelativeTime(r.createdAt) })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <RailEmpty>{t('rail.noRecords')}</RailEmpty>
            )}
          </details>
        </div>
      </ScrollArea>
    </aside>
  )
}

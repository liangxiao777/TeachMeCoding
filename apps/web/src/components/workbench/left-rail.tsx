'use client'

import { Hash } from 'lucide-react'
import { ProjectTree } from '@/components/workbench/project-tree'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { findUnit, relativeTime } from '@/fixtures/demo-data'
import { getLesson } from '@/fixtures/lessons'
import { useApp, useSpace } from '@/fixtures/store'
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
  const space = useSpace()
  const { viewRecord } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  const lesson =
    unit && unit.contentState === 'ready' ? getLesson(unit, space.kind === 'pytorch' ? 'python' : 'rust') : null
  const headings = lesson?.blocks.flatMap((b) => (b.type === 'h2' ? [b] : [])) ?? []
  const records = [...space.records].reverse()

  return (
    <aside className="h-full min-w-0 bg-sidebar" aria-label="单元材料">
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-3 p-2">
          <details open className={cn(space.ideFullscreen && 'hidden')}>
            <summary className="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground">本单元目录</summary>
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
              <RailEmpty>课件生成后显示目录</RailEmpty>
            )}
          </details>

          {!space.ideFullscreen && <Separator />}
          <ProjectTree />
          {!space.ideFullscreen && <Separator />}

          <details className={cn(space.ideFullscreen && 'hidden')}>
            <summary className="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground">
              测评记录 <span className="ml-1 opacity-60">{records.length}</span>
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
                          {r.result === 'pass' ? '通过' : '加强'}
                        </Badge>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        第 {r.attempt} 次 · {relativeTime(r.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <RailEmpty>完成单元测评后显示在这里</RailEmpty>
            )}
          </details>
        </div>
      </ScrollArea>
    </aside>
  )
}

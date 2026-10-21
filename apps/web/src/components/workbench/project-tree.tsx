'use client'

import {
  ChevronRight,
  ChevronsDownUp,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNotice, notice, type NoticeValue } from '@/i18n/notice'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { isComposing } from '@/components/shared'
import { entryPath, projectChildren } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'

type Edit = { parentId: string | null; kind: 'file' | 'directory'; id?: string }

export function ProjectTree() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { openFile, selectEntry, toggleDirectory, collapseDirectories, createEntry, renameEntry, persistence } = useApp()
  const [edit, setEdit] = useState<Edit | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<NoticeValue>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const tree = useRef<HTMLDivElement>(null)
  const selected = [...space.directories, ...space.files].find((e) => e.id === space.selectedEntryId)
  const parentId = space.directories.some((d) => d.id === selected?.id) ? selected!.id : (selected?.parentId ?? null)

  function start(kind: Edit['kind'], parent: string | null, id?: string) {
    if (submittingRef.current) return
    setEdit({ kind, parentId: parent, id })
    setName(id ? [...space.files, ...space.directories].find((e) => e.id === id)!.name : '')
    setError(null)
    if (parent) toggleDirectory(parent, true)
  }

  async function submit() {
    if (!edit || submittingRef.current) return
    if (persistence && (!persistence.ready || persistence.busy)) {
      setError(notice('workbench', 'project.busy'))
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      const failure = await (edit.id ? renameEntry(edit.id, name) : createEntry(name, edit.kind, edit.parentId))
      setError(failure)
      if (!failure) setEdit(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause : notice('workbench', 'project.saveFailed'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const editor = (depth: number) => (
    <form
      style={{ paddingLeft: 12 + depth * 16 }}
      className="py-1 pr-2"
      aria-busy={submitting || undefined}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        autoFocus
        aria-label={edit?.id ? t('project.rename') : edit?.kind === 'directory' ? t('project.folderName') : t('project.fileName')}
        value={name}
        readOnly={submitting}
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
        onFocus={(e) => e.target.select()}
        aria-invalid={!!error}
        aria-describedby={error ? 'project-name-error' : undefined}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isComposing(e)) {
            if (e.key === 'Enter') e.preventDefault()
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            if (!submittingRef.current) setEdit(null)
          }
        }}
        placeholder={edit?.kind === 'directory' ? 'folder' : space.kind === 'pytorch' ? 'example.py' : 'example.rs'}
        className="h-7 w-full min-w-0 rounded-sm border border-ring bg-background px-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      {!!error && (
        <p id="project-name-error" role="alert" className="mt-1 text-xs text-destructive">
          {formatNotice(error)}
        </p>
      )}
    </form>
  )

  function children(parent: string | null, depth: number): React.ReactNode {
    return (
      <>
        {projectChildren(space, parent).map((entry) => {
          const folder = entry.kind === 'directory'
          const expanded = folder && space.expandedDirectoryIds.includes(entry.id)
          const Icon = folder ? (expanded ? FolderOpen : Folder) : entry.language === 'text' ? FileText : FileCode2
          return (
            <div key={entry.id} role="none">
              {edit?.id === entry.id ? (
                editor(depth)
              ) : (
                <div
                  role="treeitem"
                  aria-label={entry.name}
                  aria-level={depth + 1}
                  aria-expanded={folder ? expanded : undefined}
                  aria-selected={space.selectedEntryId === entry.id}
                  aria-owns={expanded ? `project-group-${entry.id}` : undefined}
                  data-entry-id={entry.id}
                  tabIndex={
                    space.selectedEntryId === entry.id ||
                    (!space.selectedEntryId && depth === 0 && projectChildren(space, parent)[0]?.id === entry.id)
                      ? 0
                      : -1
                  }
                  title={entryPath(space, entry.id)}
                  style={{ paddingLeft: 8 + depth * 16 }}
                  className={cn(
                    'group flex h-8 cursor-default items-center gap-1.5 rounded-sm pr-1 text-xs outline-none hover:bg-sidebar-accent/70 focus-visible:ring-1 focus-visible:ring-ring',
                    space.selectedEntryId === entry.id && 'bg-sidebar-accent text-sidebar-accent-foreground',
                  )}
                  onClick={() => {
                    selectEntry(entry.id)
                    if (folder) toggleDirectory(entry.id)
                    else openFile(entry.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    const rows = Array.from(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
                    const index = rows.indexOf(e.currentTarget)
                    let target: HTMLElement | undefined
                    if (e.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)]
                    if (e.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)]
                    if (e.key === 'Home') target = rows[0]
                    if (e.key === 'End') target = rows.at(-1)
                    if (e.key === 'ArrowRight' && folder) {
                      if (!expanded) toggleDirectory(entry.id, true)
                      else target = rows[index + 1]
                    }
                    if (e.key === 'ArrowLeft') {
                      if (expanded) toggleDirectory(entry.id, false)
                      else target = rows.find((row) => row.dataset.entryId === entry.parentId)
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                      if (folder) toggleDirectory(entry.id)
                      else openFile(entry.id)
                    }
                    if (e.key === 'F2') start(entry.kind, entry.parentId, entry.id)
                    if (
                      ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'F2'].includes(
                        e.key,
                      )
                    )
                      e.preventDefault()
                    if (target) {
                      selectEntry(target.dataset.entryId!)
                      target.focus()
                    }
                  }}
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground transition-transform',
                      !folder && 'invisible',
                      expanded && 'rotate-90',
                    )}
                  />
                  <Icon
                    aria-hidden
                    className={cn('size-3.5 shrink-0', folder ? 'text-muted-foreground' : 'text-primary/80')}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('project.actions', { name: entry.name })}
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className={cn(space.ideFullscreen && 'dark')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {folder && (
                        <>
                          <DropdownMenuItem onClick={() => start('file', entry.id)}>
                            <FilePlus2 />
                            {t('project.newFile')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => start('directory', entry.id)}>
                            <FolderPlus />
                            {t('project.newFolder')}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuItem onClick={() => start(entry.kind, entry.parentId, entry.id)}>
                        <Pencil />
                        {t('project.rename')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              {expanded && (
                <div id={`project-group-${entry.id}`} role="group" className="relative">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 w-px bg-border/60"
                    style={{ left: 14 + depth * 16 }}
                  />
                  {children(entry.id, depth + 1)}
                </div>
              )}
            </div>
          )
        })}
        {edit && !edit.id && edit.parentId === parent && editor(depth)}
      </>
    )
  }

  return (
    <section aria-label={t('project.title')} className="min-w-0">
      <div className="mb-1 flex h-8 items-center gap-1 px-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-xs font-medium text-muted-foreground"
          onClick={() => selectEntry(null)}
          title={t('project.selectRoot')}
        >
          {t('project.title')}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('project.newFile')}
          title={t('project.newFileHint')}
          onClick={() => start('file', parentId)}
        >
          <FilePlus2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('project.newFolder')}
          title={t('project.newFolderHint')}
          onClick={() => start('directory', parentId)}
        >
          <FolderPlus />
        </Button>
        {persistence && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('project.refresh')}
            title={t('project.refresh')}
            disabled={!persistence.ready || persistence.busy || submitting}
            onClick={persistence.refreshFiles}
          >
            <RefreshCw />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('project.collapse')}
          disabled={submitting}
          onClick={() => {
            setEdit(null)
            collapseDirectories()
          }}
        >
          <ChevronsDownUp />
        </Button>
      </div>
      <div ref={tree} role="tree" aria-label={t('project.tree')}>
        {children(null, 0)}
      </div>
      {!space.files.length && !space.directories.length && !edit && (
        <p className="px-3 py-4 text-xs leading-5 text-muted-foreground">
          {t('project.empty')}
        </p>
      )}
    </section>
  )
}

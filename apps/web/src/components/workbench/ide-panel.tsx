'use client'

import { FileCode2, Maximize2, MessageSquareQuote, Minimize2, PlugZap, Plus, TerminalSquare, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNotice } from '@/i18n/notice'
import { usePanelRef } from 'react-resizable-panels'
import { CodeEditor, type EditorPosition } from '@/components/code-editor'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { entryPath } from '@/app/selectors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { LocalTerminalView } from './local-terminal'

export { CodeEditor } from '@/components/code-editor'

function EnvChip() {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { connectEnv, capabilities } = useApp()
  if (!capabilities.terminal)
    return (
      <Badge variant="outline" role="status" className="gap-1.5 font-normal text-muted-foreground">
        {t('ide.terminalUnavailable')}
      </Badge>
    )
  if (space.env === 'connected')
    return (
      <Badge variant="outline" title={space.envLabel} className="gap-1.5 font-normal text-muted-foreground">
        <span className="size-1.5 rounded-full bg-[oklch(0.78_0.15_150)]" aria-hidden />
        <span className={cn(!space.ideFullscreen && 'max-w-36 truncate')}>{space.envLabel}</span>
      </Badge>
    )
  if (space.env !== 'lost')
    return (
      <Badge variant="outline" role="status" className="gap-1.5 font-normal text-muted-foreground">
        <Spinner />
        {t('ide.connecting')}
      </Badge>
    )
  return (
    <Button variant="destructive" size="xs" onClick={connectEnv}>
      <PlugZap data-icon="inline-start" />
      {t('ide.reconnect')}
    </Button>
  )
}

export function IdePanel() {
  const { t } = useTranslation(['workbench', 'common'])
  const space = useSpace()
  const {
    openFile,
    closeFile,
    updateFile,
    toggleIde,
    setQuote,
    createFile,
    setIdeFullscreen,
    connectEnv,
    capabilities,
    persistence,
    localTerminal,
  } = useApp()
  const [selected, setSelected] = useState('')
  const activeTab = useRef<HTMLButtonElement>(null)
  const file = space.files.find((f) => f.id === space.activeFileId)
  const positions = useRef(new Map<string, EditorPosition>())
  if (file && !positions.current.has(file.id)) positions.current.set(file.id, { start: 0, end: 0, top: 0, left: 0 })
  const terminal = usePanelRef()
  const terminalSizes = useRef({ normal: 42, full: 28 })
  useEffect(() => {
    if (capabilities.terminal && space.ideOpen && space.env === 'disconnected') connectEnv()
  }, [capabilities.terminal, space.ideOpen, space.env, connectEnv])
  useLayoutEffect(() => {
    terminal.current?.resize(`${space.ideFullscreen ? terminalSizes.current.full : terminalSizes.current.normal}%`)
  }, [space.ideFullscreen, terminal])
  useEffect(() => {
    const pos = file ? positions.current.get(file.id) : undefined
    setSelected(pos && file ? file.content.slice(pos.start, pos.end) : '')
  }, [file?.id])
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [space.activeFileId, space.ideFullscreen, space.agentOpen])

  const askCode = () => {
    if (!file) return
    const text = selected.trim() || file.content
    const name = entryPath(space, file.id)
    setQuote({ source: 'code', label: `${name}${selected.trim() ? t('common:quotes.selectionSuffix') : ''}`,
      caption: { kind: selected.trim() ? 'selection' : 'file', name }, text })
  }

  return (
    <section
      aria-label={t('ide.title')}
      className={cn(
        'dark @container flex h-full min-h-0 flex-col overflow-hidden bg-ide text-ide-foreground',
        !space.ideFullscreen && 'border-t pt-2',
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={t('ide.openFiles')}>
          {space.openFileIds
            .flatMap((id) => {
              const open = space.files.find((f) => f.id === id)
              return open ? [open] : []
            })
            .map((f) => {
              const active = f.id === space.activeFileId
              return (
                <div
                  key={f.id}
                  className={cn('group flex shrink-0 items-center border-r pr-1', active && 'bg-secondary')}
                >
                  <Button
                    ref={active ? activeTab : undefined}
                    role="tab"
                    aria-selected={active}
                    title={entryPath(space, f.id)}
                    variant={active ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => openFile(f.id)}
                    className={cn('shrink-0 font-mono text-xs font-normal', !active && 'text-muted-foreground')}
                  >
                    <FileCode2 data-icon="inline-start" />
                    {f.name}
                    {space.openFileIds.some(
                      (id) => id !== f.id && space.files.find((other) => other.id === id)?.name === f.name,
                    ) && (
                      <span className="text-[10px] text-muted-foreground">{entryPath(space, f.parentId) || '/'}</span>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('ide.closeFile', { path: entryPath(space, f.id) })}
                    onClick={() => closeFile(f.id)}
                    className={cn(!active && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}
                  >
                    <X />
                  </Button>
                </div>
              )
            })}
        </div>
        {!space.ideFullscreen && <EnvChip />}
        {file && (
          <span role="status" title={formatNotice(persistence.fileSaveError) || undefined} className="shrink-0 text-[10px] text-muted-foreground">
            {persistence.fileSaveError ? t('ide.saveFailed') : persistence.fileDirty ? t('ide.saving') : t('ide.saved')}
          </span>
        )}
        <Separator orientation="vertical" className="h-5" />
        {file && (
          <Button
            variant="ghost"
            size="sm"
            onClick={askCode}
            aria-label={selected.trim() ? t('ide.askSelection') : t('ide.askFile')}
            title={selected.trim() ? t('ide.askSelection') : t('ide.askFile')}
          >
            <MessageSquareQuote data-icon="inline-start" />
            <span className="hidden @min-[900px]:inline">{selected.trim() ? t('ide.askSelection') : t('ide.askFile')}</span>
          </Button>
        )}
        {/* Fullscreen is left where it was entered. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={space.ideFullscreen ? t('ide.exitFullscreen') : t('ide.fullscreen')}
          title={space.ideFullscreen ? t('ide.exitFullscreen') : t('ide.fullscreen')}
          onClick={() => setIdeFullscreen(!space.ideFullscreen)}
        >
          {space.ideFullscreen ? <Minimize2 /> : <Maximize2 />}
        </Button>
        {!space.ideFullscreen && (
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" onClick={() => toggleIde(false)} aria-label={t('ide.collapse')} />}
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>{t('ide.collapse')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {space.ideFullscreen && file && (
        <div className="flex h-7 shrink-0 items-center border-b px-4 font-mono text-xs text-muted-foreground">
          {entryPath(space, file.id).split('/').join('  /  ')}
        </div>
      )}
      <ResizablePanelGroup
        orientation={space.ideFullscreen ? 'vertical' : 'horizontal'}
        className="min-h-0 flex-1"
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) terminalSizes.current[space.ideFullscreen ? 'full' : 'normal'] = layout.terminal!
        }}
      >
        <ResizablePanel id="editor" minSize="30%" className="flex min-h-0 flex-col">
          {file ? (
            <CodeEditor
              key={file.id}
              className="flex-1"
              label={t('ide.editFile', { name: file.name })}
              filename={file.name}
              value={file.content}
              disabled={persistence.fileRenaming}
              position={positions.current.get(file.id)}
              onChange={(v) => updateFile(file.id, v)}
              onSelectText={setSelected}
            />
          ) : (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileCode2 />
                </EmptyMedia>
                <EmptyTitle>{t('ide.empty')}</EmptyTitle>
                <EmptyDescription>{t('ide.emptyHint')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!persistence.ready || persistence.busy}
                  onClick={() => createFile(space.kind === 'pytorch' ? 'scratch.py' : 'scratch.rs')}
                >
                  <Plus data-icon="inline-start" />
                  {t('ide.newFile')}
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </ResizablePanel>
        <ResizableHandle aria-label={t('ide.resizeTerminal')} />
        <ResizablePanel
          id="terminal"
          panelRef={terminal}
          defaultSize="42%"
          minSize="20%"
          maxSize="65%"
          className="flex min-h-0 min-w-0 flex-col"
        >
          {/* A terminal client exists only once the local service reports terminal support. */}
          {localTerminal ? (space.ideOpen ? <LocalTerminalView /> : null) : <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <TerminalSquare className="size-3.5" aria-hidden />
              {t('ide.terminal')}
              <span className="font-normal opacity-60">{t('ide.notConnected')}</span>
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-xs" aria-label={t('ide.quoteTerminal')} title={t('ide.quoteHint')} disabled>
                <MessageSquareQuote />
              </Button>
              <Button variant="ghost" size="icon-xs" disabled aria-label={t('ide.clearTerminal')}>
                <Trash2 />
              </Button>
            </div>
          </div>
          <div
            aria-label={t('ide.terminalContent')}
            className="min-h-0 flex-1 cursor-text overflow-y-auto px-3 py-2 font-mono text-[13px] leading-5"
          >
            <div role="log" aria-label={t('ide.terminalOutput')} />
            <p role="status" className="mb-3 text-muted-foreground">{t('ide.unavailableHint')}</p>
            <form className="flex items-center gap-2">
              <span className="shrink-0 text-ide-foreground/60" aria-hidden>$</span>
              <input
                aria-label={t('ide.terminalCommand')}
                disabled
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-5 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-inherit caret-ide-foreground outline-none"
              />
            </form>
          </div>
          </>}
        </ResizablePanel>
      </ResizablePanelGroup>
      {space.ideFullscreen && (
        <footer className="flex h-8 shrink-0 items-center justify-between border-t bg-sidebar px-3 text-xs text-muted-foreground">
          <EnvChip />
          <span>
            {file?.language === 'text' ? t('ide.plainText') : file?.language === 'python' ? 'Python' : 'Rust'} · UTF-8{' '}
            <span className="ml-4 opacity-60">{t('ide.escape')}</span>
          </span>
        </footer>
      )}
    </section>
  )
}

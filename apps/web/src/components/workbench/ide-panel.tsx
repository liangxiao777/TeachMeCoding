'use client'

import { FileCode2, Maximize2, MessageSquareQuote, PlugZap, Plus, RefreshCw, Save, TerminalSquare, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { CodeEditor, type EditorPosition } from '@/components/code-editor'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { entryPath } from '@/app/selectors'
import { isComposing } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import type { TermLine } from '@/app/types'
import { LocalTerminalView } from './local-terminal'

export { CodeEditor } from '@/components/code-editor'

export function TermOutput({ lines, onAsk }: { lines: TermLine[]; onAsk?: (text: string) => void }) {
  const groups: [TermLine, ...TermLine[]][] = []
  for (const l of lines) {
    const last = groups[groups.length - 1]
    if (last && last[0].runId === l.runId) last.push(l)
    else groups.push([l])
  }
  return (
    <>
      {groups.map((g) => {
        const errs = g.filter((l) => l.kind === 'err')
        return (
          <div key={g[0].id} className="flex flex-col">
            {g.map((l) => (
              <div
                key={l.id}
                className={cn(
                  'whitespace-pre-wrap break-words',
                  l.kind === 'cmd' && 'text-ide-foreground',
                  l.kind === 'out' && 'text-ide-foreground/85',
                  l.kind === 'err' && 'text-[oklch(0.78_0.13_30)]',
                  l.kind === 'info' && 'text-ide-foreground/45',
                )}
              >
                {l.kind === 'cmd' ? (
                  <>
                    <span className="text-ide-foreground/60">$ </span>
                    {l.text}
                  </>
                ) : (
                  l.text
                )}
              </div>
            ))}
            {onAsk && errs.length > 0 && (
              <Button
                variant="secondary"
                size="xs"
                className="my-1.5 w-fit font-sans"
                onClick={() => onAsk(errs.map((l) => l.text).join('\n'))}
              >
                <MessageSquareQuote data-icon="inline-start" />
                把这段报错发给 Agent
              </Button>
            )}
          </div>
        )
      })}
    </>
  )
}

function EnvChip() {
  const space = useSpace()
  const { connectEnv, capabilities } = useApp()
  if (!capabilities.terminal)
    return (
      <Badge variant="outline" role="status" className="gap-1.5 font-normal text-muted-foreground">
        终端尚未接入
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
        正在连接环境…
      </Badge>
    )
  return (
    <Button variant="destructive" size="xs" onClick={connectEnv}>
      <PlugZap data-icon="inline-start" />
      连接已断开 · 重新连接
    </Button>
  )
}

export function IdePanel() {
  const space = useSpace()
  const {
    openFile,
    closeFile,
    updateFile,
    toggleIde,
    setQuote,
    terminalCommand,
    createFile,
    setIdeFullscreen,
    connectEnv,
    capabilities,
    persistence,
    localTerminal,
  } = useApp()
  const [selected, setSelected] = useState('')
  const [terminalSelection, setTerminalSelection] = useState('')
  const [cmd, setCmd] = useState('')
  const history = useRef<string[]>([])
  const historyIndex = useRef(0)
  const draft = useRef('')
  const termInput = useRef<HTMLInputElement>(null)
  const termEnd = useRef<HTMLDivElement>(null)
  const activeTab = useRef<HTMLButtonElement>(null)
  const file = space.files.find((f) => f.id === space.activeFileId)
  const disk = file && persistence?.disk?.path === entryPath(space, file.id) ? persistence.disk : null
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

  useEffect(() => {
    termEnd.current?.scrollIntoView({ block: 'end' })
  }, [space.terminal, space.running])

  const askCode = () => {
    if (!file) return
    const text = selected.trim() || file.content
    setQuote({ source: 'code', label: `${entryPath(space, file.id)}${selected.trim() ? ' · 选中代码' : ''}`, text })
  }

  return (
    <section
      aria-label="IDE 与终端"
      className={cn(
        'dark @container flex h-full min-h-0 flex-col overflow-hidden bg-ide text-ide-foreground',
        !space.ideFullscreen && 'border-t pt-2',
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="打开的文件">
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
                    aria-label={`关闭 ${entryPath(space, f.id)}`}
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
        {persistence && (
          <>
            {file && (
              <span role="status" className="shrink-0 text-[10px] text-muted-foreground">
                {persistence.fileDirty ? '未保存' : '已保存'}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="保存文件"
              title="保存文件"
              disabled={!persistence.ready || persistence.busy || !file || !persistence.fileDirty}
              onClick={persistence.saveFile}
            >
              <Save />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="读取磁盘版本"
              title="读取磁盘版本"
              disabled={!persistence.ready || persistence.busy || !file}
              onClick={persistence.compareFile}
            >
              <RefreshCw />
            </Button>
          </>
        )}
        <Separator orientation="vertical" className="h-5" />
        {file && (
          <Button
            variant="ghost"
            size="sm"
            onClick={askCode}
            aria-label={selected.trim() ? '询问选中代码' : '询问这个文件'}
            title={selected.trim() ? '询问选中代码' : '询问这个文件'}
          >
            <MessageSquareQuote data-icon="inline-start" />
            <span className="hidden @min-[900px]:inline">{selected.trim() ? '询问选中代码' : '询问这个文件'}</span>
          </Button>
        )}
        {!space.ideFullscreen && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="全屏 IDE"
            title="全屏 IDE"
            onClick={() => setIdeFullscreen(true)}
          >
            <Maximize2 />
          </Button>
        )}
        {!space.ideFullscreen && (
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" onClick={() => toggleIde(false)} aria-label="收起 IDE" />}
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>收起 IDE</TooltipContent>
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
        <ResizablePanel id="editor" minSize="30%" className={cn('flex min-h-0 flex-col', disk && 'flex-row')}>
          {file ? (
            <CodeEditor
              key={file.id}
              className="flex-1"
              label={`编辑 ${file.name}`}
              value={file.content}
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
                <EmptyTitle>还没有打开的练习文件</EmptyTitle>
                <EmptyDescription>新建一个文件，边学边写</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={persistence && (!persistence.ready || persistence.busy)}
                  onClick={() => createFile(space.kind === 'pytorch' ? 'scratch.py' : 'scratch.rs')}
                >
                  <Plus data-icon="inline-start" />
                  新建练习文件
                </Button>
              </EmptyContent>
            </Empty>
          )}
          {disk && persistence && (
            <section aria-label="磁盘版本比较" className="flex w-1/2 min-w-0 flex-col gap-3 overflow-auto border-l p-3">
              <h3 className="text-xs font-medium text-muted-foreground">磁盘版本（左侧为本地编辑）</h3>
              <pre className="flex-1 whitespace-pre-wrap break-words font-mono text-xs">{disk.content}</pre>
              <Button
                size="sm"
                variant="outline"
                className="h-auto whitespace-normal py-2"
                disabled={!persistence.ready || persistence.busy}
                onClick={() => persistence.resolveFile(true)}
              >
                保留编辑，基于此版本继续
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto whitespace-normal py-2"
                disabled={!persistence.ready || persistence.busy}
                onClick={() => persistence.resolveFile(false)}
              >
                放弃编辑，采用磁盘内容
              </Button>
            </section>
          )}
        </ResizablePanel>
        <ResizableHandle aria-label="调整终端大小" />
        <ResizablePanel
          id="terminal"
          panelRef={terminal}
          defaultSize="42%"
          minSize="20%"
          maxSize="65%"
          className="flex min-h-0 min-w-0 flex-col"
        >
          {localTerminal ? (space.ideOpen ? <LocalTerminalView /> : null) : <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <TerminalSquare className="size-3.5" aria-hidden />
              终端
              <span className="font-normal opacity-60">{!capabilities.terminal ? '· 尚未接入' : persistence ? '' : '· 原型模拟'}</span>
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="引用终端输出"
                title="引用选中内容或最近一次输出"
                disabled={!space.terminal.length}
                onClick={() =>
                  setQuote({
                    source: 'terminal',
                    label: '终端输出',
                    text:
                      terminalSelection ||
                      space.terminal
                        .filter((l) => l.runId === space.terminal.at(-1)?.runId)
                        .map((l) => l.text)
                        .join('\n'),
                  })
                }
              >
                <MessageSquareQuote />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!capabilities.terminal}
                onClick={() => {
                  terminalCommand('clear')
                  setTerminalSelection('')
                }}
                aria-label="清空终端"
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <div
            aria-label="终端内容"
            className="min-h-0 flex-1 cursor-text overflow-y-auto px-3 py-2 font-mono text-[13px] leading-5"
            onMouseUp={() => setTerminalSelection(window.getSelection()?.toString() ?? '')}
            onClick={() => {
              if (!window.getSelection()?.toString()) termInput.current?.focus()
            }}
          >
            <div role="log" aria-label="终端输出">
              <TermOutput lines={space.terminal} />
            </div>
            {!capabilities.terminal && (
              <p role="status" className="mb-3 text-muted-foreground">终端与代码运行尚未接入，不会连接模拟环境或执行命令。</p>
            )}
            {!space.running && (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const command = cmd.trim()
                  if (!capabilities.terminal || !command) return
                  if (history.current.at(-1) !== command) history.current.push(command)
                  historyIndex.current = history.current.length
                  draft.current = ''
                  setTerminalSelection('')
                  terminalCommand(command)
                  setCmd('')
                }}
                className="flex items-center gap-2"
              >
                <span className="shrink-0 text-ide-foreground/60" aria-hidden>
                  {entryPath(space, space.terminalDirectoryId)
                    ? `/${entryPath(space, space.terminalDirectoryId)} $`
                    : '$'}
                </span>
                <input
                  ref={termInput}
                  aria-label="终端命令"
                  disabled={!capabilities.terminal}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={cmd}
                  onChange={(e) => {
                    setCmd(e.target.value)
                    historyIndex.current = history.current.length
                    draft.current = e.target.value
                  }}
                  onKeyDown={(e) => {
                    if (!capabilities.terminal) return
                    if (isComposing(e)) {
                      if (e.key === 'Enter') e.preventDefault()
                      return
                    }
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      const next = Math.max(
                        0,
                        Math.min(history.current.length, historyIndex.current + (e.key === 'ArrowUp' ? -1 : 1)),
                      )
                      historyIndex.current = next
                      const value = history.current[next] ?? draft.current
                      setCmd(value)
                      requestAnimationFrame(() => termInput.current?.setSelectionRange(value.length, value.length))
                    }
                    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
                      e.preventDefault()
                      terminalCommand('clear')
                      setTerminalSelection('')
                    }
                  }}
                  className="h-5 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-inherit caret-ide-foreground outline-none"
                />
              </form>
            )}
            <div ref={termEnd} />
          </div>
          </>}
        </ResizablePanel>
      </ResizablePanelGroup>
      {space.ideFullscreen && (
        <footer className="flex h-8 shrink-0 items-center justify-between border-t bg-sidebar px-3 text-xs text-muted-foreground">
          <EnvChip />
          <span>
            {file?.language === 'text' ? 'Plain Text' : file?.language === 'python' ? 'Python' : 'Rust'} · UTF-8{' '}
            <span className="ml-4 opacity-60">Esc 返回学习</span>
          </span>
        </footer>
      )}
    </section>
  )
}

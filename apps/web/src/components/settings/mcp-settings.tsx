import { useEffect, useRef, useState } from 'react'
import { ChevronRight, MoreHorizontal, Pencil, Plug, Plus, RotateCw, Trash2 } from 'lucide-react'
import type { McpServerEntry, McpSettings } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { McpServerDialog } from './mcp-server-dialog'

const stateLabels = { disabled: '已停用', connecting: '连接中', connected: '已连接', failed: '连接失败' }
const serverPath = (name: string) => `/settings/mcp/servers/${encodeURIComponent(name)}`

export function McpSettingsForm({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<McpSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<McpServerEntry | 'new' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const revision = useRef(0)
  const addButton = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = () => returnFocus.current?.isConnected ? returnFocus.current : addButton.current
  const load = async () => {
    const current = revision.current
    try {
      const next = await api<McpSettings>('/settings/mcp')
      if (current === revision.current) { setSettings(next); setError('') }
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取 MCP 设置。') }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!active || !settings?.servers.some((server) => server.state !== 'disabled')) return
    let disposed = false, pending = false
    const interval = setInterval(async () => {
      if (pending) return
      pending = true
      const current = revision.current
      try {
        const next = await api<McpSettings>('/settings/mcp')
        if (!disposed && current === revision.current) setSettings(next)
      } catch { /* Explicit actions report errors; polling never discards a configuration draft. */ }
      finally { pending = false }
    }, 1500)
    return () => { disposed = true; clearInterval(interval) }
  }, [active, !!settings?.servers.some((server) => server.state !== 'disabled')])
  const write = async (path: string, input: unknown) => {
    revision.current++; setBusy(true); setError('')
    try {
      setSettings(await api<McpSettings>(path, input))
    } finally { revision.current++; setBusy(false) }
  }
  const act = (path: string, input: unknown) => {
    void write(path, input).catch((error) => setError(error instanceof Error ? error.message : '操作失败，请重试。'))
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2"><h2 className="text-2xl font-semibold tracking-tight">MCP</h2>
          <p className="text-sm text-muted-foreground">连接外部工具，让 Agent 按需调用。</p></div>
        <Button ref={addButton} disabled={!settings || busy} onClick={(event) => { returnFocus.current = event.currentTarget; setEditor('new') }}>
          <Plus data-icon="inline-start" />添加 MCP Server</Button>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}{!settings && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}</AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm"><Spinner /> 正在读取 MCP 设置…</div> : <>
        {!settings.servers.length ? <Empty className="border py-16"><EmptyHeader><EmptyMedia variant="icon"><Plug /></EmptyMedia>
          <EmptyTitle>尚未配置 MCP 服务器。</EmptyTitle></EmptyHeader></Empty> :
          <ItemGroup aria-label="MCP 服务器" className="gap-0! overflow-hidden rounded-xl border">
            {settings.servers.map((server) => {
              const config = settings.configuration.mcpServers[server.name]!
              const enabled = config.enabled !== false
              return <Collapsible key={server.name} className="not-last:border-b">
                <Item role="listitem" aria-label={server.name} className="flex-nowrap rounded-none border-0 p-4 sm:p-5">
                  <ItemMedia variant="icon" className="hidden size-10 rounded-lg bg-muted sm:flex"><Plug className="size-5" /></ItemMedia>
                  <ItemContent className="min-w-0 gap-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                      <ItemTitle className="line-clamp-none min-w-0 break-all"><h3>{server.name}</h3></ItemTitle>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn('size-1.5 rounded-full bg-muted-foreground/50', server.state === 'connected' && 'bg-emerald-500', server.state === 'failed' && 'bg-destructive')} />
                        {stateLabels[server.state]}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{config.url ? 'Streamable HTTP' : 'stdio'}</span>
                      {server.state === 'connected' && <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="h-auto px-1 text-xs text-muted-foreground" />}>
                        {server.tools.length} 个工具<ChevronRight className="size-3" />
                      </CollapsibleTrigger>}
                    </div>
                    {server.error && <p role="alert" className="break-words text-xs text-destructive">{server.error}</p>}
                  </ItemContent>
                  <ItemActions className="shrink-0 gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" disabled={busy} aria-label={`配置 ${server.name}`}
                        onPointerDownCapture={(event) => { returnFocus.current = event.currentTarget }}
                        onFocusCapture={(event) => { returnFocus.current = event.currentTarget }} />}><MoreHorizontal /></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditor({ name: server.name, configuration: config })}><Pencil />编辑</DropdownMenuItem>
                        <DropdownMenuItem disabled={!enabled} onClick={() => act(`${serverPath(server.name)}/reconnect`, {})}><RotateCw />重新连接</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => { setDeleteError(''); setDeleting(server.name) }}><Trash2 />删除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Switch aria-label={`启用 ${server.name}`} checked={enabled} disabled={busy}
                      onCheckedChange={(value) => act(serverPath(server.name), { name: server.name, configuration: { ...config, enabled: value } })} />
                  </ItemActions>
                </Item>
                {server.state === 'connected' && <CollapsibleContent className="border-t bg-muted/20 p-4 sm:pl-20">
                  <ul className="flex flex-col gap-3">{server.tools.map((tool) => <li key={tool.agentName} className="min-w-0">
                    <p className="break-all font-mono text-xs">{tool.name}</p><p className="mt-1 break-words text-xs text-muted-foreground">{tool.description}</p>
                  </li>)}</ul>
                </CollapsibleContent>}
              </Collapsible>
            })}
          </ItemGroup>}
      </>}
      {editor && <McpServerDialog entry={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)}
        finalFocus={restoreFocus} onSave={(next) => write(editor === 'new' ? '/settings/mcp/servers' : serverPath(editor.name), next)} />}
      {deleting && <Dialog open onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }}>
        <DialogContent showCloseButton={!busy} finalFocus={restoreFocus}>
          <DialogHeader><DialogTitle>删除 {deleting}？</DialogTitle>
            <DialogDescription>删除后将断开连接并移除这项配置。</DialogDescription></DialogHeader>
          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="destructive" disabled={busy} onClick={() => {
              void write(`${serverPath(deleting)}/delete`, {}).then(() => setDeleting(null))
                .catch((error) => setDeleteError(error instanceof Error ? error.message : '无法删除服务器。'))
            }}>{busy && <Spinner />}删除服务器</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>}
    </div>
  )
}

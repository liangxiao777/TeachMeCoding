import { useState } from 'react'
import { ChevronRight, Plus, X } from 'lucide-react'
import { mcpConfigurationSchema, mcpServerEntrySchema, type McpServerConfiguration, type McpServerEntry } from '@teach-me-coding/contracts'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

type Values = [string, string][]

function ConnectionValues({ label, rows, onChange }: { label: string; rows: Values; onChange: (rows: Values) => void }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {rows.map(([key, value], index) => <div key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2">
        <Input aria-label={`${label}名称 ${index + 1}`} placeholder="名称" value={key}
          onChange={(e) => onChange(rows.map((row, at) => at === index ? [e.target.value, row[1]] : row))} />
        <Input aria-label={`${label}值 ${index + 1}`} placeholder="值" type="password" autoComplete="off" value={value}
          onChange={(e) => onChange(rows.map((row, at) => at === index ? [row[0], e.target.value] : row))} />
        <Button type="button" variant="ghost" size="icon" aria-label={`删除${label} ${index + 1}`}
          onClick={() => onChange(rows.filter((_, at) => at !== index))}><X /></Button>
      </div>)}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...rows, ['', '']])}>
        <Plus />添加{label}
      </Button>
      <FieldDescription className="text-xs">支持 {'${变量名}'}；保留 •••••••• 即保留已有值。</FieldDescription>
    </Field>
  )
}

function values(rows: Values, label: string) {
  const entries = rows.filter(([key, value]) => key || value)
  if (entries.some(([key]) => !key.trim())) throw new Error(`请填写${label}名称。`)
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error(`${label}名称不能重复。`)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseEntry(name: string, raw: unknown): McpServerEntry {
  if (raw && typeof raw === 'object' && 'mcpServers' in raw) {
    const configuration = mcpConfigurationSchema.safeParse(raw)
    if (!configuration.success) throw new Error('MCP 配置无效，请检查服务器名称、连接方式和字段。')
    const entries = Object.entries(configuration.data.mcpServers)
    if (entries.length !== 1) throw new Error('请一次添加一个 MCP Server，配置中只能包含一个服务器。')
    return { name: entries[0]![0], configuration: entries[0]![1] }
  }
  const entry = mcpServerEntrySchema.safeParse({ name: name.trim(), configuration: raw })
  if (!entry.success) {
    const path = entry.error.issues[0]!.path
    if (path[0] === 'name') throw new Error('服务器名称只能包含字母、数字、下划线和连字符，且不能为空。')
    if (path.includes('url')) throw new Error('请填写有效的 HTTP 或 HTTPS 地址。')
    if (path.includes('timeout')) throw new Error('超时必须是大于 0 的秒数。')
    throw new Error('配置无效：请填写 stdio 的启动命令，或 HTTP 的服务器地址，不要混用两种连接字段。')
  }
  return entry.data
}

export function McpServerDialog({ entry, onClose, onSave, finalFocus }: {
  entry?: McpServerEntry; onClose: () => void; onSave: (entry: McpServerEntry) => Promise<void>; finalFocus: () => HTMLElement | null
}) {
  const initial = entry?.configuration ?? { command: '', enabled: true }
  const [name, setName] = useState(entry?.name ?? '')
  const [transport, setTransport] = useState(initial.url ? 'http' : 'stdio')
  const [command, setCommand] = useState(initial.command ?? '')
  const [args, setArgs] = useState(initial.args ?? [])
  const [url, setUrl] = useState(initial.url ?? '')
  const [cwd, setCwd] = useState(initial.cwd ?? '')
  const [env, setEnv] = useState<Values>(Object.entries(initial.env ?? {}))
  const [headers, setHeaders] = useState<Values>(Object.entries(initial.headers ?? {}))
  const [timeout, setTimeout] = useState(initial.timeout?.toString() ?? '')
  const [enabled, setEnabled] = useState(initial.enabled !== false)
  const [mode, setMode] = useState('form')
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const configuration = (): McpServerConfiguration => ({
    ...(transport === 'http' ? { type: initial.url ? initial.type : 'http', url: url.trim(), headers: values(headers, '请求头') }
      : { type: 'stdio', command: command.trim(), args, ...(cwd.trim() ? { cwd: cwd.trim() } : {}), env: values(env, '环境变量') }),
    ...(timeout ? { timeout: Number(timeout) } : {}), enabled,
  })
  const load = (next: McpServerEntry) => {
    const config = next.configuration
    setName(next.name); setTransport(config.url ? 'http' : 'stdio'); setCommand(config.command ?? ''); setArgs(config.args ?? [])
    setUrl(config.url ?? ''); setCwd(config.cwd ?? ''); setEnv(Object.entries(config.env ?? {})); setHeaders(Object.entries(config.headers ?? {}))
    setTimeout(config.timeout?.toString() ?? ''); setEnabled(config.enabled !== false)
  }
  const changeMode = (next: string) => {
    try {
      if (next === 'json') setJson(JSON.stringify(configuration(), null, 2))
      else if (json !== JSON.stringify(configuration(), null, 2)) load(parseEntry(name, JSON.parse(json)))
      setMode(next); setError('')
    } catch (error) { setError(error instanceof SyntaxError ? '配置不是有效 JSON，请检查后再保存。' : (error as Error).message) }
  }
  const save = async () => {
    setError('')
    try {
      const next = parseEntry(name, mode === 'json' ? JSON.parse(json) : configuration())
      setBusy(true)
      await onSave(next)
      onClose()
    } catch (error) { setError(error instanceof SyntaxError ? '配置不是有效 JSON，请检查后再保存。' : error instanceof Error ? error.message : '无法保存 MCP Server。') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent showCloseButton={!busy} finalFocus={finalFocus} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b p-5 pr-12">
          <DialogTitle>{entry ? '编辑 MCP Server' : '添加 MCP Server'}</DialogTitle>
          <DialogDescription className="sr-only">配置一个服务器的连接方式和参数。</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <div className="min-h-0 flex-1 overflow-y-auto"><fieldset disabled={busy} className="min-w-0 p-5">
            <FieldGroup>
              <Tabs value={mode} onValueChange={(value) => changeMode(String(value))} className="gap-5">
                <TabsList aria-label="配置方式"><TabsTrigger value="form">表单</TabsTrigger><TabsTrigger value="json">JSON</TabsTrigger></TabsList>
                <Field>
                  <FieldLabel htmlFor="mcp-server-name">服务器名称</FieldLabel>
                  <Input id="mcp-server-name" placeholder="例如 filesystem" value={name} autoComplete="off" aria-required
                    onChange={(e) => setName(e.target.value)} />
                </Field>
                <TabsContent value="form" className="flex flex-col gap-5">
                  <Tabs value={transport} onValueChange={(value) => setTransport(String(value))} className="gap-5">
                    <Field>
                      <FieldLabel>连接方式</FieldLabel>
                      <TabsList aria-label="连接方式" className="w-full">
                        <TabsTrigger value="stdio">本地进程（stdio）</TabsTrigger><TabsTrigger value="http">远程地址（HTTP）</TabsTrigger>
                      </TabsList>
                    </Field>
                    <TabsContent value="stdio" className="flex flex-col gap-5">
                      <Field><FieldLabel htmlFor="mcp-command">启动命令</FieldLabel>
                        <Input id="mcp-command" placeholder="npx" value={command} aria-required onChange={(e) => setCommand(e.target.value)} /></Field>
                      <Field><FieldLabel htmlFor="mcp-args">启动参数</FieldLabel>
                        <Textarea id="mcp-args" value={args.join('\n')} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/projects'} spellCheck={false}
                          className="min-h-24 font-mono text-xs!" onChange={(e) => setArgs(e.target.value ? e.target.value.split('\n') : [])} />
                        <FieldDescription className="text-xs">每行一个参数。</FieldDescription></Field>
                    </TabsContent>
                    <TabsContent value="http" className="flex flex-col gap-5">
                      <Field><FieldLabel htmlFor="mcp-url">服务器地址</FieldLabel>
                        <Input id="mcp-url" placeholder="https://example.com/mcp" value={url} aria-required onChange={(e) => setUrl(e.target.value)} /></Field>
                      <ConnectionValues label="请求头" rows={headers} onChange={setHeaders} />
                    </TabsContent>
                  </Tabs>
                  <Collapsible open={advanced} onOpenChange={setAdvanced} className="rounded-lg border">
                    <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium">
                      <ChevronRight className={`size-4 transition-transform ${advanced ? 'rotate-90' : ''}`} />高级配置
                      <span className="ml-auto text-xs font-normal text-muted-foreground">{transport === 'stdio' ? '环境变量、目录、超时' : '超时'}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-3 pb-3">
                      <FieldGroup>
                        {transport === 'stdio' && <>
                          <Field><FieldLabel htmlFor="mcp-cwd">工作目录</FieldLabel><Input id="mcp-cwd" value={cwd} placeholder="留空使用默认目录" onChange={(e) => setCwd(e.target.value)} /></Field>
                          <ConnectionValues label="环境变量" rows={env} onChange={setEnv} />
                        </>}
                        <Field><FieldLabel htmlFor="mcp-timeout">请求超时（秒）</FieldLabel>
                          <Input id="mcp-timeout" type="number" min="0" step="any" placeholder="60" value={timeout} onChange={(e) => setTimeout(e.target.value)} /></Field>
                      </FieldGroup>
                    </CollapsibleContent>
                  </Collapsible>
                  <Field orientation="horizontal"><FieldLabel htmlFor="mcp-enabled">{entry ? '启用服务器' : '添加后启用'}</FieldLabel>
                    <Switch id="mcp-enabled" checked={enabled} onCheckedChange={setEnabled} /></Field>
                </TabsContent>
                <TabsContent value="json">
                  <Field><FieldLabel htmlFor="mcp-server-json">服务器配置 JSON</FieldLabel>
                    <Textarea id="mcp-server-json" className="min-h-64 font-mono text-xs!" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
                    <FieldDescription className="text-xs">支持单个服务器配置，或仅包含一个服务器的 mcpServers 配置。</FieldDescription>
                  </Field>
                </TabsContent>
              </Tabs>
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            </FieldGroup>
          </fieldset></div>
          <DialogFooter className="m-0 shrink-0 flex-row bg-muted/30 px-5 py-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy}>{busy && <Spinner />}{entry ? '保存修改' : '添加服务器'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import type { McpSettings } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'

const stateLabels = { disabled: '已停用', connecting: '连接中', connected: '已连接', failed: '连接失败' }
const format = (value: McpSettings['configuration']) => JSON.stringify(value, null, 2)

export function McpSettingsForm({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<McpSettings | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const next = await api<McpSettings>('/settings/mcp')
      setSettings(next); setText(format(next.configuration)); setError('')
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取 MCP 设置。') }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!active || !settings?.servers.some((server) => server.state !== 'disabled')) return
    let disposed = false, pending = false
    const interval = setInterval(async () => {
      if (pending) return
      pending = true
      try {
        const next = await api<McpSettings>('/settings/mcp')
        if (!disposed) setSettings((previous) => previous ? { ...previous, servers: next.servers } : next)
      } catch { /* A user action reports connection/read failures without discarding unsaved config. */ }
      finally { pending = false }
    }, 1500)
    return () => { disposed = true; clearInterval(interval) }
  }, [active, !!settings?.servers.some((server) => server.state !== 'disabled')])
  const dirty = !!settings && text !== format(settings.configuration)
  const write = async (configuration?: McpSettings['configuration']) => {
    setBusy(true); setError('')
    try {
      const next = await api<McpSettings>('/settings/mcp', configuration ?? JSON.parse(text))
      setSettings(next); setText(format(next.configuration))
    } catch (error) { setError(error instanceof SyntaxError ? '配置不是有效 JSON，请检查后再保存。' : error instanceof Error ? error.message : '无法保存 MCP 配置。') }
    finally { setBusy(false) }
  }
  const reconnect = async () => {
    setBusy(true); setError('')
    try { setSettings(await api<McpSettings>('/settings/mcp/reconnect', {})) }
    catch (error) { setError(error instanceof Error ? error.message : '无法重新连接。') }
    finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-6">
      {error && <Alert variant="destructive"><AlertDescription>{error}{!settings && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}</AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm"><Spinner /> 正在读取 MCP 设置…</div> : <>
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><CardTitle>服务器</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void reconnect()} disabled={busy || !settings.servers.length}>重新连接</Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!settings.servers.length && <p className="text-sm text-muted-foreground">尚未配置 MCP 服务器。</p>}
            {settings.servers.map((server) => <div key={server.name} className="min-w-0 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 break-all text-sm font-medium">{server.name}</h3>
                <Badge variant={server.state === 'failed' ? 'destructive' : 'secondary'}>{stateLabels[server.state]}</Badge>
                <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || dirty}
                  aria-label={`${server.state === 'disabled' ? '启用' : '停用'} ${server.name}`}
                  onClick={() => void write({ mcpServers: { ...settings.configuration.mcpServers,
                    [server.name]: { ...settings.configuration.mcpServers[server.name]!, enabled: server.state === 'disabled' } } })}>
                  {server.state === 'disabled' ? '启用' : '停用'}
                </Button>
              </div>
              {server.error && <p role="alert" className="mt-2 text-sm text-destructive">{server.error}</p>}
              {server.state === 'connected' && <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">{server.tools.length} 个工具</summary>
                <ul className="mt-3 flex flex-col gap-3">{server.tools.map((tool) => <li key={tool.agentName} className="min-w-0">
                  <p className="break-all font-mono text-xs">{tool.name}</p><p className="mt-1 break-words text-xs text-muted-foreground">{tool.description}</p>
                </li>)}</ul>
              </details>}
            </div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>连接配置</CardTitle></CardHeader>
          <CardContent>
            <Field>
              <FieldLabel htmlFor="mcp-config">MCP 配置 JSON</FieldLabel>
              <Textarea id="mcp-config" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
                disabled={busy} className="min-h-64 font-mono text-xs!" />
              <FieldDescription>支持 stdio 和 Streamable HTTP。保存后连接已启用服务器，工具可由教学 Agent 直接调用。</FieldDescription>
              <FieldDescription>env / headers 支持 {'${变量名}'}；已存的认证值显示为 ••••••••，保持不变即保留。</FieldDescription>
            </Field>
            <details className="mt-4 text-sm text-muted-foreground">
              <summary className="cursor-pointer">配置示例</summary>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify({ mcpServers: {
                local: { command: 'node', args: ['/absolute/path/server.js'], enabled: true },
                remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' }, enabled: false },
              } }, null, 2)}</pre>
            </details>
          </CardContent>
          <CardFooter><Button disabled={busy || !dirty} onClick={() => void write()}>{busy && <Spinner />}保存 MCP 配置</Button></CardFooter>
        </Card>
      </>}
    </div>
  )
}

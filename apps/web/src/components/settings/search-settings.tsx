import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SearchProvider, SearchSettings, WebSearchResponse } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'

export function SearchSettingsForm({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<SearchSettings | null>(null)
  const [provider, setProvider] = useState<SearchProvider>('brave')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'toggle' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<WebSearchResponse | null>(null)
  const requested = useRef(false)
  const load = async () => {
    setError('')
    try {
      const next = await api<SearchSettings>('/settings/search')
      setSettings(next); setProvider(next.provider)
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取搜索设置。') }
  }
  useEffect(() => {
    if (active && !requested.current) { requested.current = true; void load() }
  }, [active])

  const current = settings?.providers.find((entry) => entry.id === provider)
  const saved = settings?.providers.find((entry) => entry.id === settings.provider)
  const dirty = !!settings && (provider !== settings.provider || !!apiKey.trim())
  const write = async (action: 'save' | 'toggle', input: unknown) => {
    setBusy(action); setError(''); setResult(null)
    try {
      const next = await api<SearchSettings>('/settings/search', input)
      setSettings(next)
      if (action === 'save') { setProvider(next.provider); setApiKey('') }
    } catch (error) { setError(error instanceof Error ? error.message : '无法保存搜索设置。') }
    finally { setBusy(null) }
  }
  const test = async () => {
    setBusy('test'); setError(''); setResult(null)
    try { setResult(await api<WebSearchResponse>('/settings/search/test', { query: 'Rust 官方文档', count: 5 })) }
    catch (error) { setError(error instanceof Error ? error.message : '测试搜索失败，请重试。') }
    finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">搜索服务</h2>
        <p className="text-sm text-muted-foreground">为 Agent 提供网络搜索，独立于教学模型。</p>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}
        {!settings && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}
      </AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> 正在读取搜索设置…</div> : <>
        <Card>
          <CardContent className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="search-enabled" className="font-medium">启用搜索服务</label>
              <p className="text-sm text-muted-foreground">关闭后保留配置，停用此搜索工具。</p>
            </div>
            <Switch id="search-enabled" checked={settings.enabled} disabled={!!busy}
              onCheckedChange={(enabled) => void write('toggle', { enabled })} />
          </CardContent>
        </Card>
        {settings.enabled && !saved?.configured && <Alert><AlertDescription>搜索已启用，但当前服务尚未配置凭据。请先保存 API Key。</AlertDescription></Alert>}
        <Card>
          <CardHeader><CardTitle><h3>服务配置</h3></CardTitle></CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="search-provider">搜索服务商</FieldLabel>
                <Select value={provider} disabled={!!busy} onValueChange={(value) => {
                  if (value && value !== provider) { setProvider(value as SearchProvider); setApiKey(''); setResult(null); setError('') }
                }}>
                  <SelectTrigger id="search-provider" className="w-full"><SelectValue>{current?.name}</SelectValue></SelectTrigger>
                  <SelectContent>{settings.providers.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldLabel htmlFor="search-api-key">API Key</FieldLabel>
                  <Badge variant={current?.configured ? 'secondary' : 'outline'} className="font-normal text-muted-foreground">
                    {current?.configured === 'saved' ? '已保存凭据' : current?.configured === 'environment' ? '使用服务端环境凭据' : '未配置凭据'}
                  </Badge>
                  {current && <a href={current.apiKeyUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    获取 API Key<ExternalLink className="size-3" />
                  </a>}
                </div>
                <Input id="search-api-key" type="password" autoComplete="new-password" value={apiKey} disabled={!!busy}
                  placeholder={current?.configured ? '留空保留已配置的凭据' : '输入 API Key'}
                  onChange={(event) => { setApiKey(event.target.value); setResult(null) }} />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col items-start gap-3">
            <div className="flex flex-wrap gap-2">
              <Button disabled={!!busy || !dirty} onClick={() => void write('save', { provider, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })}>
                {busy === 'save' && <Spinner />}保存配置
              </Button>
              <Button variant="outline" disabled={!!busy || dirty || !saved?.configured} onClick={() => void test()}>
                {busy === 'test' && <Spinner />}测试搜索
              </Button>
            </div>
            {dirty && <p className="text-xs text-muted-foreground">请先保存配置再测试。</p>}
          </CardFooter>
        </Card>
        {result && <Card role="status" aria-live="polite">
          <CardHeader>
            <CardTitle><h3>测试完成</h3></CardTitle>
            <CardDescription>{settings.providers.find((entry) => entry.id === result.provider)?.name} · {result.results.length} 条结果 · {result.tookMs} ms</CardDescription>
          </CardHeader>
          <CardContent>
            {!result.results.length ? <p className="text-sm text-muted-foreground">服务已响应，但没有找到匹配的结果。</p> :
              <ol className="flex flex-col gap-4">{result.results.map((entry, index) => <li key={`${index}:${entry.url}`} className="min-w-0">
                <a href={entry.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1.5 font-medium underline underline-offset-4 break-words">
                  <span className="min-w-0">{entry.title}</span><ExternalLink className="mt-0.5 size-3 shrink-0" />
                </a>
                <p className="mt-1 break-all text-xs text-muted-foreground">{entry.url}</p>
                {entry.snippet && <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{entry.snippet}</p>}
              </li>)}</ol>}
          </CardContent>
        </Card>}
      </>}
    </div>
  )
}

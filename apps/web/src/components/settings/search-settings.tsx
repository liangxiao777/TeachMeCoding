import { ExternalLink, LogIn, LogOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoginSession, SearchProvider, SearchSettings, WebSearchResponse } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { useApp } from '@/app/context'
import { LoginFlow } from './model-settings'
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
  const { refreshCapabilities } = useApp()
  const [settings, setSettings] = useState<SearchSettings | null>(null)
  const [provider, setProvider] = useState<SearchProvider>('brave')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [region, setRegion] = useState<'global' | 'cn' | ''>('')
  const [busy, setBusy] = useState<'save' | 'toggle' | 'test' | 'logout' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<WebSearchResponse | null>(null)
  const [login, setLogin] = useState<LoginSession | null>(null)
  const [startingLogin, setStartingLogin] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [refreshingAuth, setRefreshingAuth] = useState(false)
  const [cancellingLogin, setCancellingLogin] = useState(false)
  const loginRef = useRef<LoginSession | null>(null)
  const loginGeneration = useRef(0)
  const startingRef = useRef(false)
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const updateLogin = useCallback((session: LoginSession | null) => {
    loginRef.current = session
    setLogin(session)
  }, [])
  const stopPoll = useCallback(() => {
    clearTimeout(poll.current)
    poll.current = undefined
  }, [])
  const requested = useRef(false)
  const load = async () => {
    setError('')
    try {
      const next = await api<SearchSettings>('/settings/search')
      setSettings(next); setProvider(next.provider)
      const selected = next.providers.find((entry) => entry.id === next.provider)
      setModel(selected?.model ?? ''); setRegion(selected?.region ?? '')
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取搜索设置。') }
  }
  useEffect(() => {
    if (active && !requested.current) { requested.current = true; void load() }
    else if (active) {
      const generation = loginGeneration.current
      void refreshAuth(generation).catch((error: unknown) => {
        if (generation === loginGeneration.current) setError(error instanceof Error ? error.message : '无法读取搜索设置。')
      })
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    return () => {
      loginGeneration.current++
      stopPoll()
      const current = loginRef.current
      updateLogin(null)
      setAnswering(false); setCancellingLogin(false)
      if (current?.state === 'running') void api(`/settings/login/${current.id}/cancel`, {}).catch(() => {})
    }
  }, [active, provider, stopPoll, updateLogin])

  const current = settings?.providers.find((entry) => entry.id === provider)
  const saved = settings?.providers.find((entry) => entry.id === settings.provider)
  const loggingIn = startingLogin || login?.state === 'running'
  const blocked = !!busy || loggingIn || answering || refreshingAuth
  const dirty = !!settings && (provider !== settings.provider || !!apiKey.trim()
    || current?.model !== undefined && model !== current.model
    || current?.region !== undefined && region !== current.region)
  // Auth refreshes only replace saved metadata, never the search form's drafts.
  const refreshAuth = async (generation: number) => {
    setRefreshingAuth(true)
    try {
      const next = await api<SearchSettings>('/settings/search')
      if (generation !== loginGeneration.current) return
      setSettings(next)
      refreshCapabilities?.()
    } finally { setRefreshingAuth(false) }
  }
  const acceptLogin = async (session: LoginSession, generation: number) => {
    if (generation !== loginGeneration.current) return
    updateLogin(session)
    if (session.state !== 'running') {
      stopPoll(); setCancellingLogin(false)
      if (session.state === 'succeeded') await refreshAuth(generation)
    }
  }
  const watchLogin = (id: string, generation: number) => {
    stopPoll()
    const tick = async () => {
      if (generation !== loginGeneration.current || loginRef.current?.id !== id || loginRef.current.state !== 'running') return
      try {
        const next = await api<LoginSession>(`/settings/login/${id}`)
        if (generation !== loginGeneration.current || loginRef.current?.state !== 'running') return
        await acceptLogin(next, generation)
      } catch (error) {
        if (generation === loginGeneration.current) setError(error instanceof Error ? error.message : '无法读取登录状态。')
      }
      if (generation === loginGeneration.current && loginRef.current?.state === 'running') poll.current = setTimeout(tick, 800)
    }
    poll.current = setTimeout(tick, 800)
  }
  const startLogin = async () => {
    if (startingRef.current || loginRef.current?.state === 'running' || busy || !active) return
    const generation = loginGeneration.current
    startingRef.current = true
    setStartingLogin(true); setError(''); setResult(null)
    try {
      const session = await api<LoginSession>('/settings/providers/openai-codex/login', { type: 'oauth' })
      if (generation !== loginGeneration.current) {
        await api(`/settings/login/${session.id}/cancel`, {})
        return
      }
      await acceptLogin(session, generation)
      if (session.state === 'running') watchLogin(session.id, generation)
    } catch (error) {
      if (generation === loginGeneration.current) setError(error instanceof Error ? error.message : '无法启动登录。')
    } finally {
      startingRef.current = false; setStartingLogin(false)
    }
  }
  const answerLogin = async (promptId: string, value: string) => {
    const session = loginRef.current
    if (!session || answering || busy || cancellingLogin) return
    const generation = loginGeneration.current
    setAnswering(true)
    try {
      const next = await api<LoginSession>(`/settings/login/${session.id}/answer`, { promptId, value })
      if (loginRef.current?.id === session.id && loginRef.current.state === 'running') await acceptLogin(next, generation)
    } catch (error) {
      if (generation === loginGeneration.current) setError(error instanceof Error ? error.message : '无法提交登录信息。')
    } finally { if (generation === loginGeneration.current) setAnswering(false) }
  }
  const cancelLogin = async () => {
    const session = loginRef.current
    if (!session || busy || cancellingLogin) return
    const generation = ++loginGeneration.current
    stopPoll(); setAnswering(false); setCancellingLogin(true); setBusy('cancel')
    try {
      const next = await api<LoginSession>(`/settings/login/${session.id}/cancel`, {})
      await acceptLogin(next, generation)
      // Abort can be acknowledged before the server's login promise settles.
      if (generation === loginGeneration.current && next.state === 'running') watchLogin(session.id, generation)
    }
    catch (error) {
      if (generation === loginGeneration.current) {
        setCancellingLogin(false)
        setError(error instanceof Error ? error.message : '无法取消登录。')
        updateLogin(session); watchLogin(session.id, generation)
      }
    } finally { setBusy(null) }
  }
  const logout = async () => {
    setBusy('logout'); setError(''); setResult(null); updateLogin(null)
    try {
      await api('/settings/providers/openai-codex/logout', {})
      await refreshAuth(loginGeneration.current)
    } catch (error) { setError(error instanceof Error ? error.message : '无法退出登录。') }
    finally { setBusy(null) }
  }
  const write = async (action: 'save' | 'toggle', input: unknown) => {
    setBusy(action); setError(''); setResult(null)
    try {
      const next = await api<SearchSettings>('/settings/search', input)
      setSettings(next)
      if (action === 'save') {
        const selected = next.providers.find((entry) => entry.id === next.provider)
        setProvider(next.provider); setApiKey('')
        setModel(selected?.model ?? ''); setRegion(selected?.region ?? '')
      }
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
            <Switch id="search-enabled" checked={settings.enabled} disabled={blocked}
              onCheckedChange={(enabled) => void write('toggle', { enabled })} />
          </CardContent>
        </Card>
        {settings.enabled && !saved?.ready && <Alert><AlertDescription>
          {saved?.authentication === 'oauth' ? '搜索已启用，但当前服务尚未登录。请先登录 Codex。' : '搜索已启用，但当前服务尚未配置凭据。请先保存 API Key。'}
        </AlertDescription></Alert>}
        <Card>
          <CardHeader><CardTitle><h3>服务配置</h3></CardTitle></CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="search-provider">搜索服务商</FieldLabel>
                <Select value={provider} disabled={!!busy} onValueChange={(value) => {
                  if (value && value !== provider) {
                    const selected = settings.providers.find((entry) => entry.id === value)
                    setProvider(value as SearchProvider); setApiKey(''); setResult(null); setError('')
                    setModel(selected?.model ?? ''); setRegion(selected?.region ?? '')
                  }
                }}>
                  <SelectTrigger id="search-provider" className="w-full"><SelectValue>{current?.name}</SelectValue></SelectTrigger>
                  <SelectContent>{settings.providers.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {current?.authentication === 'api_key' && <Field>
                <div className="flex flex-wrap items-center gap-2">
                  <FieldLabel htmlFor="search-api-key">API Key</FieldLabel>
                  <Badge variant={current?.configured ? 'secondary' : 'outline'} className="font-normal text-muted-foreground">
                    {current?.configured === 'saved' ? '已保存凭据' : current?.configured === 'environment' ? '使用服务端环境凭据' : '未配置凭据'}
                  </Badge>
                  {current.apiKeyUrl && <a href={current.apiKeyUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    获取 API Key<ExternalLink className="size-3" />
                  </a>}
                </div>
                <Input id="search-api-key" type="password" autoComplete="new-password" value={apiKey} disabled={blocked}
                  placeholder={current?.configured ? '留空保留已配置的凭据' : '输入 API Key'}
                  onChange={(event) => { setApiKey(event.target.value); setResult(null) }} />
              </Field>}
              {current?.authentication === 'none' && <div><Badge variant="secondary" className="font-normal text-muted-foreground">无需 API Key</Badge></div>}
              {current?.authentication === 'oauth' && <Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={current.configured ? 'secondary' : 'outline'} className="font-normal text-muted-foreground">
                    {current.configured === 'account' ? '已登录 · Codex' : '未登录 · Codex'}
                  </Badge>
                  <Button variant="outline" disabled={blocked} onClick={() => void startLogin()}>
                    {startingLogin ? <Spinner aria-hidden="true" /> : <LogIn data-icon="inline-start" />}登录 Codex
                  </Button>
                  {current.configured === 'account' && <Button variant="ghost" disabled={blocked} onClick={() => void logout()}>
                    <LogOut data-icon="inline-start" />退出登录
                  </Button>}
                </div>
                {login && login.state !== 'succeeded' && <LoginFlow key={login.id} session={login} answering={answering || cancellingLogin}
                  onAnswer={(id, value) => void answerLogin(id, value)} onCancel={() => void cancelLogin()} />}
              </Field>}
              {current?.model !== undefined && <Field>
                <FieldLabel htmlFor="search-model">搜索模型</FieldLabel>
                <Input id="search-model" value={model} maxLength={100} disabled={blocked}
                  onChange={(event) => { setModel(event.target.value); setResult(null) }} />
              </Field>}
              {current?.region !== undefined && <Field>
                <FieldLabel htmlFor="search-region">服务区域</FieldLabel>
                <Select value={region} disabled={blocked} onValueChange={(value) => {
                  if (value === 'global' || value === 'cn') { setRegion(value); setResult(null) }
                }}>
                  <SelectTrigger id="search-region" className="w-full"><SelectValue>{region === 'cn' ? '中国' : '全球'}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="global">全球</SelectItem><SelectItem value="cn">中国</SelectItem></SelectContent>
                </Select>
              </Field>}
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col items-start gap-3">
            <div className="flex flex-wrap gap-2">
              <Button disabled={blocked || !dirty || current?.model !== undefined && !model.trim()} onClick={() => void write('save', {
                provider, ...(current?.authentication === 'api_key' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                ...(current?.model !== undefined ? { model: model.trim() } : {}),
                ...(current?.region !== undefined ? { region } : {}),
              })}>
                {busy === 'save' && <Spinner />}保存配置
              </Button>
              <Button variant="outline" disabled={blocked || dirty || !saved?.ready} onClick={() => void test()}>
                {busy === 'test' && <Spinner />}测试搜索
              </Button>
            </div>
            {dirty && <p className="text-xs text-muted-foreground">请先保存配置再测试。</p>}
          </CardFooter>
        </Card>
        {result && <Card role="status" aria-live="polite">
          <CardHeader>
            <CardTitle><h3>测试完成</h3></CardTitle>
            <CardDescription>{settings.providers.find((entry) => entry.id === result.provider)?.name} · {result.answer ? `已生成回答 · ${result.results.length} 条来源` : `${result.results.length} 条结果`} · <span className="whitespace-nowrap">{result.tookMs} ms</span></CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-4">
            {result.answer && <div className="min-w-0">
              <h4 className="mb-2 text-sm font-medium">搜索回答</h4>
              <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{result.answer}</p>
            </div>}
            {!result.results.length && !result.answer && <p className="text-sm text-muted-foreground">服务已响应，但没有找到匹配的结果。</p>}
            {!!result.results.length && <>
              {result.answer && <h4 className="text-sm font-medium">参考来源</h4>}
              <ol className="flex flex-col gap-4">{result.results.map((entry, index) => <li key={`${index}:${entry.url}`} className="min-w-0">
                <a href={/^https?:\/\//i.test(entry.url) ? entry.url : undefined} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1.5 font-medium underline underline-offset-4 break-words [overflow-wrap:anywhere]">
                  <span className="min-w-0">{entry.title}</span><ExternalLink className="mt-0.5 size-3 shrink-0" />
                </a>
                <p className="mt-1 break-all text-xs text-muted-foreground">{entry.url}</p>
                {entry.snippet && <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{entry.snippet}</p>}
              </li>)}</ol>
            </>}
          </CardContent>
        </Card>}
      </>}
    </div>
  )
}

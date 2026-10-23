'use client'

import { CheckCircle2, ExternalLink, KeyRound, Loader2, LogIn, LogOut, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LoginSession, ModelSelection, ModelSettings, ModelSummary, ProviderSummary } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { formatNumber } from '@/i18n/format'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
import { useApp } from '@/app/context'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from '@/components/ui/combobox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'

function ProviderAuth({ provider }: { provider: ProviderSummary }) {
  const { t } = useTranslation('settings')
  if (provider.issue) return (
    <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      {t('auth.reauthenticate')}
    </span>
  )
  if (provider.configured)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        {provider.configured.type === 'oauth' ? t('auth.oauthConfigured') : t('auth.configured')}
      </span>
    )
  return <span className="text-xs text-muted-foreground">{t('auth.notConfigured')}</span>
}

export function LoginFlow({ session, onAnswer, onCancel, answering }: {
  session: LoginSession
  onAnswer: (promptId: string, value: string) => void
  onCancel: () => void
  answering: boolean
}) {
  const { t } = useTranslation('settings')
  const [value, setValue] = useState('')
  const prompt = session.prompt
  const url = session.events.findLast((e) => e.type === 'auth_url')
  const device = session.events.findLast((e) => e.type === 'device_code')
  const notes = session.events.filter((e) => e.type === 'info' || e.type === 'progress')
  const submit = () => {
    if (!prompt || !value.trim()) return
    onAnswer(prompt.id, value)
    setValue('')
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        {session.state === 'running' ? <Spinner /> : session.state === 'succeeded' ? <CheckCircle2 className="size-4 text-emerald-600" /> : <TriangleAlert className="size-4 text-destructive" />}
        {session.type === 'oauth' ? t('auth.oauthLogin') : t('auth.credentialLogin')} · {session.providerId}
      </div>
      {url?.type === 'auth_url' && (
        <div className="flex flex-col gap-1">
          {url.instructions && <p className="text-muted-foreground">{url.instructions}</p>}
          <a href={url.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-2 break-all">
            {t('auth.openAuthorization')} <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}
      {device?.type === 'device_code' && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">{t('auth.deviceCodeInstructions')}</p>
          <p className="font-mono text-lg font-semibold tracking-widest">{device.userCode}</p>
          <a href={device.verificationUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline underline-offset-2 break-all">
            {device.verificationUri} <ExternalLink className="size-3 shrink-0" />
          </a>
        </div>
      )}
      {notes.slice(-2).map((event, i) => (
        <p key={i} className="text-xs text-muted-foreground">{event.message}</p>
      ))}
      {session.state === 'running' && prompt && (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">{prompt.message}</p>
          {prompt.type === 'select' ? (
            <div className="flex flex-col gap-1.5">
              {prompt.options.map((option) => (
                <Button key={option.id} variant="outline" size="sm" className="justify-start" disabled={answering}
                  onClick={() => onAnswer(prompt.id, option.id)}>
                  <span className="flex flex-col items-start">
                    <span>{option.label}</span>
                    {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
              <Input
                type={prompt.type === 'secret' ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={prompt.placeholder ?? ''}
                autoFocus
                autoComplete="off"
              />
              <Button type="submit" size="sm" disabled={!value.trim() || answering}>{t('auth.submit')}</Button>
            </form>
          )}
        </div>
      )}
      {session.state === 'failed' && <p className="text-destructive">{session.error ? formatNotice(session.error) : t('auth.failed')}</p>}
      {session.state === 'cancelled' && <p className="text-muted-foreground">{t('auth.cancelled')}</p>}
      {session.state === 'running' && (
        <div>
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('auth.cancelLogin')}</Button>
        </div>
      )}
    </div>
  )
}

export function ModelSettingsForm({ active }: { active: boolean }) {
  const { t } = useTranslation('settings')
  const { refreshCapabilities } = useApp()
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [loadError, setLoadError] = useState<Error | UiNotice | null>(null)
  const [provider, setProvider] = useState('')
  const [models, setModels] = useState<ModelSummary[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<Error | UiNotice | null>(null)
  const [modelsRetry, setModelsRetry] = useState(0)
  const [model, setModel] = useState('')
  const [level, setLevel] = useState<ModelSelection['thinkingLevel']>('high')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<Error | UiNotice | null>(null)
  const [login, setLogin] = useState<LoginSession | null>(null)
  const [startingLogin, setStartingLogin] = useState(false)
  const [answering, setAnswering] = useState(false)
  const modelList = useRef<HTMLDivElement | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const loginRef = useRef<LoginSession | null>(null)
  const loginGeneration = useRef(0)
  const updateLogin = useCallback((session: LoginSession | null) => {
    loginRef.current = session
    setLogin(session)
  }, [])

  const stopPoll = () => { if (poll.current) { clearInterval(poll.current); poll.current = undefined } }
  const refresh = useCallback(async () => {
    const next = await api<ModelSettings>('/settings/model')
    setSettings(next)
    return next
  }, [])
  const watchLogin = useCallback((id: string) => {
    stopPoll()
    poll.current = setInterval(async () => {
      try {
        const state = await api<LoginSession>(`/settings/login/${id}`)
        if (loginRef.current?.id !== id) return
        updateLogin(state)
        if (state.state !== 'running') {
          stopPoll()
          if (state.state === 'succeeded') { void refresh(); refreshCapabilities() }
        }
      } catch { if (loginRef.current?.id === id) stopPoll() }
    }, 800)
  }, [refresh, refreshCapabilities, updateLogin])

  const load = useCallback(() => {
    setLoadError(null)
    void api<ModelSettings>('/settings/model').then((next) => {
      setSettings(next)
      if (next.selection) {
        setProvider(next.selection.provider)
        setModel(next.selection.model)
        setLevel(next.selection.thinkingLevel)
      }
    }).catch((error: unknown) => { setLoadError(error instanceof Error ? error : notice('settings', 'errors.loadModel')) })
  }, [])
  useEffect(() => {
    if (!active) return
    if (!settings) load()
    else void refresh().catch((error: unknown) => { setSaveError(error instanceof Error ? error : notice('settings', 'errors.loadModel')) })
  }, [active, load, refresh])

  useEffect(() => {
    if (!provider) return
    let cancelled = false
    setModelsLoading(true)
    setModels([])
    setModelsError(null)
    void api<ModelSummary[]>(`/settings/providers/${provider}/models`)
      .then((list) => { if (!cancelled) setModels(list) })
      .catch((error: unknown) => { if (!cancelled) setModelsError(error instanceof Error ? error : notice('settings', 'errors.loadModels')) })
      .finally(() => { if (!cancelled) setModelsLoading(false) })
    return () => { cancelled = true }
  }, [provider, modelsRetry])

  useEffect(() => {
    if (!active) return
    return () => {
      loginGeneration.current++
      stopPoll()
      const current = loginRef.current
      if (current?.state === 'running') void api(`/settings/login/${current.id}/cancel`, {}).catch(() => {})
      updateLogin(null)
      setStartingLogin(false)
    }
  }, [active, updateLogin])

  const providers = settings?.providers ?? []
  const current = providers.find((p) => p.id === provider)
  const chosen = models.find((m) => m.id === model)
  const levels = chosen?.thinkingLevels ?? []
  const loggingIn = startingLogin || login?.state === 'running'
  const dirty = settings?.selection
    ? provider !== settings.selection.provider || model !== settings.selection.model || level !== settings.selection.thinkingLevel
    : !!(provider && model)

  const save = async () => {
    setSaving(true); setSaveError(null)
    try {
      const next = await api<ModelSettings>('/settings/model', { provider, model, thinkingLevel: level })
      setSettings(next)
      refreshCapabilities()
    } catch (error) {
      setSaveError(error instanceof Error ? error : notice('settings', 'errors.saveModel'))
    } finally { setSaving(false) }
  }
  const startLogin = async (type: 'api_key' | 'oauth') => {
    const generation = loginGeneration.current
    setStartingLogin(true)
    setSaveError(null)
    try {
      const session = await api<LoginSession>(`/settings/providers/${provider}/login`, { type })
      if (generation !== loginGeneration.current) {
        await api(`/settings/login/${session.id}/cancel`, {})
        return
      }
      updateLogin(session)
      watchLogin(session.id)
    } catch (error) {
      if (generation === loginGeneration.current) setSaveError(error instanceof Error ? error : notice('settings', 'errors.startLogin'))
    } finally { if (generation === loginGeneration.current) setStartingLogin(false) }
  }
  const cancelLogin = () => {
    if (!login) return
    void api<LoginSession>(`/settings/login/${login.id}/cancel`, {}).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error : notice('settings', 'errors.cancelLogin'))
    })
  }
  const answerLogin = async (promptId: string, value: string) => {
    if (!login) return
    setAnswering(true)
    try {
      const next = await api<LoginSession>(`/settings/login/${login.id}/answer`, { promptId, value })
      if (loginRef.current?.id === next.id) updateLogin(next)
    }
    catch { /* the poll picks up the failure */ }
    finally { setAnswering(false) }
  }
  const logout = async () => {
    try { setSettings(await api<ModelSettings>(`/settings/providers/${provider}/logout`, {})); refreshCapabilities() }
    catch (error) { setSaveError(error instanceof Error ? error : notice('settings', 'errors.clearCredentials')) }
  }

  if (loadError) return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{formatNotice(loadError)}</AlertTitle>
      <AlertDescription><Button variant="outline" size="sm" onClick={load}>{t('actions.retry')}</Button></AlertDescription>
    </Alert>
  )
  if (!settings) return <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Spinner /> {t('model.loadingSettings')}</div>
  return (
    <Card className="gap-6 [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(8)]">
      <CardContent className="flex min-w-0 flex-col gap-8">
        {!settings.ready && <Alert role="status">
          <TriangleAlert />
          <AlertTitle>{t('model.unavailable')}</AlertTitle>
          <AlertDescription className="min-w-0 break-words">{formatNotice(settings.issue ?? notice('settings', 'model.configureCredentials'))}</AlertDescription>
        </Alert>}
        <FieldGroup className="gap-6">
          <Field className="grid items-start @md/field-group:grid-cols-[7rem_minmax(0,1fr)] @md/field-group:gap-x-8">
            <FieldLabel htmlFor="settings-provider" className="@md/field-group:pt-2.5">{t('model.provider')}</FieldLabel>
            <FieldContent className="min-w-0">
              <Select value={provider} disabled={loggingIn || saving} onValueChange={(value) => { if (value && value !== provider) { setProvider(value); setModel('') } }}>
                <SelectTrigger id="settings-provider" className="w-full px-3 data-[size=default]:h-10">
                  <SelectValue placeholder={t('model.chooseProvider')}>{current?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex flex-1 flex-wrap items-center gap-x-2">
                        {p.name}<span className="text-xs text-muted-foreground">{t('model.modelCount', { count: p.models, formattedCount: formatNumber(p.models) })}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>
          {provider && (
            <Field className="grid items-start @md/field-group:grid-cols-[7rem_minmax(0,1fr)] @md/field-group:gap-x-8">
              <FieldLabel id="settings-model-label" htmlFor="settings-model" className="@md/field-group:pt-2.5">{t('model.label')}</FieldLabel>
              <FieldContent className="min-w-0 gap-2">
                <Combobox key={provider} items={models} value={chosen ?? null} autoHighlight disabled={modelsLoading || saving}
                  itemToStringLabel={(m) => m.name} itemToStringValue={(m) => m.id}
                  isItemEqualToValue={(a, b) => a.id === b.id}
                  filter={(m, query) => `${m.name} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase())}
                  onInputValueChange={() => modelList.current?.scrollTo(0, 0)}
                  onValueChange={(m) => { setModel(m?.id ?? ''); if (m && !m.thinkingLevels.includes(level)) setLevel(m.thinkingLevels.at(-1) ?? 'off') }}>
                  <ComboboxTrigger id="settings-model" aria-labelledby="settings-model-label"
                    aria-describedby={chosen ? 'settings-model-details' : undefined}
                    render={<Button variant="outline" className="h-10 w-full min-w-0 justify-between px-3 font-normal" />}>
                    <span className="min-w-0 truncate"><ComboboxValue placeholder={modelsLoading ? t('model.loadingModels') : t('model.searchAndChoose')} /></span>
                  </ComboboxTrigger>
                  <ComboboxContent className="min-w-(--anchor-width)" aria-label={t('model.chooseModel')}>
                    <ComboboxInput aria-label={t('model.searchModels')} placeholder={t('model.searchPlaceholder')} showTrigger={false}>
                      <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                    </ComboboxInput>
                    <ComboboxEmpty className="px-3 py-6">{models.length ? t('model.noMatch') : t('model.noModels')}</ComboboxEmpty>
                    <ComboboxList ref={modelList} aria-label={t('model.modelList')}>
                      {(m: ModelSummary) => (
                        <ComboboxItem key={m.id} value={m} className="px-3 py-2.5">
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate font-medium">{m.name}</span>
                            <span className="truncate text-xs text-muted-foreground">{m.id}</span>
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {modelsError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                  {formatNotice(modelsError)}<Button variant="outline" size="sm" onClick={() => setModelsRetry((n) => n + 1)}>{t('actions.retry')}</Button>
                </div>}
                {chosen && <FieldDescription id="settings-model-details" className="text-xs leading-relaxed">
                  <span className="break-all">{chosen.id}</span> · <span className="whitespace-nowrap">{t('model.contextWindow', { size: formatNumber(Math.round(chosen.contextWindow / 1000)) })}</span>
                  {chosen.reasoning && <> · <span className="whitespace-nowrap">{t('model.reasoningSupported')}</span></>}
                  {chosen.input.includes('image') && <> · <span className="whitespace-nowrap">{t('model.image')}</span></>}
                </FieldDescription>}
              </FieldContent>
            </Field>
          )}
          {chosen && levels.length > 0 && (
            <Field className="grid items-start @md/field-group:grid-cols-[7rem_minmax(0,1fr)] @md/field-group:gap-x-8">
              <FieldLabel htmlFor="settings-level" className="@md/field-group:pt-2.5">{t('model.reasoningEffort')}</FieldLabel>
              <FieldContent className="min-w-0">
                <Select value={level} disabled={saving} onValueChange={(value) => setLevel(value as ModelSelection['thinkingLevel'])}>
                  <SelectTrigger id="settings-level" className="w-full px-3 data-[size=default]:h-10"><SelectValue>{t(`model.levels.${level}`)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {levels.map((l) => <SelectItem key={l} value={l}>{t(`model.levels.${l}`)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FieldContent>
            </Field>
          )}
        </FieldGroup>
        {current && (
          <section aria-label={t('model.providerCredentials', { provider: current.name })} className="flex min-w-0 flex-col gap-4 border-t pt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t('model.credentials')}</h3>
              <ProviderAuth provider={current} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {current.auth.apiKey?.login && (
                <Button variant="outline" size="lg" disabled={loggingIn} onClick={() => void startLogin('api_key')}>
                  <KeyRound data-icon="inline-start" /> {t('model.enterApiKey')}
                </Button>
              )}
              {current.auth.oauth && (
                <Button variant="outline" size="lg" disabled={loggingIn} onClick={() => void startLogin('oauth')}>
                  <LogIn data-icon="inline-start" /> {current.auth.oauth.label ?? t('model.signIn', { provider: current.auth.oauth.name })}
                </Button>
              )}
              {current.stored && (
                <Button variant="ghost" size="lg" className="text-destructive" disabled={loggingIn} onClick={() => void logout()}>
                  <LogOut data-icon="inline-start" /> {t('model.clearCredentials')}
                </Button>
              )}
            </div>
            {login && login.providerId === provider && (
              <LoginFlow key={login.id} session={login} answering={answering} onAnswer={(id, value) => void answerLogin(id, value)} onCancel={cancelLogin} />
            )}
          </section>
        )}
        {saveError && <p role="alert" className="text-sm text-destructive">{formatNotice(saveError)}</p>}
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-3 border-t-0 pt-0">
        {dirty && <p role="status" className="text-xs text-muted-foreground">{t('model.unsavedChanges')}</p>}
        <Button size="lg" disabled={!dirty || !provider || !chosen || saving} onClick={save}>
          {saving && <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />}{t('model.saveSelection')}
        </Button>
      </CardFooter>
    </Card>
  )
}

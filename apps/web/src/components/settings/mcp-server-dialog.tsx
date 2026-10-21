import { useState } from 'react'
import { ChevronRight, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { mcpConfigurationSchema, mcpServerEntrySchema, type McpServerConfiguration, type McpServerEntry } from '@teach-me-coding/contracts'
import { formatNumber } from '@/i18n/format'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
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
  const { t } = useTranslation('settings')
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {rows.map(([key, value], index) => <div key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2">
        <Input aria-label={t('mcpEditor.rowName', { label, index: formatNumber(index + 1) })} placeholder={t('mcpEditor.name')} value={key}
          onChange={(e) => onChange(rows.map((row, at) => at === index ? [e.target.value, row[1]] : row))} />
        <Input aria-label={t('mcpEditor.rowValue', { label, index: formatNumber(index + 1) })} placeholder={t('mcpEditor.value')} type="password" autoComplete="off" value={value}
          onChange={(e) => onChange(rows.map((row, at) => at === index ? [row[0], e.target.value] : row))} />
        <Button type="button" variant="ghost" size="icon" aria-label={t('mcpEditor.removeRow', { label, index: formatNumber(index + 1) })}
          onClick={() => onChange(rows.filter((_, at) => at !== index))}><X /></Button>
      </div>)}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...rows, ['', '']])}>
        <Plus />{t('mcpEditor.addRow', { label })}
      </Button>
      <FieldDescription className="text-xs">{t('mcpEditor.valuesDescription')}</FieldDescription>
    </Field>
  )
}

class ConfigurationError extends Error {
  constructor(readonly detail: UiNotice) { super(detail.key) }
}

function configurationError(error: unknown) {
  return error instanceof ConfigurationError ? error.detail
    : error instanceof SyntaxError ? notice('settings', 'mcpEditor.errors.invalidJson')
      : error instanceof Error ? error : notice('settings', 'errors.saveMcp')
}

function values(rows: Values, kind: 'headers' | 'environment') {
  const entries = rows.filter(([key, value]) => key || value)
  if (entries.some(([key]) => !key.trim())) throw new ConfigurationError(notice('settings', kind === 'headers' ? 'mcpEditor.errors.headerNameRequired' : 'mcpEditor.errors.environmentNameRequired'))
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new ConfigurationError(notice('settings', kind === 'headers' ? 'mcpEditor.errors.duplicateHeaders' : 'mcpEditor.errors.duplicateEnvironment'))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseEntry(name: string, raw: unknown): McpServerEntry {
  if (raw && typeof raw === 'object' && 'mcpServers' in raw) {
    const configuration = mcpConfigurationSchema.safeParse(raw)
    if (!configuration.success) throw new ConfigurationError(notice('settings', 'mcpEditor.errors.invalidConfiguration'))
    const entries = Object.entries(configuration.data.mcpServers)
    if (entries.length !== 1) throw new ConfigurationError(notice('settings', 'mcpEditor.errors.singleServer'))
    return { name: entries[0]![0], configuration: entries[0]![1] }
  }
  const entry = mcpServerEntrySchema.safeParse({ name: name.trim(), configuration: raw })
  if (!entry.success) {
    const path = entry.error.issues[0]!.path
    if (path[0] === 'name') throw new ConfigurationError(notice('settings', 'mcpEditor.errors.invalidName'))
    if (path.includes('url')) throw new ConfigurationError(notice('settings', 'mcpEditor.errors.invalidUrl'))
    if (path.includes('timeout')) throw new ConfigurationError(notice('settings', 'mcpEditor.errors.invalidTimeout'))
    throw new ConfigurationError(notice('settings', 'mcpEditor.errors.mixedTransport'))
  }
  return entry.data
}

export function McpServerDialog({ entry, onClose, onSave, finalFocus }: {
  entry?: McpServerEntry; onClose: () => void; onSave: (entry: McpServerEntry) => Promise<void>; finalFocus: () => HTMLElement | null
}) {
  const { t } = useTranslation('settings')
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
  const [error, setError] = useState<Error | UiNotice | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const configuration = (): McpServerConfiguration => ({
    ...(transport === 'http' ? { type: initial.url ? initial.type : 'http', url: url.trim(), headers: values(headers, 'headers') }
      : { type: 'stdio', command: command.trim(), args, ...(cwd.trim() ? { cwd: cwd.trim() } : {}), env: values(env, 'environment') }),
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
      setMode(next); setError(null)
    } catch (error) { setError(configurationError(error)) }
  }
  const save = async () => {
    setError(null)
    try {
      const next = parseEntry(name, mode === 'json' ? JSON.parse(json) : configuration())
      setBusy(true)
      await onSave(next)
      onClose()
    } catch (error) { setError(configurationError(error)) }
    finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent showCloseButton={!busy} finalFocus={finalFocus} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b p-5 pr-12">
          <DialogTitle>{entry ? t('mcpEditor.editTitle') : t('mcp.addServer')}</DialogTitle>
          <DialogDescription className="sr-only">{t('mcpEditor.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <div className="min-h-0 flex-1 overflow-y-auto"><fieldset disabled={busy} className="min-w-0 p-5">
            <FieldGroup>
              <Tabs value={mode} onValueChange={(value) => changeMode(String(value))} className="gap-5">
                <TabsList aria-label={t('mcpEditor.configurationMode')}><TabsTrigger value="form">{t('mcpEditor.form')}</TabsTrigger><TabsTrigger value="json">{t('mcpEditor.json')}</TabsTrigger></TabsList>
                <Field>
                  <FieldLabel htmlFor="mcp-server-name">{t('mcpEditor.serverName')}</FieldLabel>
                  <Input id="mcp-server-name" placeholder={t('mcpEditor.serverNamePlaceholder')} value={name} autoComplete="off" aria-required
                    onChange={(e) => setName(e.target.value)} />
                </Field>
                <TabsContent value="form" className="flex flex-col gap-5">
                  <Tabs value={transport} onValueChange={(value) => setTransport(String(value))} className="gap-5">
                    <Field>
                      <FieldLabel>{t('mcpEditor.transport')}</FieldLabel>
                      <TabsList aria-label={t('mcpEditor.transport')} className="w-full">
                        <TabsTrigger value="stdio">{t('mcpEditor.stdio')}</TabsTrigger><TabsTrigger value="http">{t('mcpEditor.http')}</TabsTrigger>
                      </TabsList>
                    </Field>
                    <TabsContent value="stdio" className="flex flex-col gap-5">
                      <Field><FieldLabel htmlFor="mcp-command">{t('mcpEditor.command')}</FieldLabel>
                        <Input id="mcp-command" placeholder="npx" value={command} aria-required onChange={(e) => setCommand(e.target.value)} /></Field>
                      <Field><FieldLabel htmlFor="mcp-args">{t('mcpEditor.arguments')}</FieldLabel>
                        <Textarea id="mcp-args" value={args.join('\n')} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/projects'} translate="no" spellCheck={false}
                          className="min-h-24 font-mono text-xs!" onChange={(e) => setArgs(e.target.value ? e.target.value.split('\n') : [])} />
                        <FieldDescription className="text-xs">{t('mcpEditor.argumentsDescription')}</FieldDescription></Field>
                    </TabsContent>
                    <TabsContent value="http" className="flex flex-col gap-5">
                      <Field><FieldLabel htmlFor="mcp-url">{t('mcpEditor.url')}</FieldLabel>
                        <Input id="mcp-url" placeholder="https://example.com/mcp" value={url} aria-required onChange={(e) => setUrl(e.target.value)} /></Field>
                      <ConnectionValues label={t('mcpEditor.headers')} rows={headers} onChange={setHeaders} />
                    </TabsContent>
                  </Tabs>
                  <Collapsible open={advanced} onOpenChange={setAdvanced} className="rounded-lg border">
                    <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium">
                      <ChevronRight className={`size-4 transition-transform ${advanced ? 'rotate-90' : ''}`} />{t('mcpEditor.advanced')}
                      <span className="ml-auto text-xs font-normal text-muted-foreground">{transport === 'stdio' ? t('mcpEditor.advancedStdio') : t('mcpEditor.advancedHttp')}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-3 pb-3">
                      <FieldGroup>
                        {transport === 'stdio' && <>
                          <Field><FieldLabel htmlFor="mcp-cwd">{t('mcpEditor.directory')}</FieldLabel><Input id="mcp-cwd" value={cwd} placeholder={t('mcpEditor.defaultDirectory')} onChange={(e) => setCwd(e.target.value)} /></Field>
                          <ConnectionValues label={t('mcpEditor.environment')} rows={env} onChange={setEnv} />
                        </>}
                        <Field><FieldLabel htmlFor="mcp-timeout">{t('mcpEditor.timeout')}</FieldLabel>
                          <Input id="mcp-timeout" type="number" min="0" step="any" placeholder="60" value={timeout} onChange={(e) => setTimeout(e.target.value)} /></Field>
                      </FieldGroup>
                    </CollapsibleContent>
                  </Collapsible>
                  <Field orientation="horizontal"><FieldLabel htmlFor="mcp-enabled">{entry ? t('mcpEditor.enable') : t('mcpEditor.enableAfterAdding')}</FieldLabel>
                    <Switch id="mcp-enabled" checked={enabled} onCheckedChange={setEnabled} /></Field>
                </TabsContent>
                <TabsContent value="json">
                  <Field><FieldLabel htmlFor="mcp-server-json">{t('mcpEditor.serverJson')}</FieldLabel>
                    <Textarea id="mcp-server-json" className="min-h-64 font-mono text-xs!" value={json} spellCheck={false} onChange={(e) => setJson(e.target.value)} />
                    <FieldDescription className="text-xs">{t('mcpEditor.jsonDescription')}</FieldDescription>
                  </Field>
                </TabsContent>
              </Tabs>
              {error && <Alert variant="destructive"><AlertDescription>{formatNotice(error)}</AlertDescription></Alert>}
            </FieldGroup>
          </fieldset></div>
          <DialogFooter className="m-0 shrink-0 flex-row bg-muted/30 px-5 py-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('actions.cancel')}</Button>
            <Button type="submit" disabled={busy}>{busy && <Spinner />}{entry ? t('mcpEditor.save') : t('mcpEditor.add')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

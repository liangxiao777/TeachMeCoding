import { useEffect, useRef, useState } from 'react'
import { BookOpen, FolderOpen, Link, MoreHorizontal, RotateCw, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogSkill, SkillSettings } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { formatNumber } from '@/i18n/format'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SkillDetailsDialog } from './skill-details-dialog'
import { SkillMarket } from './skill-market'

type InstalledSkill = SkillSettings['skills'][number]
const message = (error: unknown) => error instanceof Error ? error : notice('settings', 'errors.actionFailed')

export function SkillsSettingsForm({ active }: { active: boolean }) {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<SkillSettings | null>(null)
  const [tab, setTab] = useState('installed')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<Error | UiNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [editor, setEditor] = useState<'link' | 'local' | null>(null)
  const [source, setSource] = useState('')
  const [skillName, setSkillName] = useState('')
  const [editorError, setEditorError] = useState<Error | UiNotice | null>(null)
  const [details, setDetails] = useState<{ skill: InstalledSkill; check: boolean } | null>(null)
  const [removing, setRemoving] = useState<InstalledSkill | null>(null)
  const revision = useRef(0)
  const addButton = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = () => returnFocus.current?.isConnected ? returnFocus.current : addButton.current
  const load = async () => {
    const current = revision.current
    try {
      const next = await api<SkillSettings>('/settings/skills')
      if (current === revision.current) { setSettings(next); setError(null) }
    } catch (error) { if (current === revision.current) setError(message(error)) }
  }
  useEffect(() => { if (active) void load() }, [active])
  const write = async (path: string, input: unknown) => {
    revision.current++; setBusy(true); setError(null)
    try { setSettings(await api<SkillSettings>(path, input)) }
    finally { revision.current++; setBusy(false) }
  }
  const install = async (skill: CatalogSkill) => {
    setInstalling(skill.id)
    try { await write('/settings/skills/install', { source: skill.source, skill: skill.skillId }); return null }
    catch (error) { return message(error) }
    finally { setInstalling(null) }
  }
  const installed = (skill: CatalogSkill) => settings?.skills.some((item) => (item.name === skill.name || item.name === skill.skillId) &&
    (item.installation?.source === skill.source || item.installation?.source.replace(/^https:\/\/(?:github.com\/)?/, '').replace(/\.git$/, '').replace(/\/$/, '') === skill.source))
  const visible = settings?.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.installation?.source ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2"><h2 className="text-2xl font-semibold tracking-tight">{t('categories.skills')}</h2>
          <p className="text-sm text-muted-foreground">{t('skills.description')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={addButton} variant="outline" disabled={!settings || busy} onClick={(event) => { returnFocus.current = event.currentTarget; setSource(''); setSkillName(''); setEditorError(null); setEditor('link') }}><Link />{t('skills.installFromLink')}</Button>
          <Button variant="outline" disabled={!settings || busy} onClick={(event) => { returnFocus.current = event.currentTarget; setSource(''); setEditorError(null); setEditor('local') }}><FolderOpen />{t('skills.importDirectory')}</Button>
        </div>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{formatNotice(error)}{!settings && <Button variant="outline" size="sm" onClick={() => void load()}>{t('actions.retry')}</Button>}</AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm"><Spinner />{t('skills.loading')}</div> :
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-5">
          <TabsList aria-label={t('skills.list')} className="h-9! flex-row!"><TabsTrigger value="installed" className="w-auto! justify-center! px-3">{t('skills.installed')} <span className="text-xs text-muted-foreground">{formatNumber(settings.skills.length)}</span></TabsTrigger>
            <TabsTrigger value="discover" className="w-auto! justify-center! px-3">{t('skills.market')}</TabsTrigger></TabsList>
          <TabsContent value="installed" keepMounted className="flex flex-col gap-4">
            <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input aria-label={t('skills.filter')} placeholder={t('skills.searchPlaceholder')} className="pl-9" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
              <Button variant="outline" size="icon" aria-label={t('skills.rescan')} disabled={busy} onClick={() => void write('/settings/skills/reload', {}).catch((error) => setError(message(error)))}><RotateCw /></Button>
            </div>
            {!visible.length ? <Empty className="border py-14"><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia>
              <EmptyTitle>{settings.skills.length ? t('skills.noMatch') : t('skills.empty')}</EmptyTitle>
              <EmptyDescription>{settings.skills.length ? t('skills.tryKeyword') : t('skills.emptyDescription')}</EmptyDescription></EmptyHeader>
              {!settings.skills.length && <Button variant="outline" onClick={() => setTab('discover')}>{t('skills.browse')}</Button>}</Empty> :
              <ItemGroup aria-label={t('skills.installedList')} className="gap-0! overflow-hidden rounded-xl border">{visible.map((skill) => <Item key={skill.filePath} role="listitem" aria-label={skill.name}
                className="flex-nowrap rounded-none border-0 border-border p-4 not-last:border-b">
                <ItemMedia variant="icon" className="hidden size-10 rounded-lg bg-muted sm:flex"><BookOpen className="size-5" /></ItemMedia>
                <ItemContent className="min-w-0 gap-1.5"><ItemTitle className="line-clamp-none flex! max-w-full flex-wrap break-all"><h3>{skill.name}</h3>
                  {!skill.automatic && <Badge variant="secondary">{t('skills.manualOnly')}</Badge>}</ItemTitle>
                  <p className="break-words text-sm text-muted-foreground">{skill.description}</p>
                  <p className="break-all text-xs text-muted-foreground">{skill.installation?.source ?? t('skills.localDirectory')}</p>
                </ItemContent>
                <ItemActions className="shrink-0 gap-2"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" disabled={busy} aria-label={t('skills.manage', { name: skill.name })}
                  onPointerDownCapture={(event) => { returnFocus.current = event.currentTarget }} onFocusCapture={(event) => { returnFocus.current = event.currentTarget }} />}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setDetails({ skill, check: false })}><BookOpen />{t('skills.details')}</DropdownMenuItem>
                    <DropdownMenuItem disabled={!skill.installation} onClick={() => setDetails({ skill, check: true })}><RotateCw />{t('skills.checkUpdates')}</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => { setEditorError(null); setRemoving(skill) }}><Trash2 />{skill.installation ? t('skills.uninstall') : t('skills.remove')}</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>
                  <Switch aria-label={t('skills.enable', { name: skill.name })} checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => {
                    void write('/settings/skills', { ...settings.configuration, disabled: enabled ? settings.configuration.disabled.filter((path) => path !== skill.filePath)
                      : [...settings.configuration.disabled, skill.filePath] }).catch((error) => setError(message(error)))
                  }} />
                </ItemActions>
              </Item>)}</ItemGroup>}
            {settings.diagnostics.map((diagnostic, index) => <Alert key={index} variant={diagnostic.type === 'error' ? 'destructive' : 'default'}>
              <AlertDescription className="break-words">{diagnostic.message}</AlertDescription></Alert>)}
          </TabsContent>
          <TabsContent value="discover" keepMounted className="flex flex-col gap-4">
            <SkillMarket active={active && tab === 'discover'} busy={busy} installing={installing} installed={installed} onInstall={install} />
          </TabsContent>
        </Tabs>}
      {editor && <Dialog open onOpenChange={(open) => { if (!open && !busy) setEditor(null) }}><DialogContent showCloseButton={!busy} finalFocus={restoreFocus} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{editor === 'link' ? t('skills.installTitle') : t('skills.localTitle')}</DialogTitle>
          <DialogDescription>{editor === 'link' ? t('skills.linkDescription') : t('skills.localDescription')}</DialogDescription></DialogHeader>
        <form id="skill-source" className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault(); setEditorError(null)
          void write(editor === 'link' ? '/settings/skills/install' : '/settings/skills/local', editor === 'link' ? { source, ...(skillName.trim() ? { skill: skillName.trim() } : {}) } : { path: source })
            .then(() => { setEditor(null); setTab('installed'); setFilter('') }).catch((error) => setEditorError(message(error)))
        }}><Field><FieldLabel htmlFor="skill-source-input">{editor === 'link' ? t('skills.sourceLink') : t('skills.directoryPath')}</FieldLabel>
          <Input id="skill-source-input" value={source} disabled={busy} onChange={(event) => setSource(event.target.value)} placeholder={editor === 'link' ? 'https://skills.sh/owner/repo/skill' : '/path/to/skills'} /></Field>
          {editor === 'link' && <Field><FieldLabel htmlFor="skill-name">{t('skills.optionalName')}</FieldLabel><Input id="skill-name" value={skillName} disabled={busy} onChange={(event) => setSkillName(event.target.value)} />
            <FieldDescription>{t('skills.nameDescription')}</FieldDescription></Field>}
          {editorError && <Alert variant="destructive"><AlertDescription>{formatNotice(editorError)}</AlertDescription></Alert>}
        </form>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>{t('actions.cancel')}</Button>
          <Button type="submit" form="skill-source" disabled={busy || !source.trim()}>{busy && <Spinner />}{editor === 'link' ? t('skills.install') : t('skills.addDirectory')}</Button></DialogFooter>
      </DialogContent></Dialog>}
      {details && <SkillDetailsDialog filePath={details.skill.filePath} checkInitially={details.check} finalFocus={restoreFocus}
        onClose={() => setDetails(null)} onUpdated={load} />}
      {removing && <Dialog open onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}><DialogContent showCloseButton={!busy} finalFocus={restoreFocus}>
        <DialogHeader><DialogTitle>{removing.installation ? t('skills.uninstallTitle', { name: removing.name }) : t('skills.removeTitle', { name: removing.name })}</DialogTitle>
          <DialogDescription>{removing.installation ? t('skills.uninstallDescription') : t('skills.removeDescription')}</DialogDescription></DialogHeader>
        {editorError && <Alert variant="destructive"><AlertDescription>{formatNotice(editorError)}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>{t('actions.cancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => { setEditorError(null); void write('/settings/skills/remove', { filePath: removing.filePath })
            .then(() => setRemoving(null)).catch((error) => setEditorError(message(error))) }}>{busy && <Spinner />}{removing.installation ? t('skills.uninstallSkill') : t('skills.removeReference')}</Button></DialogFooter>
      </DialogContent></Dialog>}
    </div>
  )
}

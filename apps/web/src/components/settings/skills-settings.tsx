import { useEffect, useRef, useState } from 'react'
import { BookOpen, FolderOpen, Link, MoreHorizontal, RotateCw, Search, Trash2 } from 'lucide-react'
import type { CatalogSkill, SkillSettings } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
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
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'

export function SkillsSettingsForm({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<SkillSettings | null>(null)
  const [tab, setTab] = useState('installed')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [editor, setEditor] = useState<'link' | 'local' | null>(null)
  const [source, setSource] = useState('')
  const [skillName, setSkillName] = useState('')
  const [editorError, setEditorError] = useState('')
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
      if (current === revision.current) { setSettings(next); setError('') }
    } catch (error) { if (current === revision.current) setError(message(error)) }
  }
  useEffect(() => { if (active) void load() }, [active])
  const write = async (path: string, input: unknown) => {
    revision.current++; setBusy(true); setError('')
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
        <div className="flex flex-col gap-2"><h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
          <p className="text-sm text-muted-foreground">为 Agent 添加可按需使用的技能。</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={addButton} variant="outline" disabled={!settings || busy} onClick={(event) => { returnFocus.current = event.currentTarget; setSource(''); setSkillName(''); setEditorError(''); setEditor('link') }}><Link />从链接安装</Button>
          <Button variant="outline" disabled={!settings || busy} onClick={(event) => { returnFocus.current = event.currentTarget; setSource(''); setEditorError(''); setEditor('local') }}><FolderOpen />导入本地目录</Button>
        </div>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}{!settings && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}</AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm"><Spinner />正在读取 Skills…</div> :
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="gap-5">
          <TabsList aria-label="技能列表" className="h-9! flex-row!"><TabsTrigger value="installed" className="w-auto! justify-center! px-3">已安装 <span className="text-xs text-muted-foreground">{settings.skills.length}</span></TabsTrigger>
            <TabsTrigger value="discover" className="w-auto! justify-center! px-3">技能市场</TabsTrigger></TabsList>
          <TabsContent value="installed" keepMounted className="flex flex-col gap-4">
            <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input aria-label="筛选已安装技能" placeholder="搜索已安装的技能" className="pl-9" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
              <Button variant="outline" size="icon" aria-label="重新扫描" disabled={busy} onClick={() => void write('/settings/skills/reload', {}).catch((error) => setError(message(error)))}><RotateCw /></Button>
            </div>
            {!visible.length ? <Empty className="border py-14"><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia>
              <EmptyTitle>{settings.skills.length ? '没有匹配的技能' : '还没有安装技能'}</EmptyTitle>
              <EmptyDescription>{settings.skills.length ? '换个关键词试试。' : '从 skills.sh 发现技能，或添加已有的本地目录。'}</EmptyDescription></EmptyHeader>
              {!settings.skills.length && <Button variant="outline" onClick={() => setTab('discover')}>浏览技能</Button>}</Empty> :
              <ItemGroup aria-label="已安装技能" className="gap-0! overflow-hidden rounded-xl border">{visible.map((skill) => <Item key={skill.filePath} role="listitem" aria-label={skill.name}
                className="flex-nowrap rounded-none border-0 border-border p-4 not-last:border-b">
                <ItemMedia variant="icon" className="hidden size-10 rounded-lg bg-muted sm:flex"><BookOpen className="size-5" /></ItemMedia>
                <ItemContent className="min-w-0 gap-1.5"><ItemTitle className="line-clamp-none flex! max-w-full flex-wrap break-all"><h3>{skill.name}</h3>
                  {!skill.automatic && <Badge variant="secondary">仅手动调用</Badge>}</ItemTitle>
                  <p className="break-words text-sm text-muted-foreground">{skill.description}</p>
                  <p className="break-all text-xs text-muted-foreground">{skill.installation?.source ?? '本地目录'}</p>
                </ItemContent>
                <ItemActions className="shrink-0 gap-2"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" disabled={busy} aria-label={`管理 ${skill.name}`}
                  onPointerDownCapture={(event) => { returnFocus.current = event.currentTarget }} onFocusCapture={(event) => { returnFocus.current = event.currentTarget }} />}><MoreHorizontal /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setDetails({ skill, check: false })}><BookOpen />查看详情</DropdownMenuItem>
                    <DropdownMenuItem disabled={!skill.installation} onClick={() => setDetails({ skill, check: true })}><RotateCw />检查更新</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => { setEditorError(''); setRemoving(skill) }}><Trash2 />{skill.installation ? '卸载' : '移除'}</DropdownMenuItem>
                  </DropdownMenuContent></DropdownMenu>
                  <Switch aria-label={`启用 ${skill.name}`} checked={skill.enabled} disabled={busy} onCheckedChange={(enabled) => {
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
        <DialogHeader><DialogTitle>{editor === 'link' ? '从链接安装技能' : '添加本地技能目录'}</DialogTitle>
          <DialogDescription>{editor === 'link' ? '填写 skills.sh 技能链接或 Git 仓库地址。' : '引用已有的技能文件，不复制或修改原目录。'}</DialogDescription></DialogHeader>
        <form id="skill-source" className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault(); setEditorError('')
          void write(editor === 'link' ? '/settings/skills/install' : '/settings/skills/local', editor === 'link' ? { source, ...(skillName.trim() ? { skill: skillName.trim() } : {}) } : { path: source })
            .then(() => { setEditor(null); setTab('installed'); setFilter('') }).catch((error) => setEditorError(message(error)))
        }}><Field><FieldLabel htmlFor="skill-source-input">{editor === 'link' ? '来源链接' : '目录或 SKILL.md 路径'}</FieldLabel>
          <Input id="skill-source-input" value={source} disabled={busy} onChange={(event) => setSource(event.target.value)} placeholder={editor === 'link' ? 'https://skills.sh/owner/repo/skill' : '/path/to/skills'} /></Field>
          {editor === 'link' && <Field><FieldLabel htmlFor="skill-name">技能名称（可选）</FieldLabel><Input id="skill-name" value={skillName} disabled={busy} onChange={(event) => setSkillName(event.target.value)} />
            <FieldDescription>仓库包含多个技能时填写；skills.sh 链接会自动识别。</FieldDescription></Field>}
          {editorError && <Alert variant="destructive"><AlertDescription>{editorError}</AlertDescription></Alert>}
        </form>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>取消</Button>
          <Button type="submit" form="skill-source" disabled={busy || !source.trim()}>{busy && <Spinner />}{editor === 'link' ? '安装技能' : '添加目录'}</Button></DialogFooter>
      </DialogContent></Dialog>}
      {details && <SkillDetailsDialog filePath={details.skill.filePath} checkInitially={details.check} finalFocus={restoreFocus}
        onClose={() => setDetails(null)} onUpdated={load} />}
      {removing && <Dialog open onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}><DialogContent showCloseButton={!busy} finalFocus={restoreFocus}>
        <DialogHeader><DialogTitle>{removing.installation ? '卸载' : '移除'} {removing.name}？</DialogTitle>
          <DialogDescription>{removing.installation ? '这会删除应用安装的技能文件。' : '仅移除应用中的引用，原始文件会保留。'}</DialogDescription></DialogHeader>
        {editorError && <Alert variant="destructive"><AlertDescription>{editorError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={() => { setEditorError(''); void write('/settings/skills/remove', { filePath: removing.filePath })
            .then(() => setRemoving(null)).catch((error) => setEditorError(message(error))) }}>{busy && <Spinner />}{removing.installation ? '卸载技能' : '移除引用'}</Button></DialogFooter>
      </DialogContent></Dialog>}
    </div>
  )
}

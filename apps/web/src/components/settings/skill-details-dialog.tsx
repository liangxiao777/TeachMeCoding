import { useEffect, useRef, useState } from 'react'
import type { SkillDetails, SkillUpdate } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'

export function SkillDetailsDialog({ filePath, checkInitially, finalFocus, onClose, onUpdated }: {
  filePath: string; checkInitially: boolean; finalFocus: () => HTMLElement | null;
  onClose: () => void; onUpdated: () => Promise<void>
}) {
  const entryFile = filePath.split(/[\\/]/).at(-1) ?? 'SKILL.md'
  const [details, setDetails] = useState<SkillDetails | null>(null)
  const [file, setFile] = useState(entryFile)
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [update, setUpdate] = useState<SkillUpdate | null>(null)
  const selection = useRef(0)
  const query = `filePath=${encodeURIComponent(filePath)}`
  const load = async () => {
    const current = ++selection.current
    setLoadingFile(false)
    try {
      const result = await api<SkillDetails>(`/settings/skills/details?${query}`)
      if (current !== selection.current) return false
      setError(''); setDetails(result); setFile(entryFile); setContent(result.content)
      return true
    } catch (error) {
      if (current === selection.current) setError(error instanceof Error ? error.message : '无法读取技能。')
      return false
    }
  }
  const check = async () => {
    setBusy(true); setError(''); setUpdate(null)
    try { setUpdate(await api<SkillUpdate>('/settings/skills/check', { filePath })) }
    catch (error) { setError(error instanceof Error ? error.message : '无法检查更新。') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    void load().then((loaded) => { if (loaded && checkInitially) void check() })
    return () => { selection.current++ }
  }, [filePath])
  const select = async (name: string) => {
    const current = ++selection.current
    setFile(name); setLoadingFile(true); setError(''); setContent('')
    try {
      const result = await api<{ content: string }>(`/settings/skills/file?${query}&name=${encodeURIComponent(name)}`)
      if (current === selection.current) setContent(result.content)
    } catch (error) { if (current === selection.current) setError(error instanceof Error ? error.message : '无法预览文件。') }
    finally { if (current === selection.current) setLoadingFile(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent finalFocus={finalFocus} showCloseButton={!busy}
    className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
    <DialogHeader className="pr-6"><DialogTitle className="break-all">{details?.name ?? '技能详情'}</DialogTitle>
      <DialogDescription className="break-all">{details?.installation?.source ?? '本地技能'}</DialogDescription></DialogHeader>
    {error && <Alert variant="destructive"><AlertDescription>{error}{!details && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}</AlertDescription></Alert>}
    {busy && <div role="status" className="flex items-center gap-2 text-sm"><Spinner />{update ? '正在更新技能…' : '正在检查更新…'}</div>}
    {update && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
      <span>{update.modified ? '检测到本地改动，更新不会覆盖这些文件。' : update.available ? '发现新版本' : '已是最新版本'}</span>
      {update.available && !update.modified && <Button size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError('')
        void api<SkillUpdate>('/settings/skills/update', { filePath }).then(async () => {
          setUpdate({ filePath, available: false, modified: false }); await load(); await onUpdated()
        }).catch((error) => setError(error instanceof Error ? error.message : '无法更新技能。')).finally(() => setBusy(false))
      }}>更新技能</Button>}
    </div>}
    {details ? <>
      <p className="break-all text-xs text-muted-foreground">{details.filePath}{details.installation?.ref && ` · ${details.installation.ref}`}</p>
      <Select value={file} onValueChange={(value) => { if (value) void select(value) }} disabled={busy}>
        <SelectTrigger aria-label="技能文件" className="w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>{details.files.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
      </Select>
      {loadingFile ? <div role="status" className="flex items-center gap-2 p-4"><Spinner />正在读取文件…</div> :
        <pre aria-label="技能文件内容" className="min-h-32 min-w-0 overflow-y-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{content}</pre>}
    </> : !error && <div role="status" className="flex items-center gap-2"><Spinner />正在读取技能…</div>}
    <DialogFooter className="mt-auto shrink-0">{details?.installation && <Button variant="outline" disabled={busy} onClick={() => void check()}>检查更新</Button>}
      <Button variant="outline" disabled={busy} onClick={onClose}>关闭</Button></DialogFooter>
  </DialogContent></Dialog>
}

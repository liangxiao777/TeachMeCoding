import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillDetails, SkillUpdate } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'

export function SkillDetailsDialog({ filePath, checkInitially, finalFocus, onClose, onUpdated }: {
  filePath: string; checkInitially: boolean; finalFocus: () => HTMLElement | null;
  onClose: () => void; onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const entryFile = filePath.split(/[\\/]/).at(-1) ?? 'SKILL.md'
  const [details, setDetails] = useState<SkillDetails | null>(null)
  const [file, setFile] = useState(entryFile)
  const [content, setContent] = useState('')
  const [error, setError] = useState<Error | UiNotice | null>(null)
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
      setError(null); setDetails(result); setFile(entryFile); setContent(result.content)
      return true
    } catch (error) {
      if (current === selection.current) setError(error instanceof Error ? error : notice('settings', 'errors.loadSkill'))
      return false
    }
  }
  const check = async () => {
    setBusy(true); setError(null); setUpdate(null)
    try { setUpdate(await api<SkillUpdate>('/settings/skills/check', { filePath })) }
    catch (error) { setError(error instanceof Error ? error : notice('settings', 'errors.checkSkill')) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    void load().then((loaded) => { if (loaded && checkInitially) void check() })
    return () => { selection.current++ }
  }, [filePath])
  const select = async (name: string) => {
    const current = ++selection.current
    setFile(name); setLoadingFile(true); setError(null); setContent('')
    try {
      const result = await api<{ content: string }>(`/settings/skills/file?${query}&name=${encodeURIComponent(name)}`)
      if (current === selection.current) setContent(result.content)
    } catch (error) { if (current === selection.current) setError(error instanceof Error ? error : notice('settings', 'errors.previewSkill')) }
    finally { if (current === selection.current) setLoadingFile(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogContent finalFocus={finalFocus} showCloseButton={!busy}
    className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
    <DialogHeader className="pr-6"><DialogTitle className="break-all">{details?.name ?? t('skillDetails.title')}</DialogTitle>
      <DialogDescription className="break-all">{details?.installation?.source ?? t('skillDetails.local')}</DialogDescription></DialogHeader>
    {error && <Alert variant="destructive"><AlertDescription>{formatNotice(error)}{!details && <Button variant="outline" size="sm" onClick={() => void load()}>{t('actions.retry')}</Button>}</AlertDescription></Alert>}
    {busy && <div role="status" className="flex items-center gap-2 text-sm"><Spinner />{update ? t('skillDetails.updating') : t('skillDetails.checking')}</div>}
    {update && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
      <span>{update.modified ? t('skillDetails.modified') : update.available ? t('skillDetails.available') : t('skillDetails.upToDate')}</span>
      {update.available && !update.modified && <Button size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError(null)
        void api<SkillUpdate>('/settings/skills/update', { filePath }).then(async () => {
          setUpdate({ filePath, available: false, modified: false }); await load(); await onUpdated()
        }).catch((error) => setError(error instanceof Error ? error : notice('settings', 'errors.updateSkill'))).finally(() => setBusy(false))
      }}>{t('skillDetails.update')}</Button>}
    </div>}
    {details ? <>
      <p className="break-all text-xs text-muted-foreground">{details.filePath}{details.installation?.ref && ` · ${details.installation.ref}`}</p>
      <Select value={file} onValueChange={(value) => { if (value) void select(value) }} disabled={busy}>
        <SelectTrigger aria-label={t('skillDetails.file')} className="w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>{details.files.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent>
      </Select>
      {loadingFile ? <div role="status" className="flex items-center gap-2 p-4"><Spinner />{t('skillDetails.loadingFile')}</div> :
        <pre aria-label={t('skillDetails.content')} className="min-h-32 min-w-0 overflow-y-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{content}</pre>}
    </> : !error && <div role="status" className="flex items-center gap-2"><Spinner />{t('skillDetails.loading')}</div>}
    <DialogFooter className="mt-auto shrink-0">{details?.installation && <Button variant="outline" disabled={busy} onClick={() => void check()}>{t('skills.checkUpdates')}</Button>}
      <Button variant="outline" disabled={busy} onClick={onClose}>{t('actions.close')}</Button></DialogFooter>
  </DialogContent></Dialog>
}

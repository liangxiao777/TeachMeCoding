import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, Ellipsis, FileText, FolderOpen, Library, RotateCw, Search, Trash2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LibraryDocument, LibraryState } from '@teach-me-coding/contracts'
import { api, downloadLibraryFile, uploadLibraryFile } from '@/lib/api'
import { formatDate, formatNumber } from '@/i18n/format'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
import { useEscape } from '@/app/escape'
import { ThemeToggle } from '@/app/theme'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'

const message = (error: unknown) => error instanceof Error ? error : notice('library', 'errors.actionFailed')

export const LibraryNavigation = createContext<(() => void) | null>(null)
export function LibraryButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useTranslation('library')
  const open = useContext(LibraryNavigation)
  if (!open) return null
  return <Button variant="ghost" size={iconOnly ? 'icon-sm' : 'sm'} aria-label={t('title')} title={t('title')} onClick={open}>
    <Library />{!iconOnly && <span className="max-sm:hidden">{t('title')}</span>}
  </Button>
}

export function LibraryPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('library')
  const [library, setLibrary] = useState<LibraryState | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<Error | UiNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ index: number; total: number; name: string } | null>(null)
  const [pending, setPending] = useState<File[]>([])
  const [removing, setRemoving] = useState<LibraryDocument | null>(null)
  const [dialogError, setDialogError] = useState<Error | UiNotice | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const uploadButton = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const revision = useRef(0)
  const size = (bytes: number) => bytes < 1024 ? t('size.bytes', { value: formatNumber(bytes) })
    : bytes < 1024 * 1024 ? t('size.kilobytes', { value: formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
      : t('size.megabytes', { value: formatNumber(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
  const load = async () => {
    const current = ++revision.current
    try {
      const value = await api<LibraryState>('/library')
      if (current === revision.current) { setLibrary(value); setError(null) }
    } catch (error) { if (current === revision.current) setError(message(error)) }
  }
  useEffect(() => { title.current?.focus(); void load(); return () => { revision.current++ } }, [])
  useEscape(onBack, { capture: true, ignoreFields: true })
  const write = async (path: string, input: unknown) => {
    revision.current++; setBusy(true)
    try { setLibrary(await api<LibraryState>(path, input)) }
    finally { revision.current++; setBusy(false) }
  }
  const upload = async (files: File[]) => {
    if (!library || busy || !files.length) return
    if (files.some((file) => file.size > library.maxFileBytes)) { setError(notice('library', 'errors.fileTooLarge')); return }
    revision.current++; setBusy(true); setError(null); setPending(files)
    try {
      for (const [index, file] of files.entries()) {
        setProgress({ index: index + 1, total: files.length, name: file.name })
        const saved = await uploadLibraryFile(file)
        setLibrary((current) => current && { ...current, files: [saved, ...current.files.filter((item) => item.id !== saved.id)] })
        setPending((current) => current.filter((item) => item !== file))
      }
    } catch (error) { setError(message(error)) }
    finally { revision.current++; setBusy(false); setProgress(null) }
  }
  const visible = library?.files.filter((file) => file.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  return <section aria-label={t('title')} className="fixed inset-0 z-40 flex h-dvh min-w-0 flex-col bg-background text-foreground">
    <header className="shrink-0 border-b"><div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 md:px-6">
      <Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" />{t('back')}</Button>
      <div className="ml-auto"><ThemeToggle /></div>
    </div></header>
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-6 md:py-10"><div className="mx-auto flex max-w-4xl flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-col gap-2"><h1 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p></div>
      <Button ref={uploadButton} disabled={!library || busy} onClick={() => picker.current?.click()}><Upload />{t('upload')}</Button>
      <input ref={picker} type="file" multiple className="hidden" aria-label={t('chooseFiles')} onChange={(event) => {
        const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files)
      }} />
    </div>
    <p className="text-sm text-muted-foreground">{t('fileRequirements')}</p>
    {error && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words">{formatNotice(error)}</span>
      {!library && <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>}
      {!!pending.length && !busy && <Button variant="outline" size="sm" onClick={() => void upload(pending)}>{t('retryUpload')}</Button>}
    </AlertDescription></Alert>}
    {progress && <p role="status" className="flex items-center gap-2 text-sm"><Spinner /><span className="min-w-0 break-all">{t('uploadProgress', { index: formatNumber(progress.index), total: formatNumber(progress.total), name: progress.name })}</span></p>}
    {!library ? !error && <p role="status" className="flex items-center gap-2 text-sm"><Spinner />{t('loading')}</p> : <>
      <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input aria-label={t('filter')} placeholder={t('searchPlaceholder')} className="pl-9" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <Button variant="outline" size="icon" aria-label={t('refresh')} disabled={busy} onClick={() => void load()}><RotateCw /></Button>
        <p className="shrink-0 pl-2 text-sm text-muted-foreground">{t('fileCount', { count: library.files.length, formattedCount: formatNumber(library.files.length) })}</p>
      </div>
      <div className="flex flex-col gap-3">
        {!visible.length ? <Empty className="border py-12"><EmptyHeader><EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
          <EmptyTitle>{library.files.length ? t('noMatch') : t('empty')}</EmptyTitle>
          <EmptyDescription>{library.files.length ? t('tryFilename') : t('emptyDescription')}</EmptyDescription>
        </EmptyHeader></Empty> : <ItemGroup role="list" aria-label={t('files')} className="gap-0! overflow-hidden rounded-xl border">
          {visible.map((file) => <Item key={file.id} role="listitem" aria-label={file.name} className="flex-nowrap rounded-none border-0 border-border p-4 not-last:border-b">
            <ItemMedia variant="icon" className="hidden size-10 rounded-lg bg-muted sm:flex"><FileText className="size-5" /></ItemMedia>
            <ItemContent className="min-w-0 gap-1.5"><ItemTitle className="line-clamp-none max-w-full break-all"><h3>{file.name}</h3></ItemTitle>
              <p className="text-xs text-muted-foreground">{size(file.size)} · {formatDate(new Date(file.createdAt), { year: 'numeric', month: 'numeric', day: 'numeric' })}</p></ItemContent>
            <ItemActions className="shrink-0"><DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('moreActions', { name: file.name })} disabled={busy} />}><Ellipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => {
                  setBusy(true); setError(null); void downloadLibraryFile(file).catch((error) => setError(message(error))).finally(() => setBusy(false))
                }}><Download />{t('download')}</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => { setDialogError(null); setRemoving(file) }}><Trash2 />{t('delete')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </ItemActions>
          </Item>)}
        </ItemGroup>}
      </div>
    </>}
    </div></main>
    {removing && <Dialog open onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}><DialogContent finalFocus={() => uploadButton.current} showCloseButton={!busy}>
      <DialogHeader><DialogTitle className="break-all">{t('deleteTitle', { name: removing.name })}</DialogTitle><DialogDescription>{t('deleteDescription')}</DialogDescription></DialogHeader>
      {dialogError && <Alert variant="destructive"><AlertDescription>{formatNotice(dialogError)}</AlertDescription></Alert>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</Button>
        <Button variant="destructive" disabled={busy} onClick={() => { setDialogError(null); void write(`/library/files/${removing.id}/delete`, {}).then(() => setRemoving(null)).catch((error) => setDialogError(message(error))) }}>{busy && <Spinner />}{t('deleteFile')}</Button>
      </DialogFooter>
    </DialogContent></Dialog>}
  </section>
}

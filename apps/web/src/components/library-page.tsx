import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, Ellipsis, FileText, FolderOpen, Library, RotateCw, Search, Trash2, Upload } from 'lucide-react'
import type { LibraryDocument, LibraryState } from '@teach-me-coding/contracts'
import { api, downloadLibraryFile, uploadLibraryFile } from '@/lib/api'
import { ThemeToggle } from '@/app/theme'
import { Brand } from '@/components/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'

const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const LibraryNavigation = createContext<(() => void) | null>(null)
export function LibraryButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const open = useContext(LibraryNavigation)
  if (!open) return null
  return <Button variant="ghost" size={iconOnly ? 'icon-sm' : 'sm'} aria-label="资料库" title="资料库" onClick={open}>
    <Library />{!iconOnly && <span className="max-sm:hidden">资料库</span>}
  </Button>
}

export function LibraryPage({ onBack }: { onBack: () => void }) {
  const [library, setLibrary] = useState<LibraryState | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const [removing, setRemoving] = useState<LibraryDocument | null>(null)
  const [dialogError, setDialogError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const uploadButton = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const revision = useRef(0)
  const load = async () => {
    const current = ++revision.current
    try {
      const value = await api<LibraryState>('/library')
      if (current === revision.current) { setLibrary(value); setError('') }
    } catch (error) { if (current === revision.current) setError(message(error)) }
  }
  useEffect(() => { title.current?.focus(); void load(); return () => { revision.current++ } }, [])
  const write = async (path: string, input: unknown) => {
    revision.current++; setBusy(true)
    try { setLibrary(await api<LibraryState>(path, input)) }
    finally { revision.current++; setBusy(false) }
  }
  const upload = async (files: File[]) => {
    if (!library || busy || !files.length) return
    if (files.some((file) => file.size > library.maxFileBytes)) { setError('单个文件不能超过 100 MB。'); return }
    revision.current++; setBusy(true); setError(''); setPending(files)
    try {
      for (const [index, file] of files.entries()) {
        setProgress(`正在上传 ${index + 1}/${files.length}：${file.name}`)
        const saved = await uploadLibraryFile(file)
        setLibrary((current) => current && { ...current, files: [saved, ...current.files.filter((item) => item.id !== saved.id)] })
        setPending((current) => current.filter((item) => item !== file))
      }
    } catch (error) { setError(message(error)) }
    finally { revision.current++; setBusy(false); setProgress('') }
  }
  const visible = library?.files.filter((file) => file.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  return <section aria-label="资料库" className="fixed inset-0 z-40 flex h-dvh min-w-0 flex-col bg-background text-foreground">
    <header className="shrink-0 border-b"><div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 md:px-6">
      <Brand /><Button variant="outline" className="ml-auto" onClick={onBack}><ArrowLeft />返回学习</Button><ThemeToggle />
    </div></header>
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-6 md:py-10"><div className="mx-auto flex max-w-4xl flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-col gap-2"><h1 ref={title} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">资料库</h1>
        <p className="text-sm text-muted-foreground">上传自己的资料，供所有学习空间的 Agent 按需读取。</p></div>
      <Button ref={uploadButton} disabled={!library || busy} onClick={() => picker.current?.click()}><Upload />上传文件</Button>
      <input ref={picker} type="file" multiple className="hidden" aria-label="选择资料文件" onChange={(event) => {
        const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files)
      }} />
    </div>
    <p className="text-sm text-muted-foreground">不限格式 · 单个文件最多 100 MB · 原文件保存在本机</p>
    {error && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words">{error}</span>
      {!library && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}
      {!!pending.length && !busy && <Button variant="outline" size="sm" onClick={() => void upload(pending)}>重试上传</Button>}
    </AlertDescription></Alert>}
    {progress && <p role="status" className="flex items-center gap-2 text-sm"><Spinner /><span className="min-w-0 break-all">{progress}</span></p>}
    {!library ? !error && <p role="status" className="flex items-center gap-2 text-sm"><Spinner />正在读取资料库…</p> : <>
      <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input aria-label="筛选资料" placeholder="按文件名查找" className="pl-9" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
        <Button variant="outline" size="icon" aria-label="刷新资料库" disabled={busy} onClick={() => void load()}><RotateCw /></Button>
        <p className="shrink-0 pl-2 text-sm text-muted-foreground">{library.files.length} 个文件</p>
      </div>
      <div className="flex flex-col gap-3">
        {!visible.length ? <Empty className="border py-12"><EmptyHeader><EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
          <EmptyTitle>{library.files.length ? '没有匹配的资料' : '还没有资料'}</EmptyTitle>
          <EmptyDescription>{library.files.length ? '换个文件名试试。' : '上传课程、笔记或参考文档，然后在对话中告诉 Agent 要参考哪份资料。'}</EmptyDescription>
        </EmptyHeader></Empty> : <ItemGroup role="list" aria-label="资料文件" className="gap-0! overflow-hidden rounded-xl border">
          {visible.map((file) => <Item key={file.id} role="listitem" aria-label={file.name} className="flex-nowrap rounded-none border-0 border-border p-4 not-last:border-b">
            <ItemMedia variant="icon" className="hidden size-10 rounded-lg bg-muted sm:flex"><FileText className="size-5" /></ItemMedia>
            <ItemContent className="min-w-0 gap-1.5"><ItemTitle className="line-clamp-none max-w-full break-all"><h3>{file.name}</h3></ItemTitle>
              <p className="text-xs text-muted-foreground">{size(file.size)} · {new Date(file.createdAt).toLocaleDateString()}</p></ItemContent>
            <ItemActions className="shrink-0"><DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`更多操作 ${file.name}`} disabled={busy} />}><Ellipsis /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => {
                  setBusy(true); setError(''); void downloadLibraryFile(file).catch((error) => setError(message(error))).finally(() => setBusy(false))
                }}><Download />下载</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => { setDialogError(''); setRemoving(file) }}><Trash2 />删除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </ItemActions>
          </Item>)}
        </ItemGroup>}
      </div>
    </>}
    </div></main>
    {removing && <Dialog open onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}><DialogContent finalFocus={() => uploadButton.current} showCloseButton={!busy}>
      <DialogHeader><DialogTitle className="break-all">删除 {removing.name}？</DialogTitle><DialogDescription>会删除资料库中的原文件，删除后无法恢复，所有学习空间都将无法再读取它。已发送给模型的内容不会撤回。</DialogDescription></DialogHeader>
      {dialogError && <Alert variant="destructive"><AlertDescription>{dialogError}</AlertDescription></Alert>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
        <Button variant="destructive" disabled={busy} onClick={() => { setDialogError(''); void write(`/library/files/${removing.id}/delete`, {}).then(() => setRemoving(null)).catch((error) => setDialogError(message(error))) }}>{busy && <Spinner />}删除文件</Button>
      </DialogFooter>
    </DialogContent></Dialog>}
  </section>
}

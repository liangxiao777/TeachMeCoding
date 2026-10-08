'use client'

import { ChevronLeft, ChevronRight, FileText, Maximize2, Pencil, Save, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { QuestionAnswer, QuestionRound, ResearchDossier, ResearchRef } from '@teach-me-coding/contracts'
import { useApp } from '@/app/context'
import { useUnsavedWarning } from '@/app/request-state'
import { RichText } from '@/components/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

type AnswerDraft = { optionIds: string[]; customText: string; other: boolean }

/** Only persisted rounds are interactive; streaming tool input is never a form. */
export function QuestionRoundCard({ round, disabled, onAnswer }: {
  round: QuestionRound
  disabled: boolean
  onAnswer: (round: string, input: QuestionAnswer) => Promise<boolean>
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const sendingRef = useRef(false)
  const draftFor = (id: string): AnswerDraft => drafts[id] ?? { optionIds: [], customText: '', other: false }
  const edit = (id: string, patch: Partial<AnswerDraft>) => setDrafts((old) => ({ ...old,
    [id]: { optionIds: [], customText: '', other: false, ...old[id], ...patch } }))
  const question = round.questions[questionIndex]!
  const draft = draftFor(question.id), otherId = `question-${question.id}-other`
  const complete = round.questions.every((question) => {
    const draft = draftFor(question.id)
    return (!draft.other || !!draft.customText.trim()) && (draft.optionIds.length > 0 || draft.other && !!draft.customText.trim())
  })
  const submit = async () => {
    if (disabled || sendingRef.current || !complete || round.state !== 'pending') return
    const answers = round.questions.map((question) => {
      const draft = draftFor(question.id)
      return { questionId: question.id, optionIds: [...draft.optionIds], customText: draft.other ? draft.customText.trim() : '' }
    })
    sendingRef.current = true; setSending(true); setError('')
    try {
      if (!await onAnswer(round.id, { answers })) setError('答案提交未确认，输入已保留。请重试，或在会话中继续说明。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '答案未保存，请重试。')
    } finally { sendingRef.current = false; setSending(false) }
  }
  const browsingDisabled = round.state === 'pending' && (disabled || sending)
  const navigation = round.questions.length > 1 && (
    <nav aria-label="问题切换" className="flex items-center justify-between gap-3 border-t pt-4">
      <Button type="button" variant="outline" size="sm" className="h-11 px-3 sm:h-8"
        disabled={browsingDisabled || questionIndex === 0} onClick={() => setQuestionIndex(questionIndex - 1)}>
        <ChevronLeft aria-hidden />上一个
      </Button>
      <span role="status" className="text-xs tabular-nums text-muted-foreground">
        问题 {questionIndex + 1} / {round.questions.length}
        <span className="sr-only">：{question.prompt}</span>
      </span>
      <Button type="button" variant="outline" size="sm" className="h-11 px-3 sm:h-8"
        disabled={browsingDisabled || questionIndex === round.questions.length - 1} onClick={() => setQuestionIndex(questionIndex + 1)}>
        下一个<ChevronRight aria-hidden />
      </Button>
    </nav>
  )

  if (round.state !== 'pending') {
    const answer = round.answers?.find((item) => item.questionId === question.id)
    return (
      <details className="min-w-0 rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">确认问题 · {round.state === 'answered' ? '已回答' : '已取代'} · 查看原始问答</summary>
        <div className="mt-4 space-y-5">
          <div key={question.id} className="space-y-2">
            <p className="whitespace-pre-wrap break-words font-medium">{question.prompt} <span className="text-xs text-muted-foreground">（{question.multiple ? '多选' : '单选'}）</span></p>
            <ul className="space-y-1 text-muted-foreground">
              {question.options.map((option) => <li key={option.id} className="whitespace-pre-wrap break-words">
                {answer?.optionIds.includes(option.id) ? '✓ ' : '· '}{option.label}{option.description && ` — ${option.description}`}
              </li>)}
            </ul>
            {answer ? <div className="space-y-1">
              <p className="whitespace-pre-wrap break-words">已选：{question.options.filter((option) => answer.optionIds.includes(option.id)).map((option) => option.label).join('；') || '无（自定义回答）'}</p>
              {answer.customText && <p className="whitespace-pre-wrap break-words">其他（自定义）：{answer.customText}</p>}
            </div> : <p className="text-xs text-muted-foreground">未提交答案；此轮已由后续需求或问题取代。</p>}
          </div>
          {navigation}
        </div>
      </details>
    )
  }

  return (
    <Card size="sm" className="min-w-0 border ring-primary/20">
      <CardHeader>
        <CardTitle className="text-sm">待确认问题</CardTitle>
        <CardDescription>逐个回答，完成后统一提交；也可以在下方输入框继续对话。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <fieldset key={question.id} disabled={disabled || sending} className="min-w-0 space-y-2">
            <legend className="mb-2 whitespace-pre-wrap break-words text-sm font-medium">{question.prompt}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{question.multiple ? '多选，可加自定义' : '单选，或自定义'}</span>
            </legend>
            {question.options.map((option) => <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
              <input className="mt-1 shrink-0 accent-primary" type={question.multiple ? 'checkbox' : 'radio'}
                name={`question-${question.id}`} value={option.id} checked={draft.optionIds.includes(option.id)}
                onChange={(event) => edit(question.id, question.multiple
                  ? { optionIds: event.target.checked ? [...draft.optionIds, option.id] : draft.optionIds.filter((id) => id !== option.id) }
                  : { optionIds: [option.id], other: false })} />
              <span className="min-w-0 whitespace-pre-wrap break-words">{option.label}
                {option.description && <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </label>)}
            <label htmlFor={otherId} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <input id={otherId} className="shrink-0 accent-primary" type={question.multiple ? 'checkbox' : 'radio'}
                name={`question-${question.id}`} value="other" checked={draft.other}
                onChange={(event) => edit(question.id, { other: event.target.checked, ...(!question.multiple ? { optionIds: [] } : {}) })} />
              其他（Other，自定义回答）
            </label>
            {draft.other && <Field className="gap-3 pt-2">
              <FieldLabel htmlFor={`${otherId}-text`}>填写自定义回答</FieldLabel>
              <Textarea id={`${otherId}-text`} rows={2} maxLength={10_000} required value={draft.customText}
                onChange={(event) => edit(question.id, { customText: event.target.value })} className="resize-y leading-relaxed" />
            </Field>}
          </fieldset>
          {navigation}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={disabled || sending || !complete}>{sending ? '提交中…' : '提交全部回答'}</Button>
        </form>
      </CardContent>
    </Card>
  )
}

// Keep untrusted document links away from credentials, local/private addresses
// and non-web schemes. The Markdown renderer sanitizes raw HTML separately.
function publicSourceUrl(value: string): string | null {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.')
      || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return null
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a = 0, b = 0, c = 0] = host.split('.').map(Number)
      if ([0, 10, 127].includes(a) || a >= 224 || a === 100 && b >= 64 && b <= 127
        || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
        || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
        || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
        || a === 203 && b === 0 && c === 113) return null
    }
    return url.href
  } catch { return null }
}

function ResearchMarkdown({ content }: { content: string }) {
  return <RichText text={content} components={{
    a: ({ href, children }) => {
      const url = publicSourceUrl(href ?? '')
      return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{children}</a> : <span>{children}</span>
    },
    img: ({ alt }) => <span className="text-muted-foreground">{alt || '图片'}</span>,
  }} />
}

export function ResearchCard({ researchRef }: { researchRef: ResearchRef }) {
  const { persistence } = useApp()
  const contentId = useId()
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [dossier, setDossier] = useState<ResearchDossier | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [closeRequested, setCloseRequested] = useState(false)
  const [exportError, setExportError] = useState('')
  const savingRef = useRef(false)
  const currentRef = useRef(researchRef)
  currentRef.current = researchRef
  const dirty = editing && !!dossier && content !== dossier.content
  useUnsavedWarning(dirty || saving)
  const load = async () => {
    if (!persistence || loading) return
    const ref = researchRef
    setLoading(true); setError('')
    try {
      const saved = await persistence.loadResearch(ref)
      if (saved.id !== ref.id || saved.revision !== ref.revision) throw new Error('资料版本不匹配，请重新读取。')
      if (currentRef.current.id !== ref.id || currentRef.current.revision !== ref.revision) return
      setDossier(saved); setContent(saved.content)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '资料读取失败，请重试。') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    if ((open || fullscreen) && !editing && !saving && !loading && !error
      && (!dossier || dossier.revision !== researchRef.revision)) void load()
  }, [open, fullscreen, editing, saving, loading, error, researchRef.revision, dossier?.revision])
  const cancelEditing = () => {
    setContent(dossier?.content ?? ''); setEditing(false); setCloseRequested(false); setSaveError('')
  }
  const close = () => {
    if (savingRef.current) return
    if (dirty) { setCloseRequested(true); return }
    cancelEditing(); setFullscreen(false)
  }
  const save = async () => {
    if (!persistence || !dossier || savingRef.current || !dirty || !content.trim()) return
    savingRef.current = true; setSaving(true); setSaveError(''); setSavedMessage('')
    try {
      const document = await persistence.saveResearch({ id: dossier.id, revision: dossier.revision }, content)
      setDossier(document); setContent(document.content); setEditing(false); setCloseRequested(false)
      setSavedMessage(`已保存 · 修订 ${document.revision}`)
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : '修改未保存，请重试。') }
    finally { savingRef.current = false; setSaving(false) }
  }
  const download = async () => {
    if (!persistence || exporting) return
    setExporting(true); setExportError('')
    try { await persistence.exportResearch(researchRef) }
    catch (cause) { setExportError(cause instanceof Error ? cause.message : '资料导出失败，请重试。') }
    finally { setExporting(false) }
  }

  return (
    <Dialog open={fullscreen} onOpenChange={(next) => {
      if (!next) close()
      else { setFullscreen(true); setMode('preview'); setSavedMessage(''); setSaveError('') }
    }}>
    <section className="mt-5 min-w-0 space-y-3 border-t pt-4" aria-label="固定版本调研资料">
      <p className="text-xs text-muted-foreground">调研资料 · 修订 {researchRef.revision}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-expanded={open} aria-controls={contentId} onClick={() => {
          setOpen(!open)
        }}>{open ? '收起资料' : '查看固定版本资料'}</Button>
        <DialogTrigger render={<Button size="sm" variant="outline" />}><Maximize2 aria-hidden />全屏预览</DialogTrigger>
        <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void download()}>{exporting ? '导出中…' : '导出 Markdown'}</Button>
      </div>
      {exportError && <p role="alert" className="text-xs text-destructive">{exportError}</p>}
      <div id={contentId} hidden={!open} className="space-y-4 text-sm">
        {loading && <p role="status" className="text-muted-foreground">正在读取固定版本资料…</p>}
        {error && <div className="space-y-2"><p role="alert" className="text-destructive">{error}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>重试读取</Button></div>}
        {dossier && <>
          <p className="text-xs text-muted-foreground">整理时间：{new Date(dossier.createdAt).toLocaleString()}</p>
          <ResearchMarkdown content={dossier.content} />
        </>}
      </div>
    </section>
    <DialogContent showCloseButton={false}
      overlayClassName="bg-black/20 backdrop-blur-md supports-backdrop-filter:backdrop-blur-md"
      className="flex h-[88dvh] max-h-[960px] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-[1100px]">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-5">
        <div className="min-w-0 space-y-2">
          <DialogTitle className="flex items-center gap-2 text-lg"><FileText className="size-5 text-primary" aria-hidden />调研资料预览</DialogTitle>
          <DialogDescription className="truncate">{dossier ? `${dossier.target.name} · 修订 ${dossier.revision} · Markdown` : '当前学习空间的 Markdown 调研资料'}</DialogDescription>
        </div>
        <Button variant="ghost" size="icon" disabled={saving} aria-label="关闭资料预览" onClick={close}><X aria-hidden /></Button>
      </header>
      {loading && <p role="status" className="px-6 py-4 text-muted-foreground">正在读取固定版本资料…</p>}
      {error && <div className="space-y-3 px-6 py-4"><p role="alert" className="text-destructive">{error}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>重试读取</Button></div>}
      {dossier && <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-6 py-3">
          <TabsList aria-label="Markdown 显示模式" className="h-9">
            <TabsTrigger value="preview" className="px-4">渲染预览</TabsTrigger>
            <TabsTrigger value="source" className="px-4">Markdown 原文</TabsTrigger>
          </TabsList>
          <span role="status" className="text-xs text-muted-foreground">{dirty ? '有未保存的修改' : editing ? '正在编辑原文' : '固定版本资料'}</span>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-y-auto overscroll-contain bg-background px-6 py-8 sm:px-12">
          <div className="mx-auto max-w-3xl"><ResearchMarkdown content={content} /></div>
        </TabsContent>
        <TabsContent value="source" className="min-h-0 overflow-hidden bg-background p-4 sm:p-6">
          <label htmlFor={`${contentId}-source`} className="sr-only">Markdown 原文内容</label>
          <Textarea id={`${contentId}-source`} value={content} readOnly={!editing} disabled={saving} spellCheck={false} wrap="off"
            onChange={(event) => { setContent(event.target.value); setSavedMessage(''); setCloseRequested(false) }}
            className="h-full min-h-0 resize-none rounded-xl bg-muted/20 p-5 font-mono text-sm leading-7 shadow-none" />
        </TabsContent>
      </Tabs>}
      <footer className="mt-auto shrink-0 space-y-3 border-t bg-muted/20 px-6 py-4">
        {saveError && <p role="alert" className="text-sm text-destructive">{saveError} 输入已保留。</p>}
        {closeRequested && dirty ? <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-sm">有未保存的修改，是否放弃并关闭？</p>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setCloseRequested(false)}>继续编辑</Button>
            <Button variant="destructive" size="sm" onClick={() => { cancelEditing(); setFullscreen(false) }}>放弃并关闭</Button></div>
        </div> : <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 text-xs text-muted-foreground">
            {savedMessage && <p role="status" className="font-medium text-foreground">{savedMessage}</p>}
            <p>保存会创建新修订，学习需求需重新确认；已有路线与课件保持原修订。</p>
          </div>
          <div className="flex gap-2">
            {editing ? <>
              <Button variant="outline" size="sm" disabled={saving} onClick={cancelEditing}>取消编辑</Button>
              <Button size="sm" disabled={saving || !dirty || !content.trim()} onClick={() => void save()}><Save aria-hidden />{saving ? '保存中…' : '保存修改'}</Button>
            </> : <Button size="sm" disabled={!dossier || loading} onClick={() => { setEditing(true); setMode('source'); setSavedMessage(''); setSaveError('') }}><Pencil aria-hidden />编辑</Button>}
          </div>
        </div>}
      </footer>
    </DialogContent>
    </Dialog>
  )
}

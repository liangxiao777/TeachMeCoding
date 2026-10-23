'use client'

import { ChevronLeft, ChevronRight, FileText, Maximize2, Pencil, Save, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/i18n/format'
import { formatNotice, notice, type NoticeValue } from '@/i18n/notice'
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
  const { t } = useTranslation('learning')
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<NoticeValue>(null)
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
    sendingRef.current = true; setSending(true); setError(null)
    try {
      if (!await onAnswer(round.id, { answers })) setError(notice('learning', 'questions.unconfirmed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause : notice('learning', 'questions.saveFailed'))
    } finally { sendingRef.current = false; setSending(false) }
  }
  const browsingDisabled = round.state === 'pending' && (disabled || sending)
  const navigation = round.questions.length > 1 && (
    <nav aria-label={t('questions.navigation')} className="flex items-center justify-between gap-3 border-t pt-4">
      <Button type="button" variant="outline" size="sm" className="h-11 px-3 sm:h-8"
        disabled={browsingDisabled || questionIndex === 0} onClick={() => setQuestionIndex(questionIndex - 1)}>
        <ChevronLeft aria-hidden />{t('questions.previous')}
      </Button>
      <span role="status" className="text-xs tabular-nums text-muted-foreground">
        {t('questions.position', { current: questionIndex + 1, total: round.questions.length })}
        <span className="sr-only">：{question.prompt}</span>
      </span>
      <Button type="button" variant="outline" size="sm" className="h-11 px-3 sm:h-8"
        disabled={browsingDisabled || questionIndex === round.questions.length - 1} onClick={() => setQuestionIndex(questionIndex + 1)}>
        {t('questions.next')}<ChevronRight aria-hidden />
      </Button>
    </nav>
  )

  if (round.state !== 'pending') {
    const answer = round.answers?.find((item) => item.questionId === question.id)
    return (
      <details className="min-w-0 rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">{round.state === 'answered' ? t('questions.answeredSummary') : t('questions.supersededSummary')}</summary>
        <div className="mt-4 space-y-5">
          <div key={question.id} className="space-y-2">
            <p className="whitespace-pre-wrap break-words font-medium">{question.prompt} <span className="text-xs text-muted-foreground">{question.multiple ? t('questions.multiple') : t('questions.single')}</span></p>
            <ul className="space-y-1 text-muted-foreground">
              {question.options.map((option) => <li key={option.id} className="whitespace-pre-wrap break-words">
                {answer?.optionIds.includes(option.id) ? '✓ ' : '· '}{option.label}{option.description && ` — ${option.description}`}
              </li>)}
            </ul>
            {answer ? <div className="space-y-1">
              <p className="whitespace-pre-wrap break-words">{t('questions.selected', { answers: question.options.filter((option) => answer.optionIds.includes(option.id)).map((option) => option.label).join(t('questions.separator')) || t('questions.customOnly') })}</p>
              {answer.customText && <p className="whitespace-pre-wrap break-words">{t('questions.customAnswer', { answer: answer.customText })}</p>}
            </div> : <p className="text-xs text-muted-foreground">{t('questions.superseded')}</p>}
          </div>
          {navigation}
        </div>
      </details>
    )
  }

  return (
    <Card size="sm" className="min-w-0 border ring-primary/20">
      <CardHeader>
        <CardTitle className="text-sm">{t('questions.pending')}</CardTitle>
        <CardDescription>{t('questions.instructions')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <fieldset key={question.id} disabled={disabled || sending} className="min-w-0 space-y-2">
            <legend className="mb-2 whitespace-pre-wrap break-words text-sm font-medium">{question.prompt}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{question.multiple ? t('questions.multipleHint') : t('questions.singleHint')}</span>
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
              {t('questions.other')}
            </label>
            {draft.other && <Field className="gap-3 pt-2">
              <FieldLabel htmlFor={`${otherId}-text`}>{t('questions.customLabel')}</FieldLabel>
              <Textarea id={`${otherId}-text`} rows={2} maxLength={10_000} required value={draft.customText}
                onChange={(event) => edit(question.id, { customText: event.target.value })} className="resize-y leading-relaxed" />
            </Field>}
          </fieldset>
          {navigation}
          {!!error && <p role="alert" className="text-xs text-destructive">{formatNotice(error)}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={disabled || sending || !complete}>{sending ? t('questions.submitting') : t('questions.submit')}</Button>
          </div>
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
  const { t } = useTranslation('learning')
  return <RichText text={content} components={{
    a: ({ href, children }) => {
      const url = publicSourceUrl(href ?? '')
      return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{children}</a> : <span>{children}</span>
    },
    img: ({ alt }) => <span className="text-muted-foreground">{alt || t('research.image')}</span>,
  }} />
}

export function ResearchCard({ researchRef }: { researchRef: ResearchRef }) {
  const { t } = useTranslation('learning')
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
  const [error, setError] = useState<NoticeValue>(null)
  const [saveError, setSaveError] = useState<NoticeValue>(null)
  const [savedMessage, setSavedMessage] = useState<NoticeValue>(null)
  const [closeRequested, setCloseRequested] = useState(false)
  const [exportError, setExportError] = useState<NoticeValue>(null)
  const savingRef = useRef(false)
  const currentRef = useRef(researchRef)
  currentRef.current = researchRef
  const dirty = editing && !!dossier && content !== dossier.content
  useUnsavedWarning(dirty || saving)
  const load = async () => {
    if (loading) return
    const ref = researchRef
    setLoading(true); setError(null)
    try {
      const saved = await persistence.loadResearch(ref)
      if (saved.id !== ref.id || saved.revision !== ref.revision) { setError(notice('learning', 'research.versionMismatch')); return }
      if (currentRef.current.id !== ref.id || currentRef.current.revision !== ref.revision) return
      setDossier(saved); setContent(saved.content)
    } catch (cause) { setError(cause instanceof Error ? cause : notice('learning', 'research.loadFailed')) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    if ((open || fullscreen) && !editing && !saving && !loading && !error
      && (!dossier || dossier.revision !== researchRef.revision)) void load()
  }, [open, fullscreen, editing, saving, loading, error, researchRef.revision, dossier?.revision])
  const cancelEditing = () => {
    setContent(dossier?.content ?? ''); setEditing(false); setCloseRequested(false); setSaveError(null)
  }
  const close = () => {
    if (savingRef.current) return
    if (dirty) { setCloseRequested(true); return }
    cancelEditing(); setFullscreen(false)
  }
  const save = async () => {
    if (!dossier || savingRef.current || !dirty || !content.trim()) return
    savingRef.current = true; setSaving(true); setSaveError(null); setSavedMessage(null)
    try {
      const document = await persistence.saveResearch({ id: dossier.id, revision: dossier.revision }, content)
      setDossier(document); setContent(document.content); setEditing(false); setCloseRequested(false)
      setSavedMessage(notice('learning', 'research.saved', { revision: document.revision }))
    } catch (cause) { setSaveError(cause instanceof Error ? cause : notice('learning', 'research.saveFailed')) }
    finally { savingRef.current = false; setSaving(false) }
  }
  const download = async () => {
    if (exporting) return
    setExporting(true); setExportError(null)
    try { await persistence.exportResearch(researchRef) }
    catch (cause) { setExportError(cause instanceof Error ? cause : notice('learning', 'research.exportFailed')) }
    finally { setExporting(false) }
  }

  return (
    <Dialog open={fullscreen} onOpenChange={(next) => {
      if (!next) close()
      else { setFullscreen(true); setMode('preview'); setSavedMessage(null); setSaveError(null) }
    }}>
    <section className="mt-5 min-w-0 space-y-3 border-t pt-4" aria-label={t('research.region')}>
      <p className="text-xs text-muted-foreground">{t('research.revision', { revision: researchRef.revision })}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-expanded={open} aria-controls={contentId} onClick={() => {
          setOpen(!open)
        }}>{open ? t('research.collapse') : t('research.view')}</Button>
        <DialogTrigger render={<Button size="sm" variant="outline" />}><Maximize2 aria-hidden />{t('research.fullscreen')}</DialogTrigger>
        <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void download()}>{exporting ? t('research.exporting') : t('research.export')}</Button>
      </div>
      {!!exportError && <p role="alert" className="text-xs text-destructive">{formatNotice(exportError)}</p>}
      <div id={contentId} hidden={!open} className="space-y-4 text-sm">
        {loading && <p role="status" className="text-muted-foreground">{t('research.loading')}</p>}
        {!!error && <div className="space-y-2"><p role="alert" className="text-destructive">{formatNotice(error)}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>{t('research.retry')}</Button></div>}
        {dossier && <>
          <p className="text-xs text-muted-foreground">{t('research.created', { date: formatDate(dossier.createdAt, { dateStyle: 'short', timeStyle: 'medium' }) })}</p>
          <ResearchMarkdown content={dossier.content} />
        </>}
      </div>
    </section>
    <DialogContent showCloseButton={false}
      overlayClassName="bg-black/20 backdrop-blur-md supports-backdrop-filter:backdrop-blur-md"
      className="flex h-[88dvh] max-h-[960px] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-[1100px]">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-5">
        <div className="min-w-0 space-y-2">
          <DialogTitle className="flex items-center gap-2 text-lg"><FileText className="size-5 text-primary" aria-hidden />{t('research.title')}</DialogTitle>
          <DialogDescription className="truncate">{dossier ? t('research.description', { revision: dossier.revision }) : t('research.fallbackDescription')}</DialogDescription>
        </div>
        <Button variant="ghost" size="icon" disabled={saving} aria-label={t('research.close')} onClick={close}><X aria-hidden /></Button>
      </header>
      {loading && <p role="status" className="px-6 py-4 text-muted-foreground">{t('research.loading')}</p>}
      {!!error && <div className="space-y-3 px-6 py-4"><p role="alert" className="text-destructive">{formatNotice(error)}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>{t('research.retry')}</Button></div>}
      {dossier && <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)} className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-6 py-3">
          <TabsList aria-label={t('research.mode')} className="h-9">
            <TabsTrigger value="preview" className="px-4">{t('research.preview')}</TabsTrigger>
            <TabsTrigger value="source" className="px-4">{t('research.source')}</TabsTrigger>
          </TabsList>
          <span role="status" className="text-xs text-muted-foreground">{dirty ? t('research.dirty') : editing ? t('research.editing') : t('research.fixed')}</span>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-y-auto overscroll-contain bg-background px-6 py-8 sm:px-12">
          <div className="mx-auto max-w-3xl"><ResearchMarkdown content={content} /></div>
        </TabsContent>
        <TabsContent value="source" className="min-h-0 overflow-hidden bg-background p-4 sm:p-6">
          <label htmlFor={`${contentId}-source`} className="sr-only">{t('research.sourceLabel')}</label>
          <Textarea id={`${contentId}-source`} value={content} readOnly={!editing} disabled={saving} spellCheck={false} wrap="off"
            onChange={(event) => { setContent(event.target.value); setSavedMessage(null); setCloseRequested(false) }}
            className="h-full min-h-0 resize-none rounded-xl bg-muted/20 p-5 font-mono text-sm leading-7 shadow-none" />
        </TabsContent>
      </Tabs>}
      <footer className="mt-auto shrink-0 space-y-3 border-t bg-muted/20 px-6 py-4">
        {!!saveError && <p role="alert" className="text-sm text-destructive">{t('research.preservedError', { error: formatNotice(saveError) })}</p>}
        {closeRequested && dirty ? <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-sm">{t('research.discardQuestion')}</p>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setCloseRequested(false)}>{t('research.continueEditing')}</Button>
            <Button variant="destructive" size="sm" onClick={() => { cancelEditing(); setFullscreen(false) }}>{t('research.discard')}</Button></div>
        </div> : <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 text-xs text-muted-foreground">
            {!!savedMessage && <p role="status" className="font-medium text-foreground">{formatNotice(savedMessage)}</p>}
            <p>{t('research.saveHint')}</p>
          </div>
          <div className="flex gap-2">
            {editing ? <>
              <Button variant="outline" size="sm" disabled={saving} onClick={cancelEditing}>{t('research.cancelEdit')}</Button>
              <Button size="sm" disabled={saving || !dirty || !content.trim()} onClick={() => void save()}><Save aria-hidden />{saving ? t('controls.saving') : t('research.saveChanges')}</Button>
            </> : <Button size="sm" disabled={!dossier || loading} onClick={() => { setEditing(true); setMode('source'); setSavedMessage(null); setSaveError(null) }}><Pencil aria-hidden />{t('controls.edit')}</Button>}
          </div>
        </div>}
      </footer>
    </DialogContent>
    </Dialog>
  )
}

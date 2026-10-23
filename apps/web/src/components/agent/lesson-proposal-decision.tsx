import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Check, X } from 'lucide-react'
import type { LessonProposal } from '@teach-me-coding/contracts'
import { useApp, useSpace } from '@/app/context'
import { findUnit } from '@/app/selectors'
import { lessonProposalStale } from '@/app/lesson-proposals'
import { useLessonDrawer } from '@/app/lesson-drawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { YoloSwitch } from './yolo-switch'

/** The decision belongs to the space, never the selected session or lesson. */
export function LessonProposalDecision({ proposal }: { proposal: LessonProposal }) {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { capabilities, persistence } = useApp()
  const { open: lessonOpen } = useLessonDrawer()
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  const unit = findUnit(space, proposal.unitId)
  const previewVisible = !!unit && space.view === 'unit' && space.currentUnitId === proposal.unitId && (!space.ideFullscreen || lessonOpen)
  const busy = submitting || persistence.busy || !persistence.ready
  const stale = lessonProposalStale(proposal, persistence.requirementRevision, persistence.routeRevision,
    persistence.requirementConfirmed, persistence.lessonVersions, !!unit)
  const reject = async () => {
    if (busy || sending.current) return
    sending.current = true; setSubmitting(true)
    try { await persistence.rejectLessonProposal(proposal.id, feedback.trim()) }
    finally { sending.current = false; setSubmitting(false) }
  }
  return <section className="shrink-0 overflow-y-auto border-t bg-background p-4" aria-labelledby={`lesson-decision-${proposal.id}`} data-testid="lesson-decision" data-proposal-id={proposal.id}>
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2"><BookOpen className="size-4" aria-hidden />
        <h2 id={`lesson-decision-${proposal.id}`} className="flex-1 text-sm font-semibold">{rejecting ? t('decision.lessonRejectTitle') : t('decision.lessonTitle')}</h2>
        <YoloSwitch sessionId={proposal.sessionId} /><Badge variant="outline">{t('decision.pending')}</Badge>
      </div>
      <p className="text-sm font-medium break-words">{t('decision.targetUnit', { title: unit?.title ?? proposal.baseLesson.title })}</p>
      {!previewVisible && <Button variant="outline" size="sm" data-testid="lesson-review" disabled={!unit} onClick={() => persistence.reviewLessonProposal(proposal.id)}>{t('decision.reviewLesson')}</Button>}
      {stale && <p role="status" className="text-xs leading-relaxed text-destructive">{t('decision.lessonStale')}</p>}
      {rejecting ? <>
        <label htmlFor={`lesson-feedback-${proposal.id}`} className="text-xs font-medium">{t('decision.feedback')}</label>
        <Textarea id={`lesson-feedback-${proposal.id}`} data-testid="lesson-rejection-feedback" rows={3} maxLength={100_000} value={feedback} disabled={busy}
          onChange={(event) => setFeedback(event.target.value)} placeholder={t('decision.lessonPlaceholder')} className="max-h-40 resize-y text-sm leading-relaxed" />
        <p className="text-xs leading-relaxed text-muted-foreground">{feedback.trim()
          ? capabilities.agent ? t('decision.lessonRetryHint') : t('decision.lessonUnavailableHint')
          : t('decision.noFeedback')}</p>
        <div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(false)}>{t('decision.back')}</Button>
          <Button className="flex-1" disabled={busy} data-testid="lesson-reject-confirm" onClick={() => void reject()}>{t('decision.confirmReject')}</Button></div>
      </> : <>
        <div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={busy} data-testid="lesson-reject" onClick={() => setRejecting(true)}><X data-icon="inline-start" />{t('controls.reject')}</Button>
          <Button className="flex-1" disabled={busy || stale} data-testid="lesson-accept" onClick={() => persistence.applyLessonProposal(proposal.id)}><Check data-icon="inline-start" />{t('decision.acceptLesson')}</Button></div>
      </>}
    </div>
  </section>
}

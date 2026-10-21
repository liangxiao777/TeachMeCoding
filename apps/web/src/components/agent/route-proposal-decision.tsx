import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Route, X } from 'lucide-react'
import type { Proposal } from '@teach-me-coding/contracts'
import { useApp, useSpace } from '@/app/context'
import { diffRoute, routeDiffSummary } from '@/app/route-diff'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { YoloSwitch } from './yolo-switch'

/** One mandatory decision, independent of the currently viewed session. */
export function RouteProposalDecision({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation('workbench')
  const space = useSpace()
  const { capabilities, persistence, setView } = useApp()
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  if (!persistence) return null
  const busy = submitting || persistence.busy || !persistence.ready
  const stale = proposal.baseRevision !== persistence.routeRevision || proposal.requirementRevision !== persistence.requirementRevision || !persistence.requirementConfirmed
  const summary = routeDiffSummary(diffRoute(space.stages.length ? { note: space.routeNote, stages: space.stages } : null, proposal.content))
  const reject = async () => {
    if (busy || sending.current) return
    sending.current = true; setSubmitting(true)
    try { await persistence.rejectProposal(proposal.id, feedback.trim()) }
    finally { sending.current = false; setSubmitting(false) }
  }
  return (
    <section className="shrink-0 border-t bg-background p-4" aria-labelledby={`decision-${proposal.id}`} data-testid="route-decision" data-proposal-id={proposal.id}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Route className="size-4" aria-hidden />
          <h2 id={`decision-${proposal.id}`} className="flex-1 text-sm font-semibold">{rejecting ? t('decision.routeRejectTitle') : t('decision.routeTitle')}</h2>
          <YoloSwitch sessionId={proposal.sessionId} />
          <Badge variant="outline">{t('decision.pending')}</Badge>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
        {space.view !== 'route' && <Button variant="outline" size="sm" onClick={() => setView('route')}>{t('decision.reviewRoute')}</Button>}
        {stale && <p role="status" className="text-xs leading-relaxed text-destructive">{t('decision.routeStale')}</p>}
        {rejecting ? <>
          <label htmlFor={`feedback-${proposal.id}`} className="text-xs font-medium">{t('decision.feedback')}</label>
          <Textarea id={`feedback-${proposal.id}`} rows={4} maxLength={100_000} value={feedback} disabled={busy}
            onChange={(event) => setFeedback(event.target.value)} placeholder={t('decision.routePlaceholder')} className="max-h-48 resize-y text-sm leading-relaxed" />
          <p className="text-xs leading-relaxed text-muted-foreground">{feedback.trim()
            ? capabilities.agent ? t('decision.routeRetryHint') : t('decision.routeUnavailableHint')
            : t('decision.noFeedback')}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(false)}>{t('decision.back')}</Button>
            <Button className="flex-1" disabled={busy} onClick={() => void reject()}>{t('decision.confirmReject')}</Button>
          </div>
        </> : <>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('decision.routeHint')}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(true)}><X data-icon="inline-start" />{t('controls.reject')}</Button>
            <Button className="flex-1" disabled={busy || stale} onClick={() => persistence.applyProposal(proposal.id)}><Check data-icon="inline-start" />{t('agent.confirmRoute')}</Button>
          </div>
        </>}
      </div>
    </section>
  )
}

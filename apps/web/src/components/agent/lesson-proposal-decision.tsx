import { useRef, useState } from 'react'
import { BookOpen, Check, X } from 'lucide-react'
import type { LessonProposal } from '@teach-me-coding/contracts'
import { useApp, useSpace } from '@/app/context'
import { findUnit } from '@/app/selectors'
import { lessonProposalStale } from '@/app/lesson-proposals'
import { useLessonDrawer } from '@/app/lesson-drawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** The decision belongs to the space, never the selected session or lesson. */
export function LessonProposalDecision({ proposal }: { proposal: LessonProposal }) {
  const space = useSpace()
  const { capabilities, persistence } = useApp()
  const { open: lessonOpen } = useLessonDrawer()
  const [rejecting, setRejecting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sending = useRef(false)
  if (!persistence) return null
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
        <h2 id={`lesson-decision-${proposal.id}`} className="flex-1 text-sm font-semibold">{rejecting ? '拒绝课件修改' : '请确认这份课件修改'}</h2><Badge variant="outline">待选择</Badge>
      </div>
      <p className="text-sm font-medium break-words">目标单元：{unit?.title ?? proposal.baseLesson.title}</p>
      {!previewVisible && <Button variant="outline" size="sm" data-testid="lesson-review" disabled={!unit} onClick={() => persistence.reviewLessonProposal(proposal.id)}>查看课件中的变化</Button>}
      {stale && <p role="status" className="text-xs leading-relaxed text-destructive">需求、路线、目标课件或参考版本已变化，不能接受这份提案。请拒绝后重新调整。</p>}
      {rejecting ? <>
        <label htmlFor={`lesson-feedback-${proposal.id}`} className="text-xs font-medium">修改意见（选填）</label>
        <Textarea id={`lesson-feedback-${proposal.id}`} data-testid="lesson-rejection-feedback" rows={3} maxLength={100_000} value={feedback} disabled={busy}
          onChange={(event) => setFeedback(event.target.value)} placeholder="例如：保留现有示例，补充边界情况…" className="max-h-40 resize-y text-sm leading-relaxed" />
        <p className="text-xs leading-relaxed text-muted-foreground">{feedback.trim()
          ? capabilities.agent ? '拒绝后，Agent 会从当前已应用课件重新调整；被拒草稿仅作参考。' : 'Agent 暂不可用。拒绝和修改意见仍会保存；恢复后可重新发起修改。'
          : '不填意见则结束本轮，不会自动生成另一份提案。'}</p>
        <div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(false)}>返回选择</Button>
          <Button className="flex-1" disabled={busy} data-testid="lesson-reject-confirm" onClick={() => void reject()}>确认拒绝</Button></div>
      </> : <>
        <div className="flex gap-2"><Button variant="outline" className="flex-1" disabled={busy} data-testid="lesson-reject" onClick={() => setRejecting(true)}><X data-icon="inline-start" />拒绝</Button>
          <Button className="flex-1" disabled={busy || stale} data-testid="lesson-accept" onClick={() => persistence.applyLessonProposal(proposal.id)}><Check data-icon="inline-start" />接受课件修改</Button></div>
      </>}
    </div>
  </section>
}

import { useRef, useState } from 'react'
import { Check, Route, X } from 'lucide-react'
import type { Proposal } from '@teach-me-coding/contracts'
import { useApp, useSpace } from '@/app/context'
import { diffRoute, routeDiffSummary } from '@/app/route-diff'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** One mandatory decision, independent of the currently viewed session. */
export function RouteProposalDecision({ proposal }: { proposal: Proposal }) {
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
          <h2 id={`decision-${proposal.id}`} className="flex-1 text-sm font-semibold">{rejecting ? '拒绝并说明修改意见' : '请确认这份路线调整'}</h2>
          <Badge variant="outline">待选择</Badge>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{summary}</p>
        {space.view !== 'route' && <Button variant="outline" size="sm" onClick={() => setView('route')}>查看路线中的变化</Button>}
        {stale && <p role="status" className="text-xs leading-relaxed text-destructive">需求或路线已变化，不能接受这份提案。请拒绝后重新调整。</p>}
        {rejecting ? <>
          <label htmlFor={`feedback-${proposal.id}`} className="text-xs font-medium">修改意见（选填）</label>
          <Textarea id={`feedback-${proposal.id}`} rows={4} maxLength={100_000} value={feedback} disabled={busy}
            onChange={(event) => setFeedback(event.target.value)} placeholder="例如：保留前两个单元，把后续项目拆细一些…" className="max-h-48 resize-y text-sm leading-relaxed" />
          <p className="text-xs leading-relaxed text-muted-foreground">{feedback.trim()
            ? capabilities.agent ? '拒绝后，Agent 会根据修改意见，从当前已应用路线重新提出调整。' : 'Agent 暂不可用。拒绝和修改意见仍会保存；恢复后请重新发起路线调整。'
            : '不填意见则结束本轮，不会自动生成另一份提案。'}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(false)}>返回选择</Button>
            <Button className="flex-1" disabled={busy} onClick={() => void reject()}>确认拒绝</Button>
          </div>
        </> : <>
          <p className="text-xs leading-relaxed text-muted-foreground">学习路线中已标出全部变化。接受或拒绝后才能继续对话；原有未发送输入会保留。</p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setRejecting(true)}><X data-icon="inline-start" />拒绝</Button>
            <Button className="flex-1" disabled={busy || stale} onClick={() => persistence.applyProposal(proposal.id)}><Check data-icon="inline-start" />确认调整路线</Button>
          </div>
        </>}
      </div>
    </section>
  )
}

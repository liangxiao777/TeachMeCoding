import type { ActionProposal } from '@teach-me-coding/contracts'
import type { Quote, Session } from '../app/types'
import i18n from './index'
import { formatNotice } from './notice'

export function sessionTitle(session: Pick<Session, 'title' | 'scope'>, primary = true): string {
  return session.title || i18n.t(`sessionTitles.${primary ? session.scope ?? 'unit' : 'unit'}`)
}

/** Only the host caption changes. The captured label and quoted body stay intact. */
export function quoteLabel(quote: Quote): string {
  const caption = quote.caption
  if (!caption) return quote.label
  switch (caption.kind) {
    case 'terminal': return i18n.t('ide.terminalOutput', { ns: 'workbench' })
    case 'advice': return i18n.t('quotes.advice')
    case 'lesson': return i18n.t('quotes.lesson', { title: caption.name })
    case 'practice': return i18n.t('quotes.practice', { title: caption.name || i18n.t('quotes.lessonFallback') })
    case 'assessment': return i18n.t('chat.assessmentQuote', { title: caption.name })
    case 'selection': return `${caption.name}${i18n.t('quotes.selectionSuffix')}`
    case 'file': return caption.name
  }
}

/** Host receipts are identified by their relation, never by matching prose. */
export function receiptProposal(message: { id: string; text: string; parts?: unknown[] }, proposals: ActionProposal[]): ActionProposal | undefined {
  if (message.parts?.length) return undefined
  return proposals.find((proposal) => proposal.receiptId === message.id)
}

export function localizedActionReceipt(proposal: ActionProposal): string {
  const status = i18n.t(`receipts.status.${proposal.state}`)
  const text = proposal.action.kind === 'file'
    ? i18n.t('receipts.file', { status, path: proposal.action.path }) : i18n.t('receipts.command', { status })
  const exit = proposal.action.kind === 'command' && proposal.result?.exitCode !== null && proposal.result?.exitCode !== undefined
    ? i18n.t('receipts.exitCode', { code: proposal.result.exitCode }) : ''
  const output = proposal.result?.error ? formatNotice(proposal.result.error)
    : proposal.action.kind === 'command' ? proposal.result?.output ?? '' : ''
  return `${text}${exit ? ` ${exit}` : ''}${output ? `\n${output}` : ''}`
}

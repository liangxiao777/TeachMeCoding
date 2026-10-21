import { executionObservation, type AssessmentRecord, type CodeExecution } from '@teach-me-coding/contracts'
import i18n from './index'

/** Result facts select host copy; an authored needs-work summary remains content. */
export function localizedAssessmentSummary(record: Pick<AssessmentRecord, 'result' | 'summary' | 'execution'>): string {
  if (record.result === 'pass') return i18n.t('assessmentSummary.passed')
  if (record.result === 'unverified' || !record.summary) return record.execution
    ? localizedExecutionFeedback(record.execution).summary : i18n.t('assessmentSummary.unverified')
  return record.summary
}

/** Render-time copy only. Never replace summaries saved in Assessment history. */
export function localizedExecutionFeedback(execution: CodeExecution): { summary: string; nextStep?: string } {
  const observation = executionObservation(execution)
  const summary = i18n.t(`feedback.${observation.kind}.summary`, {
    ns: 'assessment', ...('count' in observation ? { count: observation.count } : {}),
  })
  if (observation.kind === 'pending' || observation.kind === 'running' || observation.kind === 'matched') return { summary }
  return { summary, nextStep: i18n.t(`feedback.${observation.kind}.nextStep`, { ns: 'assessment' }) }
}

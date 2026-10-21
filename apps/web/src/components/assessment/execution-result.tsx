import type { CodeExecution } from '@teach-me-coding/contracts'
import { useTranslation } from 'react-i18next'
import { localizedExecutionFeedback } from '@/i18n/execution'
import { formatNotice } from '@/i18n/notice'

const output = (text: string, empty: string) => {
  const value = text.replaceAll('\r\n', '\n').replace(/\n$/, '')
  // Make significant whitespace visible instead of making different outputs look identical.
  return !value ? empty : value.trim() !== value || /[\n\t]/.test(value) ? JSON.stringify(value) : value
}

export function ExecutionResult({ execution: e, showSummary = true }: { execution: CodeExecution; showSummary?: boolean }) {
  const { t } = useTranslation('assessment')
  const feedback = localizedExecutionFeedback(e)
  const display = (text: string) => output(text, t('execution.noOutput'))
  return <div className="space-y-3 rounded-xl border bg-card p-4 text-sm leading-relaxed" data-testid="code-execution">
    <p className="font-medium">{t('execution.title')}</p>
    <p className="text-xs text-muted-foreground">{t(e.submissionId ? 'execution.submissionSource' : 'execution.trialSource', { revision: e.specRevision })}</p>
    {showSummary && <p>{feedback.summary}</p>}
    {!e.submissionId && <p className="text-muted-foreground">{t('execution.trialHint')}</p>}
    {e.results.length > 0 && <ul className="space-y-3">
      {e.results.map((r, i) => <li key={i} className="border-l-2 pl-3">
        <p className="line-clamp-3 break-words">{t(e.plan.cases[i]!.args.length ? 'execution.checkArgs' : 'execution.checkNoArgs', { number: i + 1, args: e.plan.cases[i]!.args.map((arg) => JSON.stringify(arg)).join(t('execution.argsSeparator')) })}</p>
        {r.result.status === 'succeeded' ? r.matches
          ? <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">{t('execution.matchingOutput', { output: display(r.result.stdout ?? '') })}</p>
          : <><p className="line-clamp-3 whitespace-pre-wrap break-words">{t('execution.expectedOutput', { output: display(r.expected) })}</p><p className="line-clamp-3 whitespace-pre-wrap break-words">{t('execution.actualOutput', { output: display(r.result.stdout ?? '') })}</p></>
          : <p className="text-muted-foreground">{t('execution.incompleteCheck', { status: t(`execution.status.${r.result.status}`) })}</p>}
      </li>)}
    </ul>}
    {!e.submissionId && feedback.nextStep && <p>{feedback.nextStep}</p>}
    <details key={e.id}>
      <summary className="cursor-pointer text-muted-foreground">{t('execution.details')}</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p>{t(e.submissionId ? 'execution.submissionWarning' : 'execution.trialWarning')}</p>
        <p className="font-medium">{t('execution.fixedCode')}</p>
        <pre className="max-h-56 overflow-auto whitespace-pre rounded bg-muted p-2" aria-label={t('execution.fixedCode')}>{e.code}</pre>
        {e.error && <p role="alert">{formatNotice(e.error)}</p>}
        {e.results.map((r, i) => <div key={i}>
          <p>{t('execution.detailStatus', { number: i + 1, status: t(`execution.status.${r.result.status}`), code: r.result.exitCode ?? t('execution.none') })}</p>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{t('execution.streams', { command: r.command, stdout: r.result.stdout ?? '', stderr: r.result.stderr ?? '', expected: r.expected })}</pre>
        </div>)}
      </div>
    </details>
  </div>
}

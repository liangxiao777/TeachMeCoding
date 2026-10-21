import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/i18n/format'
import { CheckCircle2, ChevronDown, Circle, CircleSlash, LoaderCircle, Wrench, XCircle } from 'lucide-react'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { ToolInput } from '@/components/ai-elements/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { uiMotion } from '@/lib/motion'

type ToolCall = Extract<AgentDisplayPart, { type: 'tool' }>

const statuses = {
  generating: { icon: Circle },
  ready: { icon: Circle },
  running: { icon: LoaderCircle },
  done: { icon: CheckCircle2 },
  error: { icon: XCircle },
  interrupted: { icon: CircleSlash },
}

/** One complete run, including tool calls separated by text or model requests. */
export function ToolCallGroup({ calls, streaming }: { calls: ToolCall[]; streaming: boolean }) {
  const { t } = useTranslation('workbench')
  const reducedMotion = useReducedMotion()
  const latest = calls[calls.length - 1]!
  const active = calls.some((call) => ['generating', 'ready', 'running'].includes(call.status))
  const succeeded = calls.filter((call) => call.status === 'done').length
  const failed = calls.filter((call) => call.status === 'error').length
  const interrupted = calls.filter((call) => call.status === 'interrupted').length

  return (
    <Collapsible className="tool-disclosure group/tool-group min-w-0 rounded-lg border" defaultOpen={false} data-testid="tool-call-group">
      <CollapsibleTrigger className="flex w-full min-w-0 flex-col gap-2 rounded-lg p-3 text-left hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring" aria-label={t('tools.title')}>
        <span className="flex w-full items-center gap-2.5 text-sm">
          <Wrench className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">{t('tools.title')}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground" data-testid="tool-call-count">{t('tools.count', { count: calls.length })}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground group-data-open/tool-group:rotate-180" aria-hidden />
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 pl-6.5 text-xs" data-testid="tool-call-summary">
          <span className="shrink-0 text-muted-foreground">{active ? t('tools.active') : streaming ? t('tools.recent') : t('tools.finished')}</span>
          <span className="relative flex h-6 min-w-0 flex-1 overflow-hidden" data-testid="tool-call-ticker">
            <AnimatePresence initial={false}>
              <motion.code key={latest.id} data-call-id={latest.id} title={latest.name}
                className="absolute left-0 top-0 max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 leading-5"
                initial={{ y: reducedMotion ? 0 : '100%', opacity: reducedMotion ? 1 : 0 }}
                animate={{ y: 0, opacity: 1 }} exit={{ y: reducedMotion ? 0 : '-100%', opacity: reducedMotion ? 1 : 0 }}
                transition={{ duration: reducedMotion ? 0 : uiMotion.content, ease: uiMotion.ease }}>
                {latest.name || t('tools.title')}
              </motion.code>
            </AnimatePresence>
          </span>
          <span className="shrink-0 text-muted-foreground">{t('tools.succeeded', { count: succeeded })}</span>
        </span>
      </CollapsibleTrigger>
      {(failed > 0 || interrupted > 0) && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="tool-call-issues">
          {failed > 0 && <span className="text-destructive">{t('tools.failed', { count: failed })}</span>}
          {failed > 0 && interrupted > 0 && ' · '}
          {interrupted > 0 && <span>{t('tools.interrupted', { count: interrupted })}</span>}
          <span>{t('tools.expand')}</span>
        </p>
      )}
      <CollapsibleContent>
        <div className="max-h-80 overflow-y-auto overscroll-contain border-t" data-testid="tool-call-history">
          {calls.map((call, index) => {
            const status = statuses[call.status]
            const StatusIcon = status.icon
            const hasInput = call.input !== undefined || call.inputText !== undefined
            return (
              <Collapsible key={call.id} className="tool-disclosure group/tool-call border-b last:border-b-0" data-testid="tool-call" data-call-id={call.id}>
                <CollapsibleTrigger disabled={!hasInput} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default">
                  <span className="w-5 shrink-0 text-muted-foreground">{formatNumber(index + 1)}.</span>
                  <code className="min-w-0 flex-1 truncate" title={call.name}>{call.name || t('tools.title')}</code>
                  <span className={`flex shrink-0 items-center gap-1.5 ${call.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    <StatusIcon className={`size-3.5 ${call.status === 'running' ? 'motion-safe:animate-spin' : ''}`} aria-hidden />
                    {t(`tools.status.${call.status}`)}
                  </span>
                  <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground group-data-open/tool-call:rotate-180 ${hasInput ? '' : 'invisible'}`} aria-hidden />
                </CollapsibleTrigger>
                {hasInput && <CollapsibleContent>
                  <ToolInput input={call.input} inputText={call.inputText} className="mx-3 mb-3 max-h-64 overflow-y-auto overscroll-contain" />
                </CollapsibleContent>}
              </Collapsible>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

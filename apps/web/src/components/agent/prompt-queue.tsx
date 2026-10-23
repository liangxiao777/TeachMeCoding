import { CornerUpLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { quoteLabel } from '@/i18n/presentation'
import { useApp } from '@/app/context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PromptQueue({ className }: { className?: string }) {
  const { t } = useTranslation('workbench')
  const { session, persistence } = useApp()
  const prompts = session?.messages.filter((message) => message.queuedPrompts?.length).flatMap((owner) => {
    const paused = !session.messages.some((message) => (message.id === owner.id || message.runId === owner.id)
      && (message.status === 'thinking' || message.status === 'streaming'))
    return (owner.queuedPrompts ?? []).map((prompt) => ({ prompt, paused }))
  }) ?? []
  if (!prompts.length) return null
  const paused = prompts.every((item) => item.paused)
  return <section aria-label={t('queue.region')} className={cn('shrink-0 px-3 pt-3', className)}>
    <div className="mb-1 text-xs text-muted-foreground" role="status">{t(paused ? 'queue.pausedStatus' : 'queue.status', { count: prompts.length })}</div>
    <ol className="max-h-32 overflow-y-auto rounded-lg border bg-background/60 [scrollbar-width:thin]">
      {prompts.map(({ prompt, paused: itemPaused }, index) => <li key={prompt.id} className="flex min-w-0 items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <div className="min-w-0 flex-1 text-xs leading-relaxed">
          <p className="line-clamp-2 whitespace-pre-wrap break-words" title={prompt.text}>{prompt.text || (prompt.quote && quoteLabel(prompt.quote))}</p>
          {prompt.quote && prompt.text && <p className="truncate text-muted-foreground">{t('queue.quote', { label: quoteLabel(prompt.quote) })}</p>}
        </div>
        {!paused && itemPaused && <span className="shrink-0 text-xs text-muted-foreground">{t('queue.paused')}</span>}
        <Button type="button" variant="ghost" size="icon-xs" disabled={persistence.busy}
          aria-label={t('queue.withdraw', { number: index + 1 })} title={t('queue.restore')}
          onClick={() => { void persistence.dequeuePrompt(prompt.id) }}><CornerUpLeft /></Button>
      </li>)}
    </ol>
  </section>
}

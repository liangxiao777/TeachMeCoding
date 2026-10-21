import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp, useSpace } from '@/app/context'
import {
  Context, ContextTrigger, ContextContent, ContextContentHeader, ContextContentBody,
  ContextInputUsage, ContextOutputUsage, ContextCacheUsage,
} from '@/components/ai-elements/context'

export function RunContext({ runId }: { runId?: string }) {
  const { t } = useTranslation('workbench')
  const { persistence } = useApp()
  const space = useSpace()
  if (!persistence) return null
  const context = runId ? persistence.runContexts[runId]?.context : undefined
  const status = context?.phase === 'compacting' ? t('context.compacting')
    : context?.phase === 'compacted' ? t('context.compacted')
    : context?.phase === 'failed' ? t('context.failed')
    : context?.phase === 'interrupted' ? t('context.interrupted')
    : context?.tokens === null ? t('context.waiting') : undefined

  return <Context usedTokens={context?.tokens ?? null} maxTokens={context?.contextWindow ?? null} usage={context?.usage ?? null}>
    <ContextTrigger aria-label={t('context.view')}>
      {context?.phase === 'compacting' ? <><LoaderCircle className="size-3 animate-spin" aria-hidden />{t('context.compactLabel')}</> : undefined}
    </ContextTrigger>
    <ContextContent className={space.ideFullscreen ? 'dark' : undefined}>
      <ContextContentHeader />
      <ContextContentBody>
        {context && <p className="break-all text-xs text-muted-foreground">{context.provider} / {context.modelId}</p>}
        {status && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{status}</p>}
        {!context && <p className="text-xs text-muted-foreground">{t('context.empty')}</p>}
        <p className="pt-1 text-xs font-medium">{t('context.usage')}</p>
        <ContextInputUsage />
        <ContextOutputUsage />
        <ContextCacheUsage />
      </ContextContentBody>
    </ContextContent>
  </Context>
}

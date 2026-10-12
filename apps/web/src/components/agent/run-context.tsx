import { LoaderCircle } from 'lucide-react'
import { useApp, useSpace } from '@/app/context'
import {
  Context, ContextTrigger, ContextContent, ContextContentHeader, ContextContentBody,
  ContextInputUsage, ContextOutputUsage, ContextCacheUsage,
} from '@/components/ai-elements/context'

export function RunContext({ runId }: { runId?: string }) {
  const { persistence } = useApp()
  const space = useSpace()
  if (!persistence) return null
  const context = runId ? persistence.runContexts[runId]?.context : undefined
  const status = context?.phase === 'compacting' ? '正在压缩上下文…'
    : context?.phase === 'compacted' ? '已自动压缩，下一次模型响应后更新占用。'
    : context?.phase === 'failed' ? '本次压缩未完成；原始上下文仍保留。'
    : context?.phase === 'interrupted' ? '压缩已中断；原始上下文仍保留。'
    : context?.tokens === null ? '等待模型响应后更新占用估算。' : undefined

  return <Context usedTokens={context?.tokens ?? null} maxTokens={context?.contextWindow ?? null} usage={context?.usage ?? null}>
    <ContextTrigger aria-label="查看上下文用量">
      {context?.phase === 'compacting' ? <><LoaderCircle className="size-3 animate-spin" aria-hidden />压缩中</> : undefined}
    </ContextTrigger>
    <ContextContent className={space.ideFullscreen ? 'dark' : undefined}>
      <ContextContentHeader />
      <ContextContentBody>
        {context && <p className="break-all text-xs text-muted-foreground">{context.provider} / {context.modelId}</p>}
        {status && <p role="status" className="text-xs leading-relaxed text-muted-foreground">{status}</p>}
        {!context && <p className="text-xs text-muted-foreground">运行开始后显示上下文用量。</p>}
        <p className="pt-1 text-xs font-medium">本次运行消耗 · 含压缩请求</p>
        <ContextInputUsage />
        <ContextOutputUsage />
        <ContextCacheUsage />
      </ContextContentBody>
    </ContextContent>
  </Context>
}

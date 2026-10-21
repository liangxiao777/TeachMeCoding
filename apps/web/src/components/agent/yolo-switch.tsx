import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, useSpace } from '@/app/context'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export function YoloSwitch({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation('workbench')
  const { session, persistence } = useApp()
  const space = useSpace()
  const id = useId()
  if (!persistence) return null
  const target = sessionId ? space.sessions.find((candidate) => candidate.id === sessionId) : session
  const enabled = target?.settings?.yolo ?? false
  return <label htmlFor={id} title={t('yolo.hint')} className={cn(
    'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground',
    enabled && 'text-foreground',
  )}>
    <Switch id={id} size="sm" checked={enabled}
      disabled={!target || !persistence.ready || persistence.busy || !enabled && persistence.requirementDraft !== null}
      onCheckedChange={(value) => persistence.setYolo(value, target?.id)} />
    YOLO<span className="sr-only">{t('yolo.mode')}</span>
  </label>
}

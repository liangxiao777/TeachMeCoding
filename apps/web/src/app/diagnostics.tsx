import { useEffect, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import type { HealthResponse } from '@teach-me-coding/contracts';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ThemeToggle } from './theme';
import { useTranslation } from 'react-i18next';

export function Diagnostics() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'connecting' | 'connected' | 'unavailable' | 'failed'>('connecting');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Health check failed');
        const health = await response.json() as HealthResponse;
        setStatus(health.status === 'ok' ? 'connected' : 'unavailable');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('failed'); });
    return () => controller.abort();
  }, []);
  return <main className="mx-auto max-w-2xl px-6 py-24">
    <Card>
      <CardHeader>
        <p className="flex items-center gap-2 text-muted-foreground"><TerminalSquare aria-hidden className="size-4" />{t('diagnostics.environment')}</p>
        <CardTitle><h1 className="text-3xl font-semibold">TeachMeCoding</h1></CardTitle>
        <CardAction><ThemeToggle /></CardAction>
      </CardHeader>
      <CardContent className="space-y-5 leading-relaxed">
        <p role="status" className="font-medium">{t(`diagnostics.${status}`)}</p>
        <p>{t('diagnostics.description')}</p>
        <p><a className="underline underline-offset-4" href="/preview">{t('diagnostics.preview')}</a> · {t('diagnostics.previewNote')}</p>
        <p className="border-t pt-5 text-muted-foreground">{t('diagnostics.permissions')}</p>
      </CardContent>
    </Card>
  </main>;
}

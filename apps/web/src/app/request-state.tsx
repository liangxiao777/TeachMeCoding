import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export function useRequest() {
  const lock = useRef(false);
  const retry = useRef<() => Promise<void>>(async () => {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<void>) => {
    if (lock.current) return;
    retry.current = action; lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : '请求失败，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  }, []);
  return { busy, error, run, retry: () => run(retry.current) };
}
export function RequestState({ request }: { request: ReturnType<typeof useRequest> }) {
  return request.error ? <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
    <span className="flex-1">{request.error}</span><Button variant="outline" size="sm" disabled={request.busy} onClick={request.retry}>重试</Button>
  </div> : request.busy ? <p role="status" className="text-xs text-muted-foreground">正在读取或保存…</p> : null;
}
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

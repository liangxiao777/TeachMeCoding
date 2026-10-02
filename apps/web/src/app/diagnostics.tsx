import { useEffect, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import type { HealthResponse } from '@teach-me-coding/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function Diagnostics() {
  const [status, setStatus] = useState('正在连接本地服务…');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Health check failed');
        const health = await response.json() as HealthResponse;
        setStatus(health.status === 'ok' ? '本地服务已连接' : '本地服务不可用');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('本地服务不可用，请检查服务进程后刷新。'); });
    return () => controller.abort();
  }, []);
  return <main className="mx-auto max-w-2xl px-6 py-24">
    <Card>
      <CardHeader>
        <p className="flex items-center gap-2 text-muted-foreground"><TerminalSquare aria-hidden className="size-4" />本地运行环境</p>
        <CardTitle><h1 className="text-3xl font-semibold">TeachMeCoding</h1></CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 leading-relaxed">
        <p role="status" className="font-medium">{status}</p>
        <p>工程启动检查页。教学服务尚未接入。</p>
        <p><a className="underline underline-offset-4" href="/preview">打开界面演示</a>（开发夹具；刷新重置；不调用模型、不保存文件、不执行命令）</p>
        <p className="border-t pt-5 text-muted-foreground">未来的学习代码将在本机执行，拥有当前用户权限，不具备沙箱隔离。</p>
      </CardContent>
    </Card>
  </main>;
}

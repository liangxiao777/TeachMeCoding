import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthResponse } from '@teach-me-coding/contracts';
import './style.css';

function App() {
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
  return <main>
    <p className="eyebrow">本地运行环境</p>
    <h1>TeachMeCoding</h1>
    <p role="status">{status}</p>
    <p>工程启动检查页。学习界面与教学功能尚未接入。</p>
    <p className="notice">未来的学习代码将在本机执行，拥有当前用户权限，不具备沙箱隔离。</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import './style.css';

const Preview = lazy(() => import('./fixtures/preview'));

createRoot(document.getElementById('root')!).render(<StrictMode>
  {location.pathname === '/preview' ? <Suspense fallback={<p role="status">正在加载界面演示…</p>}><Preview /></Suspense> : <Diagnostics />}
</StrictMode>);

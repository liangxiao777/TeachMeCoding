import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import './style.css';

const Preview = lazy(() => import('./fixtures/preview'));
const PersistentApp = lazy(() => import('./app/workspace'));

createRoot(document.getElementById('root')!).render(<StrictMode>
  <Suspense fallback={<p role="status">正在加载…</p>}>
    {location.pathname === '/preview' ? <Preview /> : location.pathname === '/diagnostics' ? <Diagnostics /> : <PersistentApp />}
  </Suspense>
</StrictMode>);

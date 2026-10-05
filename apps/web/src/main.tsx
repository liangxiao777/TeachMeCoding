import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import { initializeTheme, ThemeProvider } from './app/theme';
import './style.css';

const Preview = lazy(() => import('./fixtures/preview'));
const PersistentApp = lazy(() => import('./app/workspace'));

initializeTheme();

createRoot(document.getElementById('root')!).render(<StrictMode>
  <ThemeProvider>
    <Suspense fallback={<p role="status">正在加载…</p>}>
      {location.pathname === '/preview' ? <Preview /> : location.pathname === '/diagnostics' ? <Diagnostics /> : <PersistentApp />}
    </Suspense>
  </ThemeProvider>
</StrictMode>);

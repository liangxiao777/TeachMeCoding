import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import { StartupLoading } from './app/startup-loading';
import { initializeTheme, ThemeProvider } from './app/theme';
import './style.css';

const Preview = lazy(() => import('./fixtures/preview'));
const PersistentApp = lazy(() => import('./app/workspace'));

initializeTheme();

createRoot(document.getElementById('root')!).render(<StrictMode>
  <ThemeProvider>
    <Suspense fallback={<StartupLoading />}>
      {location.pathname === '/preview' ? <Preview /> : location.pathname === '/diagnostics' ? <Diagnostics /> : <PersistentApp />}
    </Suspense>
  </ThemeProvider>
</StrictMode>);

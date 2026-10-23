import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Diagnostics } from './app/diagnostics';
import { StartupLoading } from './app/startup-loading';
import { initializeTheme, ThemeProvider } from './app/theme';
import { initializeLanguage, LanguageProvider } from './i18n/language';
import './style.css';

const PersistentApp = lazy(() => import('./app/workspace'));

initializeTheme();
initializeLanguage();

createRoot(document.getElementById('root')!).render(<StrictMode>
  <LanguageProvider>
  <ThemeProvider>
    <Suspense fallback={<StartupLoading />}>
      {location.pathname === '/diagnostics' ? <Diagnostics /> : <PersistentApp />}
    </Suspense>
  </ThemeProvider>
  </LanguageProvider>
</StrictMode>);

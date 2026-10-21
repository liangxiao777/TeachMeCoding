import { BrandMark } from '@/components/brand';
import { StartupField, useStartupField } from '@/components/startup-field';
import { useTranslation } from 'react-i18next';

export function StartupLoading() {
  const { t } = useTranslation();
  const { field, moveLight, resetLight } = useStartupField();
  return (
    <main className="code-loading startup-page" aria-label={t('status.loadingApplication')} onPointerMove={moveLight} onPointerLeave={resetLight}>
      <StartupField ref={field} />
      <div className="code-loading-content">
        <div className="code-loading-brand">
          <BrandMark className="code-loading-mark" />
          <span>TeachMeCoding</span>
        </div>
        <div className="code-loading-status">
          <p role="status">{t('status.loading')}</p>
          <span className="code-loading-dots" aria-hidden>
            <span /><span /><span />
          </span>
        </div>
      </div>
    </main>
  );
}

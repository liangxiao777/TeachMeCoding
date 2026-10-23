import type { ReactNode } from 'react';
import { StartupField, useStartupField } from '@/components/startup-field';
import { useTranslation } from 'react-i18next';

/** Shared entry composition; the caller supplies its own goal actions. */
export function LearningHome({ children }: { children: ReactNode }) {
  const { t } = useTranslation('home');
  const { field, moveLight, resetLight } = useStartupField();

  return (
    <div
      className="learning-entry relative flex min-h-[calc(100dvh-57px)] flex-col justify-center py-12"
      onPointerMove={moveLight}
      onPointerLeave={resetLight}
    >
      <StartupField ref={field} />
      <div className="learning-content relative mx-auto flex w-full max-w-3xl flex-col gap-9 sm:gap-10">
        <div className="flex flex-col items-center gap-5 text-center">
          <h1 className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-5xl">{t('title')}</h1>
          <p className="max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
            {t('description')}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

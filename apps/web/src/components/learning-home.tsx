import type { ReactNode } from 'react';

/** Shared entry composition; the preview and real app supply their own goal actions. */
export function LearningHome({ children }: { children: ReactNode }) {
  return (
    <div className="learning-entry relative isolate flex min-h-[calc(100dvh-57px)] flex-col justify-center py-12">
      <div className="orbital-field" aria-hidden="true">
        <svg viewBox="0 0 1200 900" preserveAspectRatio="none" focusable="false">
          <g transform="translate(600 450) scale(1.5 1)">
            {[0, 1].map((layer) => (
              <g key={layer} className="orbital-field-orbit">
                {Array.from({ length: 96 }, (_, i) => {
                  const seed = i + layer * 96;
                  const angle = seed * 2.399963;
                  const radius = 280 + 58 * Math.sin(seed * 7.13) + 22 * Math.cos(seed * 3.71);
                  return <circle key={i} cx={(Math.cos(angle) * radius).toFixed(3)} cy={(Math.sin(angle) * radius).toFixed(3)}
                    r={i % 19 === 0 ? 2.1 : i % 5 === 0 ? 1.4 : 0.9} opacity={0.2 + (i % 7) * 0.05} />;
                })}
              </g>
            ))}
          </g>
        </svg>
      </div>
      <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-12">
        <div className="flex flex-col items-center gap-5 text-center">
          <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">今天你想学习什么?</h1>
          <p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            路线、课件、会话、练习代码与测评记录都在同一个空间里。每个学习目标独立推进，随时回来接着学。
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

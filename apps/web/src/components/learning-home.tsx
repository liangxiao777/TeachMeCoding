import { useRef, type PointerEvent, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';

/** Shared entry composition; the preview and real app supply their own goal actions. */
export function LearningHome({ children }: { children: ReactNode }) {
  const field = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const moveLight = (event: PointerEvent<HTMLDivElement>) => {
    if (reducedMotion || event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    field.current?.style.setProperty('--light-x', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 16}px`);
    field.current?.style.setProperty('--light-y', `${((event.clientY - bounds.top) / bounds.height - 0.5) * 12}px`);
  };
  const resetLight = () => {
    field.current?.style.setProperty('--light-x', '0px');
    field.current?.style.setProperty('--light-y', '0px');
  };

  return (
    <div
      className="learning-entry relative flex min-h-[calc(100dvh-57px)] flex-col justify-center py-12"
      onPointerMove={moveLight}
      onPointerLeave={resetLight}
    >
      <div ref={field} className="startup-field" aria-hidden="true">
        <div className="startup-light-plane"><span /></div>
        <div className="startup-light-plane"><span /></div>
      </div>
      <div className="learning-content relative mx-auto flex w-full max-w-3xl flex-col gap-9 sm:gap-10">
        <div className="flex flex-col items-center gap-5 text-center">
          <h1 className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-5xl">今天你想学习什么?</h1>
          <p className="max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
            路线、课件、会话、练习代码与测评记录都在同一个空间里。每个学习目标独立推进，随时回来接着学。
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

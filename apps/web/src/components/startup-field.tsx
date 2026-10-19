import { useRef, type PointerEvent, type Ref } from 'react';

export function useStartupField() {
  const field = useRef<HTMLDivElement>(null);
  const moveLight = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    field.current?.style.setProperty('--light-x', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 16}px`);
    field.current?.style.setProperty('--light-y', `${((event.clientY - bounds.top) / bounds.height - 0.5) * 12}px`);
  };
  const resetLight = () => {
    field.current?.style.setProperty('--light-x', '0px');
    field.current?.style.setProperty('--light-y', '0px');
  };
  return { field, moveLight, resetLight };
}

export function StartupField({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="startup-field" aria-hidden="true">
      <div className="startup-light-plane"><span /></div>
      <div className="startup-light-plane"><span /></div>
    </div>
  );
}

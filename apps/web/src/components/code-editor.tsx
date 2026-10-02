import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export type EditorPosition = { start: number; end: number; top: number; left: number };

export function CodeEditor({ value, onChange, onSelectText, label, className, position, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onSelectText?: (text: string) => void;
  label: string;
  className?: string;
  position?: EditorPosition;
  disabled?: boolean;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !position) return;
    el.setSelectionRange(position.start, position.end);
    el.scrollTop = position.top;
    el.scrollLeft = position.left;
    if (gutter.current) gutter.current.scrollTop = position.top;
  }, [position]);
  return <div className={cn('flex min-h-0 overflow-hidden bg-ide font-mono text-[13px] leading-6 text-ide-foreground', className)}>
    <div ref={gutter} aria-hidden className="shrink-0 select-none overflow-hidden py-3 pr-3 pl-4 text-right opacity-40">
      {Array.from({ length: value.split('\n').length }, (_, i) => <div key={i}>{i + 1}</div>)}
    </div>
    <textarea ref={input} aria-label={label} spellCheck={false} value={value} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onScroll={(e) => {
        if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        if (position) { position.top = e.currentTarget.scrollTop; position.left = e.currentTarget.scrollLeft; }
      }}
      onSelect={(e) => {
        const t = e.currentTarget;
        if (position) { position.start = t.selectionStart; position.end = t.selectionEnd; }
        onSelectText?.(t.value.slice(t.selectionStart, t.selectionEnd));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const t = e.currentTarget;
          const { selectionStart: start, selectionEnd: end } = t;
          onChange(`${t.value.slice(0, start)}    ${t.value.slice(end)}`);
          requestAnimationFrame(() => t.setSelectionRange(start + 4, start + 4));
        }
      }}
      className="min-w-0 flex-1 resize-none bg-transparent py-3 pr-4 whitespace-pre outline-none selection:bg-accent selection:text-accent-foreground" />
  </div>;
}

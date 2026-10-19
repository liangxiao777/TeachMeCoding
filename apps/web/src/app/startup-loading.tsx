import { BrandMark } from '@/components/brand';
import { StartupField, useStartupField } from '@/components/startup-field';

export function StartupLoading() {
  const { field, moveLight, resetLight } = useStartupField();
  return (
    <main className="code-loading startup-page" aria-label="应用加载" onPointerMove={moveLight} onPointerLeave={resetLight}>
      <StartupField ref={field} />
      <div className="code-loading-content">
        <div className="code-loading-brand">
          <BrandMark className="code-loading-mark" />
          <span>TeachMeCoding</span>
        </div>
        <div className="code-loading-status">
          <p role="status">正在加载…</p>
          <span className="code-loading-dots" aria-hidden>
            <span /><span /><span />
          </span>
        </div>
      </div>
    </main>
  );
}

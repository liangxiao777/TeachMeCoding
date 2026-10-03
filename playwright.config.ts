import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testIgnore: '**/teaching.spec.ts',
  outputDir: '.amp/in/artifacts/browser',
  // Both serving modes must match the same platform-specific visual baseline.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  use: { channel: 'chrome', viewport: { width: 1100, height: 760 } },
  webServer: [
    { command: 'pnpm exec tsx tests/serve-browser.ts production', url: 'http://127.0.0.1:14320/api/health', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'pnpm exec tsx tests/serve-browser.ts development', url: 'http://127.0.0.1:14321/api/health', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'pnpm --filter @teach-me-coding/web dev', url: 'http://127.0.0.1:15173', env: { PORT: '14321', TMC_WEB_PORT: '15173' }, reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
  ],
  projects: [
    { name: 'production', use: { baseURL: 'http://127.0.0.1:14320' } },
    { name: 'development', use: { baseURL: 'http://127.0.0.1:15173' } },
  ],
});

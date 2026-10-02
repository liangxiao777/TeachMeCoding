import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.amp/in/artifacts/browser',
  // Both serving modes must match the same platform-specific visual baseline.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  use: { channel: 'chrome', viewport: { width: 1100, height: 760 } },
  webServer: [
    { command: 'pnpm start', url: 'http://127.0.0.1:4310/api/health', reuseExistingServer: false },
    { command: 'pnpm --filter @teach-me-coding/server dev', url: 'http://127.0.0.1:4311/api/health', env: { PORT: '4311' }, reuseExistingServer: false },
    { command: 'pnpm --filter @teach-me-coding/web dev', url: 'http://127.0.0.1:5173', env: { PORT: '4311' }, reuseExistingServer: false },
  ],
  projects: [
    { name: 'production', use: { baseURL: 'http://127.0.0.1:4310' } },
    { name: 'development', use: { baseURL: 'http://127.0.0.1:5173' } },
  ],
});

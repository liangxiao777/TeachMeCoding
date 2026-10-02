import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.amp/in/artifacts/browser',
  use: { channel: 'chrome', viewport: { width: 1100, height: 760 } },
  webServer: [
    { command: 'pnpm start', url: 'http://127.0.0.1:4310/api/health', reuseExistingServer: false },
    { command: 'pnpm --filter @teach-me-coding/web dev', url: 'http://127.0.0.1:5173', reuseExistingServer: false },
  ],
  projects: [
    { name: 'production', use: { baseURL: 'http://127.0.0.1:4310' } },
    { name: 'development', use: { baseURL: 'http://127.0.0.1:5173' } },
  ],
});

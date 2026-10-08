import { defineConfig } from '@playwright/test';
import existing from '../playwright.config';

export default defineConfig({
  ...existing,
  testDir: './browser', testIgnore: [], testMatch: ['teaching.spec.ts', 'intake.spec.ts'],
  outputDir: '../.amp/in/artifacts/teaching-browser',
  webServer: [
    { command: 'pnpm exec tsx tests/serve-agents.ts production', cwd: '..', url: 'http://127.0.0.1:14320/api/health', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'pnpm exec tsx tests/serve-agents.ts development', cwd: '..', url: 'http://127.0.0.1:14321/api/health', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'pnpm --filter @teach-me-coding/web dev', cwd: '..', url: 'http://127.0.0.1:15173', env: { PORT: '14321', TMC_WEB_PORT: '15173' }, reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
  ],
});

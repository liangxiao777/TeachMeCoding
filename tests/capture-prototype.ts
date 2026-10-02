import { chromium } from '@playwright/test';
import { visualScenes } from './visual-scenes';

// Start the preserved reference worktree separately; this script never writes its source.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({
    baseURL: process.env.PROTOTYPE_URL ?? 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light',
  });
  await visualScenes(page, 'prototype', async (name) => {
    await page.screenshot({
      path: `.amp/in/artifacts/reference/${name}.png`, animations: 'disabled',
      // Exclude only reference-only developer chrome, not any application content.
      style: 'nextjs-portal, .fixed.bottom-4.left-4 { visibility: hidden !important; }',
    });
    console.log(`Captured prototype ${name}`);
  });
} finally {
  await browser.close();
}

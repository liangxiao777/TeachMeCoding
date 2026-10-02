import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { visualScenes } from './visual-scenes';

// Compare against an extracted, unchanged source revision, never newly accepted snapshots.
// Usage: pnpm exec tsx tests/compare-components.ts <reference apps/web> <current URL>
const [reference, currentUrl] = process.argv.slice(2);
assert(reference && currentUrl, 'Provide the unchanged reference apps/web directory and current URL');
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve('vite', { paths: [resolve('apps/web')] }));
const server = await createServer({ root: resolve(reference), server: { port: 15174, strictPort: true }, logLevel: 'error' });
const output = '.amp/in/artifacts/component-parity';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const signatures = new Map<string, unknown>();
const failures: string[] = [];
let count = 0;
try {
  await server.listen();
  for (const [source, baseURL] of [['reference', 'http://127.0.0.1:15174'], ['migrated', currentUrl]] as const) {
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
    const capture = async (scene: string) => {
      await page.mouse.move(1439, 999);
      // Finish finite CSS transitions before reading styles, just as visual baselines do.
      await page.screenshot({ path: `${output}/${source}-${scene}.png`, animations: 'disabled' });
      // Include individual cards, forms, trees, lesson and IDE/Agent panels, not just page shells.
      const parts = page.locator('header, [data-slot="card"], form, [role="tree"], .lesson-prose, aside[aria-label], [role="region"][aria-label], [role="menu"]');
      const total = await parts.count();
      for (let i = 0; i < total; i++) {
        const part = parts.nth(i);
        if (!await part.isVisible()) continue;
        const name = `${scene}-${i}`;
        const signature = await part.evaluate((root) => {
          const nodes = [root, ...root.querySelectorAll('*')];
          return nodes.map((node) => {
            const css = getComputedStyle(node);
            const keys = ['display', 'position', 'width', 'height', 'padding', 'margin', 'gap', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'border', 'borderRadius', 'gridTemplateColumns', 'flexDirection'] as const;
            return {
              tag: node.tagName, parent: nodes.indexOf(node.parentElement!), classes: node.getAttribute('class'),
              attributes: Object.fromEntries(['role', 'type', 'disabled', 'aria-label', 'aria-expanded', 'aria-pressed', 'd'].flatMap((key) => {
                const value = node.getAttribute(key);
                // Intentional accessibility addition; no visible text or styling is normalized.
                return value === null || key === 'aria-label' && value === '切换会话' ? [] : [[key, value]];
              })),
              styles: Object.fromEntries(keys.map((key) => [key, css[key]])),
              text: [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent),
            };
          });
        });
        writeFileSync(`${output}/${source}-${name}.json`, JSON.stringify(signature, null, 2));
        if (source === 'reference') signatures.set(name, signature);
        else {
          try { assert.deepEqual(signature, signatures.get(name), `Component drift: ${name}`); }
          catch (error) { failures.push(name); console.error(error instanceof Error ? error.message : error); }
          count++;
        }
        const box = await part.boundingBox();
        if (box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 1000) {
          await page.screenshot({ path: `${output}/${source}-${name}.png`, clip: box, animations: 'disabled' });
        }
      }
      console.log(`${source}: ${scene}, ${total} component regions`);
    };
    await visualScenes(page, 'preview', async (scene) => {
      await capture(scene);
      if (scene === 'requirements') {
        await page.getByRole('button', { name: '修改', exact: true }).click();
        await capture('requirement-editor');
        await page.getByRole('button', { name: '取消', exact: true }).click();
      }
      if (scene === 'ide-normal') {
        await page.getByRole('button').filter({ has: page.locator('svg.lucide-history') }).click();
        await capture('session-menu');
        await page.keyboard.press('Escape');
      }
    });
    await page.close();
  }
  assert.equal(count, signatures.size, 'Every reference component must be compared');
  assert.deepEqual(failures, [], 'Component differences must be resolved, not accepted as a new baseline');
  console.log(`PASS: ${count} component states have identical DOM, classes, text, icons and computed styles.`);
} finally {
  await browser.close();
  await server.close();
}

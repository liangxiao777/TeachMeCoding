import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('renders connected startup page', async ({ page }, testInfo) => {
  await page.goto('/diagnostics');
  await expect(page.getByRole('heading', { name: 'TeachMeCoding' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  await page.screenshot({ path: `.amp/in/artifacts/startup-${testInfo.project.name}.png` });
});

test('renders API failure without claiming a connection', async ({ page }, testInfo) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/diagnostics');
  await expect(page.getByRole('status')).toContainText('本地服务不可用');
  await page.screenshot({ path: `.amp/in/artifacts/startup-error-${testInfo.project.name}.png` });
});

test('ships fonts, icons and theme styles without online resources', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/diagnostics');
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return Promise.all([
      document.fonts.load('400 16px "Geist Variable"', 'TeachMeCoding'),
      document.fonts.load('400 16px "Geist Mono Variable"', 'fn main()'),
      document.fonts.load('400 16px "Noto Sans SC Variable"', '学习路线'),
    ]).then((families) => families.map((family) => family.length));
  });
  expect(fonts.every((count) => count > 0)).toBe(true);
  await expect(page.locator('svg.lucide')).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'oklch(1 0 0)');
  for (const icon of ['/icon.svg', '/icon-light-32x32.png', '/icon-dark-32x32.png', '/apple-icon.png']) {
    expect((await page.request.get(icon)).ok()).toBe(true);
  }
  expect(external).toEqual([]);
});

test('same-origin browser can bootstrap a token and pass the protected check', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const denied = await fetch('/api/access/check', { method: 'POST' });
    const bootstrap = await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } });
    const { token } = await bootstrap.json();
    const checked = await fetch('/api/access/check', { method: 'POST', headers: { 'X-TMC-Token': token } });
    return { denied: denied.status, bootstrap: bootstrap.status, checked: checked.status,
      result: await checked.json(), cache: bootstrap.headers.get('cache-control') };
  });
  expect(result).toEqual({ denied: 401, bootstrap: 200, checked: 200, result: { ok: true }, cache: 'no-store' });
});

test('external Origin and illegal Host are rejected through the actual entrypoint', async ({ request }) => {
  const origin = await request.get('/api/access', { headers: { Origin: 'https://evil.test', 'X-TMC-Client': 'browser' } });
  expect(origin.status()).toBe(403);
  expect(origin.headers()['access-control-allow-origin']).toBeUndefined();
  const host = await request.get('/api/health', { headers: { Host: 'evil.test' } });
  expect(host.status()).toBe(403);
});

test('neither production static serving nor Vite filesystem access serves root credentials', async ({ request }) => {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  const response = await request.get(`/@fs${envPath}`);
  expect([403, 404]).toContain(response.status());
  expect(await response.text()).not.toContain('OPENROUTER_API_KEY=');
});

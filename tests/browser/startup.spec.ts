import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';

test('network HTTP entry can create and retry a space without secure-context UUID support', async ({ page, baseURL }, info) => {
  test.skip(process.env.HOST !== '0.0.0.0', 'Run with HOST=0.0.0.0 to exercise network access.');
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  test.skip(!address, 'Requires a non-loopback IPv4 interface.');
  const url = new URL(baseURL!); url.hostname = address!;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url.href);
  expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' });
  const goal = `网络访问检查 ${info.project.name}`;
  await page.getByRole('textbox', { name: '你想学什么', exact: true }).fill(goal);
  const keys: string[] = [];
  await page.route('**/api/spaces', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) { await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '学习空间名称', exact: true })).toHaveValue(goal);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(keys[1]).toBe(keys[0]);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '学习空间名称', exact: true })).toHaveValue(goal);
  await expect(page.getByText(goal, { exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

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
  await expect(page.getByText('本地运行环境', { exact: true }).locator('svg.lucide')).toBeVisible();
  await expect(page.getByRole('button', { name: '切换到暗色主题', exact: true }).locator('svg.lucide')).toBeVisible();
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

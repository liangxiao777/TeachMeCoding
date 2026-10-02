import { expect, test } from '@playwright/test';

test('renders connected startup page', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'TeachMeCoding' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('本地服务已连接');
  await page.screenshot({ path: `.amp/in/artifacts/startup-${testInfo.project.name}.png` });
});

test('renders API failure without claiming a connection', async ({ page }, testInfo) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('本地服务不可用');
  await page.screenshot({ path: `.amp/in/artifacts/startup-error-${testInfo.project.name}.png` });
});

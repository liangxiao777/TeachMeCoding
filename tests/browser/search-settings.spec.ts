import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { SearchSettings } from '../../packages/contracts/src/settings';
import type { seedWorkspaces } from '../seed-workspaces';

test('search settings persist per-provider secrets and enable state without changing the model, and fit both themes/mobile', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const errors: string[] = [], responses: Promise<string>[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/settings/search') responses.push(response.text());
  });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const model = await page.evaluate(async () => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await (await fetch('/api/settings/model', { headers: { 'X-TMC-Token': token } })).json()).selection;
  });
  const draft = page.getByRole('textbox', { name: '你想学什么', exact: true });
  await draft.fill('保留搜索设置之外的学习输入');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const region = page.getByRole('region', { name: '应用设置', exact: true });
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  const panel = region.getByRole('tabpanel', { name: '搜索服务', exact: true });
  const toggle = panel.getByRole('switch', { name: '启用搜索服务', exact: true });
  const key = panel.getByLabel('API Key', { exact: true });
  const provider = panel.getByLabel('搜索服务商', { exact: true });
  const providerValue = provider.locator('[data-slot="select-value"]');
  const save = panel.getByRole('button', { name: '保存配置', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(providerValue).toHaveText('Brave Search');
  await expect(panel.getByText(/可更换服务商|凭据仅保存在服务端|测试使用已保存配置|搜索查询将发送至所选服务商/)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '测试搜索', exact: true })).toBeDisabled();
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-off-${info.project.name}.png`, animations: 'disabled' });

  await key.fill('synthetic-brave-browser-secret');
  await expect(key).toHaveAttribute('type', 'password');
  await save.click();
  await expect(panel.getByText('已保存凭据', { exact: true })).toBeVisible();
  await expect(key).toHaveValue(''); await expect(save).toBeDisabled();
  await expect(panel.getByRole('button', { name: '测试搜索', exact: true })).toBeEnabled();
  await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeChecked();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-on-${info.project.name}.png`, animations: 'disabled' });
  await provider.click();
  await expect(page.getByRole('option', { name: 'Exa', exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-provider-menu-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('option', { name: 'Tavily', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(panel.getByText('未配置凭据', { exact: true })).toBeVisible();
  await key.fill('synthetic-tavily-browser-secret');
  await expect(panel.getByRole('button', { name: '测试搜索', exact: true })).toBeDisabled();
  // The master switch saves only enable state and must not commit or discard the provider/key draft.
  await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).not.toBeChecked();
  await expect(providerValue).toHaveText('Tavily'); await expect(key).toHaveValue('synthetic-tavily-browser-secret');
  expect(JSON.parse(readFileSync(join(seed.root, 'search.json'), 'utf8')).provider).toBe('brave');
  await region.getByRole('tab', { name: 'MCP', exact: true }).click();
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(key).toHaveValue('synthetic-tavily-browser-secret');
  await save.click(); await expect(key).toHaveValue('');
  await toggle.focus(); await page.keyboard.press('Space'); await expect(toggle).toBeChecked();

  for (const [name, width, height, dark] of [
    ['desktop-light', 1440, 1000, false], ['desktop-dark', 1440, 1000, true],
    ['mobile-dark', 390, 844, true], ['mobile-light', 390, 844, false], ['narrow-light', 320, 780, false],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(region.getByRole('tablist')).toHaveAttribute('data-orientation', width >= 768 ? 'vertical' : 'horizontal');
    const change = region.getByRole('button', { name: dark ? '切换到暗色主题' : '切换到亮色主题', exact: true });
    if (await change.isVisible()) await change.click();
    await expect(page.locator('html')).toHaveClass(dark ? /dark/ : /light/);
    await expect.poll(() => region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Vertical tabs include an invisible ::after underline beyond the list; horizontal phone tabs must fit.
    if (width < 768) await expect.poll(() => region.getByRole('tablist').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: `.amp/in/artifacts/search-settings-${name}-${info.project.name}.png`, animations: 'disabled' });
  }
  const stored = JSON.parse(readFileSync(join(seed.root, 'search.json'), 'utf8'));
  expect(stored).toEqual({ enabled: true, provider: 'tavily', apiKeys: { brave: 'synthetic-brave-browser-secret', tavily: 'synthetic-tavily-browser-secret' } });
  await region.getByRole('button', { name: '返回', exact: true }).click(); await expect(draft).toHaveValue('保留搜索设置之外的学习输入');
  await page.reload(); await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(toggle).toBeChecked(); await expect(providerValue).toHaveText('Tavily'); await expect(key).toHaveValue('');
  await provider.click(); await page.getByRole('option', { name: 'Brave Search', exact: true }).click();
  await save.click(); await expect(panel.getByText('已保存凭据', { exact: true })).toBeVisible();
  expect(JSON.parse(readFileSync(join(seed.root, 'search.json'), 'utf8')).apiKeys.brave).toBe('synthetic-brave-browser-secret');
  expect(await page.evaluate(async () => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await (await fetch('/api/settings/model', { headers: { 'X-TMC-Token': token } })).json()).selection;
  })).toEqual(model);
  const bodies = await Promise.all(responses);
  expect(bodies.length).toBeGreaterThan(0); expect(bodies.every((body) => !body.includes('synthetic-'))).toBe(true);
  expect(errors).toEqual([]);
});

test('failed search writes keep drafts and toggle state; diagnostics show safe errors, results and genuine empty responses', async ({ page }, info) => {
  let settings: SearchSettings = { enabled: true, provider: 'brave', providers: [
    { id: 'brave', name: 'Brave Search', apiKeyUrl: 'https://api-dashboard.search.brave.com/app/keys', configured: 'saved' },
    { id: 'tavily', name: 'Tavily', apiKeyUrl: 'https://app.tavily.com/home', configured: null },
    { id: 'exa', name: 'Exa', apiKeyUrl: 'https://dashboard.exa.ai/api-keys', configured: null },
  ] };
  let failWrite = true, failTest = true, empty = false, searches = 0;
  await page.route('**/api/settings/search', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: settings });
    if (failWrite) return route.fulfill({ status: 503, json: { error: '合成保存失败，请重试。' } });
    const input = route.request().postDataJSON();
    settings = { ...settings, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.provider ? { provider: input.provider } : {}),
      providers: settings.providers.map((entry) => input.apiKey && entry.id === (input.provider ?? settings.provider) ? { ...entry, configured: 'saved' } : entry) };
    return route.fulfill({ json: settings });
  });
  // Diagnostic fixtures never call a paid search API or a model.
  await page.route('**/api/settings/search/test', async (route) => {
    searches++; expect(route.request().postDataJSON()).toEqual({ query: 'Rust 官方文档', count: 5 });
    if (failTest) return route.fulfill({ status: 503, json: { error: 'Tavily 认证失败，请检查 API Key。' } });
    return route.fulfill({ json: { provider: 'tavily', query: 'Rust 官方文档', tookMs: 37, untrusted: true, results: empty ? [] : [
      { title: '合成检索结果：Rust 官方文档', url: 'https://doc.rust-lang.org/book/', snippet: '<script>window.searchSnippetExecuted=true</script> 不可信外部片段只作为文本显示。' },
    ] } });
  });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const region = page.getByRole('region', { name: '应用设置', exact: true });
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  const panel = region.getByRole('tabpanel', { name: '搜索服务', exact: true });
  const key = panel.getByLabel('API Key', { exact: true });
  const toggle = panel.getByRole('switch', { name: '启用搜索服务', exact: true });
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(panel.getByText('合成保存失败，请重试。', { exact: true })).toBeVisible(); await expect(toggle).toBeChecked();
  await panel.getByLabel('搜索服务商', { exact: true }).click(); await page.getByRole('option', { name: 'Tavily', exact: true }).click();
  await key.fill('synthetic-unsaved-key'); await panel.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(panel.getByText('合成保存失败，请重试。', { exact: true })).toBeVisible(); await expect(key).toHaveValue('synthetic-unsaved-key');
  await expect(panel.getByRole('button', { name: '测试搜索', exact: true })).toBeDisabled(); expect(searches).toBe(0);
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-save-error-${info.project.name}.png`, animations: 'disabled' });
  failWrite = false; await panel.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(key).toHaveValue('');
  const diagnose = panel.getByRole('button', { name: '测试搜索', exact: true });
  await diagnose.click(); await expect(panel.getByText('Tavily 认证失败，请检查 API Key。', { exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-test-error-${info.project.name}.png`, animations: 'disabled' });
  failTest = false; await diagnose.click();
  await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toBeVisible();
  await expect(panel.getByText('Tavily · 1 条结果 · 37 ms', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: '合成检索结果：Rust 官方文档', exact: true })).toHaveAttribute('href', 'https://doc.rust-lang.org/book/');
  expect(await page.evaluate(() => 'searchSnippetExecuted' in window)).toBe(false);
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-test-results-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(region.getByRole('tablist')).toHaveAttribute('data-orientation', 'horizontal');
  await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await page.screenshot({ path: `.amp/in/artifacts/search-settings-test-results-mobile-${info.project.name}.png`, animations: 'disabled' });
  empty = true; await diagnose.click(); await expect(panel.getByText('服务已响应，但没有找到匹配的结果。', { exact: true })).toBeVisible();
  await expect(panel.getByText('Tavily · 0 条结果 · 37 ms', { exact: true })).toBeVisible(); expect(searches).toBe(3);
});

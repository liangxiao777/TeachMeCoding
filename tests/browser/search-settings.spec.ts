import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { LoginSession, ModelSettings, SearchProvider, SearchSettings } from '../../packages/contracts/src/settings';
import type { seedWorkspaces } from '../seed-workspaces';

function searchFixture(provider: SearchProvider = 'brave'): SearchSettings {
  return { enabled: true, provider, providers: [
    { id: 'brave', name: 'Brave Search', authentication: 'api_key', apiKeyUrl: 'https://api-dashboard.search.brave.com/app/keys', configured: 'saved', ready: true },
    { id: 'tavily', name: 'Tavily', authentication: 'api_key', apiKeyUrl: 'https://app.tavily.com/home', configured: null, ready: false },
    { id: 'exa', name: 'Exa', authentication: 'api_key', apiKeyUrl: 'https://dashboard.exa.ai/api-keys', configured: null, ready: false },
    { id: 'firecrawl', name: 'Firecrawl', authentication: 'api_key', configured: null, ready: false },
    { id: 'parallel', name: 'Parallel', authentication: 'api_key', configured: null, ready: false },
    { id: 'perplexity', name: 'Perplexity Search', authentication: 'api_key', configured: null, ready: false },
    { id: 'minimax', name: 'MiniMax Search', authentication: 'api_key', configured: null, ready: false, region: 'global' },
    { id: 'gemini', name: 'Gemini', authentication: 'api_key', configured: 'environment', ready: true, model: 'gemini-3.6-flash' },
    { id: 'grok', name: 'Grok', authentication: 'api_key', configured: null, ready: false, model: 'grok-4.7' },
    { id: 'kimi', name: 'Kimi', authentication: 'api_key', configured: 'saved', ready: true, model: 'kimi-k2.6', region: 'global' },
    { id: 'codex', name: 'Codex Hosted Search', authentication: 'oauth', configured: null, ready: false },
    { id: 'duckduckgo', name: 'DuckDuckGo', authentication: 'none', configured: null, ready: true },
    { id: 'firecrawl-free', name: 'Firecrawl Free', authentication: 'none', configured: null, ready: true },
    { id: 'ollama', name: 'Ollama Web Search', authentication: 'api_key', apiKeyUrl: 'https://ollama.com/settings/keys', configured: null, ready: false },
  ] };
}

type SearchWrite = { enabled?: boolean; provider?: SearchProvider; apiKey?: string; model?: string; region?: 'global' | 'cn' };
async function mockSearch(page: Page, initial = searchFixture()) {
  const fixture = { settings: initial, writes: [] as SearchWrite[], failWrite: false, searches: 0 };
  await page.route('**/api/settings/search', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.settings });
    const input = route.request().postDataJSON() as SearchWrite;
    fixture.writes.push(input);
    if (fixture.failWrite) return route.fulfill({ status: 503, json: { error: '合成保存失败，请重试。' } });
    fixture.settings = { ...fixture.settings,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      providers: fixture.settings.providers.map((entry) => entry.id === (input.provider ?? fixture.settings.provider) ? {
        ...entry, ...(input.apiKey ? { configured: 'saved' as const, ready: true } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}), ...(input.region !== undefined ? { region: input.region } : {}),
      } : entry),
    };
    return route.fulfill({ json: fixture.settings });
  });
  // Every diagnostic request is intercepted: no paid search/model calls.
  await page.route('**/api/settings/search/test', (route) => {
    fixture.searches++;
    expect(route.request().postDataJSON()).toEqual({ query: 'Rust official documentation', count: 5 });
    return route.fulfill({ json: { provider: fixture.settings.provider, query: 'Rust official documentation', tookMs: 19, untrusted: true, results: [] } });
  });
  return fixture;
}

async function openSearch(page: Page) {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const region = page.getByRole('region', { name: '应用设置', exact: true });
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  const panel = region.getByRole('tabpanel', { name: '搜索服务', exact: true });
  await expect(panel.getByLabel('搜索服务商', { exact: true })).toBeVisible();
  return { region, panel };
}

async function chooseProvider(page: Page, name: string) {
  const panel = page.getByRole('tabpanel', { name: '搜索服务', exact: true });
  await panel.getByLabel('搜索服务商', { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

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
    await expect.poll(() => panel.locator('[data-slot="card-footer"]').evaluate((element) => {
      const card = element.closest('[data-slot="card"]')!;
      return getComputedStyle(element).backgroundColor === getComputedStyle(card).backgroundColor;
    })).toBe(true);
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
    { id: 'brave', name: 'Brave Search', authentication: 'api_key', apiKeyUrl: 'https://api-dashboard.search.brave.com/app/keys', configured: 'saved', ready: true },
    { id: 'tavily', name: 'Tavily', authentication: 'api_key', apiKeyUrl: 'https://app.tavily.com/home', configured: null, ready: false },
    { id: 'exa', name: 'Exa', authentication: 'api_key', apiKeyUrl: 'https://dashboard.exa.ai/api-keys', configured: null, ready: false },
  ] };
  let failWrite = true, failTest = true, empty = false, searches = 0;
  await page.route('**/api/settings/search', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: settings });
    if (failWrite) return route.fulfill({ status: 503, json: { error: '合成保存失败，请重试。' } });
    const input = route.request().postDataJSON();
    settings = { ...settings, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.provider ? { provider: input.provider } : {}),
      providers: settings.providers.map((entry) => input.apiKey && entry.id === (input.provider ?? settings.provider) ? { ...entry, configured: 'saved', ready: true } : entry) };
    return route.fulfill({ json: settings });
  });
  // Diagnostic fixtures never call a paid search API or a model.
  await page.route('**/api/settings/search/test', async (route) => {
    searches++; expect(route.request().postDataJSON()).toEqual({ query: 'Rust official documentation', count: 5 });
    if (failTest) return route.fulfill({ status: 503, json: { error: 'Tavily 认证失败，请检查 API Key。' } });
    return route.fulfill({ json: { provider: 'tavily', query: 'Rust official documentation', tookMs: 37, untrusted: true, results: empty ? [] : [
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

test('14-provider metadata controls fields, no-key readiness and concise warnings on desktop/mobile', async ({ page }, info) => {
  const fixture = await mockSearch(page);
  const { panel } = await openSearch(page);
  const provider = panel.getByLabel('搜索服务商', { exact: true });
  await provider.click();
  await expect(page.getByRole('option')).toHaveCount(14);
  expect(await page.getByRole('option').allTextContents()).toEqual(fixture.settings.providers.map((entry) => entry.name));
  await page.screenshot({ path: `.amp/in/artifacts/search-14-dropdown-desktop-${info.project.name}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await provider.click();
  await page.screenshot({ path: `.amp/in/artifacts/search-14-dropdown-mobile-${info.project.name}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const entry of fixture.settings.providers) {
    await chooseProvider(page, entry.name);
    await expect(panel.getByLabel('API Key', { exact: true })).toHaveCount(entry.authentication === 'api_key' ? 1 : 0);
    await expect(panel.getByLabel('搜索模型', { exact: true })).toHaveCount(entry.model !== undefined ? 1 : 0);
    await expect(panel.getByLabel('服务区域', { exact: true })).toHaveCount(entry.region !== undefined ? 1 : 0);
    if (entry.model !== undefined) await expect(panel.getByLabel('搜索模型', { exact: true })).toHaveValue(entry.model);
    if (entry.authentication === 'none') await expect(panel.getByText('无需 API Key', { exact: true })).toBeVisible();
    if (entry.id === 'gemini') await expect(panel.getByText('使用服务端环境凭据', { exact: true })).toBeVisible();
    if (entry.id === 'ollama') {
      await expect(panel.getByText('未配置凭据', { exact: true })).toBeVisible();
      await expect(panel.getByRole('link', { name: '获取 API Key', exact: true })).toHaveAttribute('href', 'https://ollama.com/settings/keys');
    }
  }
  const save = panel.getByRole('button', { name: '保存配置', exact: true });
  const diagnose = panel.getByRole('button', { name: '测试搜索', exact: true });
  for (const name of ['DuckDuckGo', 'Firecrawl Free']) {
    await chooseProvider(page, name); await save.click();
    await expect(save).toBeDisabled(); await expect(diagnose).toBeEnabled();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    expect(fixture.writes.at(-1)).toEqual({ provider: name === 'DuckDuckGo' ? 'duckduckgo' : 'firecrawl-free' });
    await diagnose.click(); await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toBeVisible();
  }
  for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await panel.evaluate((element) => element.scrollTo(0, 0));
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.amp/in/artifacts/search-14-no-key-${device}-${info.project.name}.png`, animations: 'disabled' });
  }
  await chooseProvider(page, 'Codex Hosted Search'); await save.click();
  await expect(panel.getByText('未登录 · Codex', { exact: true })).toBeVisible();
  await expect(panel.getByText('搜索已启用，但当前服务尚未登录。请先登录 Codex。', { exact: true })).toBeVisible();
  await expect(diagnose).toBeDisabled();
  await panel.getByRole('switch', { name: '启用搜索服务', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await chooseProvider(page, 'Ollama Web Search'); await save.click();
  await panel.getByRole('switch', { name: '启用搜索服务', exact: true }).click();
  await expect(panel.getByText('搜索已启用，但当前服务尚未配置凭据。请先保存 API Key。', { exact: true })).toBeVisible();
  await expect(diagnose).toBeDisabled();
  expect(fixture.searches).toBe(2);
});

test('search model and region drafts survive tabs, toggle and failed saves, then restore per-provider saved options', async ({ page }, info) => {
  const fixture = await mockSearch(page, searchFixture('brave'));
  const { region, panel } = await openSearch(page);
  const model = panel.getByLabel('搜索模型', { exact: true });
  const serviceRegion = panel.getByLabel('服务区域', { exact: true });
  const regionValue = serviceRegion.locator('[data-slot="select-value"]');
  const key = panel.getByLabel('API Key', { exact: true });
  const toggle = panel.getByRole('switch', { name: '启用搜索服务', exact: true });
  const save = panel.getByRole('button', { name: '保存配置', exact: true });
  const diagnose = panel.getByRole('button', { name: '测试搜索', exact: true });
  await chooseProvider(page, 'Kimi');
  await model.fill('kimi-browser-draft'); await key.fill('synthetic-kimi-draft');
  await serviceRegion.click(); await page.getByRole('option', { name: '中国', exact: true }).click();
  await toggle.click(); await expect(toggle).not.toBeChecked();
  expect(fixture.writes.at(-1)).toEqual({ enabled: false }); expect(fixture.settings.provider).toBe('brave');
  await expect(model).toHaveValue('kimi-browser-draft'); await expect(key).toHaveValue('synthetic-kimi-draft');
  await expect(regionValue).toHaveText('中国');
  await region.getByRole('tab', { name: 'MCP', exact: true }).click();
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(model).toHaveValue('kimi-browser-draft'); await expect(key).toHaveValue('synthetic-kimi-draft');
  await expect(regionValue).toHaveText('中国'); await expect(diagnose).toBeDisabled();
  fixture.failWrite = true;
  await toggle.click(); await expect(panel.getByText('合成保存失败，请重试。', { exact: true })).toBeVisible();
  await expect(toggle).not.toBeChecked(); await expect(model).toHaveValue('kimi-browser-draft');
  await save.click(); await expect(panel.getByText('合成保存失败，请重试。', { exact: true })).toBeVisible();
  await expect(model).toHaveValue('kimi-browser-draft'); await expect(key).toHaveValue('synthetic-kimi-draft');
  await expect(regionValue).toHaveText('中国'); expect(fixture.settings.provider).toBe('brave');
  fixture.failWrite = false; await save.click(); await expect(save).toBeDisabled(); await expect(key).toHaveValue('');
  expect(fixture.writes.at(-1)).toEqual({ provider: 'kimi', apiKey: 'synthetic-kimi-draft', model: 'kimi-browser-draft', region: 'cn' });
  await toggle.click(); await expect(toggle).toBeChecked(); await diagnose.click();
  await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toBeVisible();
  await model.fill('kimi-next-draft');
  await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toHaveCount(0); await expect(diagnose).toBeDisabled();
  await model.fill('kimi-browser-draft'); await expect(save).toBeDisabled(); await diagnose.click();
  await serviceRegion.click(); await page.getByRole('option', { name: '全球', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '测试完成', exact: true })).toHaveCount(0); await expect(diagnose).toBeDisabled();
  await key.fill('synthetic-discarded-on-provider-switch');
  await chooseProvider(page, 'Gemini'); await expect(model).toHaveValue('gemini-3.6-flash'); await expect(serviceRegion).toHaveCount(0);
  await expect(key).toHaveValue('');
  await model.fill('gemini-unsaved'); await chooseProvider(page, 'Grok'); await expect(model).toHaveValue('grok-4.7');
  await chooseProvider(page, 'Gemini'); await expect(model).toHaveValue('gemini-3.6-flash');
  await chooseProvider(page, 'MiniMax Search'); await expect(model).toHaveCount(0); await expect(regionValue).toHaveText('全球');
  await chooseProvider(page, 'Kimi'); await expect(model).toHaveValue('kimi-browser-draft'); await expect(regionValue).toHaveText('中国');
  await expect(key).toHaveValue(''); await expect(save).toBeDisabled();
  for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height }); await panel.evaluate((element) => element.scrollTo(0, 0));
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.amp/in/artifacts/search-14-model-region-${device}-${info.project.name}.png`, animations: 'disabled' });
  }
});

async function mockCodex(page: Page, provider: SearchProvider = 'brave') {
  const search = await mockSearch(page, searchFixture(provider));
  const teaching: ModelSettings = { selection: { provider: 'synthetic', model: 'teaching-fixture', thinkingLevel: 'high' }, ready: true, issue: null,
    providers: [{ id: 'synthetic', name: 'Teaching fixture', models: 1, auth: {}, stored: null, configured: { type: 'api_key' } }] };
  const fixture = { search, teaching, teachingWrites: 0, starts: 0, polls: 0, answers: [] as unknown[], cancellations: [] as string[], logouts: 0,
    holdStart: false, holdCancelTerminal: false, failTeachingRead: false, releaseStart: undefined as (() => void) | undefined };
  const sessions = new Map<string, LoginSession>(), cancelled = new Set<string>(), answered = new Set<string>();
  await page.route('**/api/settings/model', (route) => {
    if (route.request().method() === 'POST') fixture.teachingWrites++;
    else if (fixture.failTeachingRead) return route.fulfill({ status: 503, json: { error: '合成模型状态读取失败' } });
    return route.fulfill({ json: teaching });
  });
  await page.route('**/api/settings/providers/synthetic/models', (route) => route.fulfill({ json: [
    { id: 'teaching-fixture', name: 'Teaching fixture', reasoning: true, thinkingLevels: ['low', 'high'], contextWindow: 128000, maxTokens: 8192, input: ['text'] },
  ] }));
  const setAccount = (configured: 'account' | null) => {
    search.settings = { ...search.settings, providers: search.settings.providers.map((entry) => entry.id === 'codex' ? { ...entry, configured, ready: !!configured } : entry) };
  };
  await page.route('**/api/settings/providers/openai-codex/login', async (route) => {
    expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({ type: 'oauth' });
    const id = `00000000-0000-4000-8000-${String(++fixture.starts).padStart(12, '0')}`;
    const session: LoginSession = { id, providerId: 'openai-codex', type: 'oauth', state: 'running', error: null,
      events: [{ type: 'auth_url', url: 'https://auth.example.test/codex', instructions: '使用合成授权页面完成登录。' }],
      prompt: { id: '00000000-0000-4000-8000-000000000099', type: 'manual_code', message: '输入合成授权码', placeholder: '合成授权码' } };
    sessions.set(id, session);
    if (fixture.holdStart) await new Promise<void>((resolve) => { fixture.releaseStart = resolve; });
    return route.fulfill({ json: session });
  });
  await page.route('**/api/settings/login/**', async (route) => {
    const path = new URL(route.request().url()).pathname, id = path.split('/')[4]!;
    const session = sessions.get(id)!;
    expect(session).toBeDefined();
    if (path.endsWith('/answer')) {
      expect(route.request().method()).toBe('POST');
      fixture.answers.push(route.request().postDataJSON()); answered.add(id);
      return route.fulfill({ json: { ...session, prompt: null } });
    }
    if (path.endsWith('/cancel')) {
      expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
      fixture.cancellations.push(id); cancelled.add(id);
      return route.fulfill({ json: session });
    }
    expect(route.request().method()).toBe('GET'); fixture.polls++;
    if (cancelled.has(id) && !fixture.holdCancelTerminal) return route.fulfill({ json: { ...session, state: 'cancelled', prompt: null } });
    if (answered.has(id)) { setAccount('account'); return route.fulfill({ json: { ...session, state: 'succeeded', prompt: null } }); }
    return route.fulfill({ json: session });
  });
  await page.route('**/api/settings/providers/openai-codex/logout', (route) => {
    expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
    fixture.logouts++; setAccount(null); return route.fulfill({ json: teaching });
  });
  return fixture;
}

test('returning to settings refreshes shared account readiness without replacing model/search drafts', async ({ page }) => {
  const fixture = await mockCodex(page, 'codex');
  const { region, panel } = await openSearch(page);
  await expect(panel.getByText('未登录 · Codex', { exact: true })).toBeVisible();
  const diagnose = panel.getByRole('button', { name: '测试搜索', exact: true });
  await expect(diagnose).toBeDisabled();
  await chooseProvider(page, 'Kimi');
  await panel.getByLabel('搜索模型', { exact: true }).fill('kimi-preserved-draft');
  await panel.getByLabel('API Key', { exact: true }).fill('synthetic-preserved-key');
  await panel.getByLabel('服务区域', { exact: true }).click(); await page.getByRole('option', { name: '中国', exact: true }).click();
  // Model login/logout updates this same server-side account while the search form is inactive.
  await region.getByRole('tab', { name: '模型配置', exact: true }).click();
  await expect(region.getByLabel('模型', { exact: true })).toHaveText('Teaching fixture');
  fixture.search.settings.providers = fixture.search.settings.providers.map((entry) => entry.id === 'codex'
    ? { ...entry, configured: 'account', ready: true } : entry.id === 'kimi' ? { ...entry, configured: 'environment' } : entry);
  fixture.teaching.providers[0]!.configured = null;
  fixture.teaching.ready = false; fixture.teaching.issue = { code: 'MODEL_CREDENTIALS_MISSING' };
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(panel.getByLabel('搜索模型', { exact: true })).toHaveValue('kimi-preserved-draft');
  await expect(panel.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-preserved-key');
  await expect(panel.getByLabel('服务区域', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('中国');
  await expect(panel.getByText('使用服务端环境凭据', { exact: true })).toBeVisible();
  await chooseProvider(page, 'Codex Hosted Search');
  await expect(panel.getByText('已登录 · Codex', { exact: true })).toBeVisible(); await expect(diagnose).toBeEnabled();
  await region.getByRole('tab', { name: '模型配置', exact: true }).click();
  await expect(region.getByText('合成教学凭据已移除', { exact: true })).toBeVisible();
  await expect(region.getByLabel('模型', { exact: true })).toHaveText('Teaching fixture');
  await expect(region.getByRole('button', { name: '保存选择', exact: true })).toBeDisabled();
  fixture.search.settings.providers = fixture.search.settings.providers.map((entry) => entry.id === 'codex' ? { ...entry, configured: null, ready: false } : entry);
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(panel.getByText('未登录 · Codex', { exact: true })).toBeVisible(); await expect(diagnose).toBeDisabled();
  await region.getByRole('tab', { name: '模型配置', exact: true }).click();
  const level = region.getByLabel('推理强度', { exact: true });
  await level.click(); await page.getByRole('option', { name: '低', exact: true }).click();
  fixture.failTeachingRead = true;
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await region.getByRole('tab', { name: '模型配置', exact: true }).click();
  await expect(region.getByText('合成模型状态读取失败', { exact: true })).toBeVisible();
  await expect(region.getByLabel('模型', { exact: true })).toHaveText('Teaching fixture');
  await expect(level.locator('[data-slot="select-value"]')).toHaveText('低');
  await expect(region.getByRole('button', { name: '保存选择', exact: true })).toBeEnabled();
  expect(fixture.starts).toBe(0); expect(fixture.teachingWrites).toBe(0); expect(fixture.search.writes).toEqual([]);
});

test('Codex OAuth uses existing login routes without selecting a teaching model; answers and sources are safe text', async ({ page }, info) => {
  const fixture = await mockCodex(page);
  const errors: string[] = [], remoteImages: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.url().startsWith('https://evil.example/')) remoteImages.push(request.url()); });
  const { region, panel } = await openSearch(page);
  await chooseProvider(page, 'Codex Hosted Search');
  const login = panel.getByRole('button', { name: '登录 Codex', exact: true });
  const save = panel.getByRole('button', { name: '保存配置', exact: true });
  const diagnose = panel.getByRole('button', { name: '测试搜索', exact: true });
  await login.click();
  await expect(panel.getByRole('link', { name: '打开授权页面', exact: true })).toHaveAttribute('href', 'https://auth.example.test/codex');
  await expect(login).toBeDisabled(); await expect(save).toBeDisabled(); await expect(diagnose).toBeDisabled();
  await expect(panel.getByRole('switch', { name: '启用搜索服务', exact: true })).toBeDisabled();
  await expect.poll(() => fixture.polls).toBeGreaterThan(0); expect(fixture.starts).toBe(1);
  for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('section[aria-label="应用设置"]')).toHaveCount(1);
    await expect(region.getByRole('tablist')).toHaveAttribute('data-orientation', width >= 768 ? 'vertical' : 'horizontal');
    await expect.poll(() => region.boundingBox()).toEqual({ x: 0, y: 0, width, height });
    await panel.evaluate((element) => element.scrollTo(0, 0));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `.amp/in/artifacts/search-14-codex-login-${device}-${info.project.name}.png`, animations: 'disabled' });
  }
  await panel.getByPlaceholder('合成授权码', { exact: true }).fill('synthetic-oauth-answer');
  await panel.getByRole('button', { name: '提交', exact: true }).click();
  await expect(panel.getByText('已登录 · Codex', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled(); await expect(diagnose).toBeDisabled(); // Codex remains an unsaved search provider draft.
  await expect(panel.getByLabel('搜索服务商', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('Codex Hosted Search');
  expect(fixture.search.settings.provider).toBe('brave'); expect(fixture.search.writes).toEqual([]);
  expect(fixture.answers).toEqual([{ promptId: '00000000-0000-4000-8000-000000000099', value: 'synthetic-oauth-answer' }]);
  await save.click(); await expect(diagnose).toBeEnabled();
  let withSources = true, securityPayload = true;
  const answer = '合成搜索回答\n  保留缩进与换行。\n<script>window.searchAnswerExecuted=true</script>\n<img src="https://evil.example/track.png" onerror="window.searchAnswerExecuted=true">\n![追踪图](https://evil.example/markdown.png)\n' + 'long-unbroken-answer-'.repeat(35);
  const previewAnswer = 'Rust 官方文档主要包括《Rust 程序设计语言》和标准库 API 文档。\n\n入门学习可以从 Rust Book 开始，再按需要查询标准库中的类型与方法。';
  await page.route('**/api/settings/search/test', (route) => route.fulfill({ json: { provider: 'codex', query: 'Rust official documentation', tookMs: 23, untrusted: true,
    answer: securityPayload ? answer : previewAnswer,
    results: withSources ? [
      { title: 'Rust 官方来源', url: 'https://doc.rust-lang.org/book/', snippet: securityPayload ? '<img src="https://evil.example/snippet.png">只显示文本' : 'Rust Book：从基础概念到实际项目。' },
      securityPayload ? { title: '不安全协议来源', url: 'javascript:window.searchAnswerExecuted=true', snippet: '' }
        : { title: 'Rust 标准库', url: 'https://doc.rust-lang.org/std/', snippet: '标准库类型、函数与模块的 API 参考。' },
    ] : [] } }));
  await diagnose.click();
  const answerText = panel.getByText(answer, { exact: true });
  await expect(answerText).toBeVisible(); expect(await answerText.textContent()).toBe(answer);
  await expect(answerText).toHaveCSS('white-space', 'pre-wrap');
  await expect(panel.getByText('Codex Hosted Search · 已生成回答 · 2 条来源 · 23 ms', { exact: true })).toBeVisible();
  await expect(panel.getByText('23 ms', { exact: true })).toHaveCSS('white-space', 'nowrap');
  await expect(panel.getByRole('link', { name: 'Rust 官方来源', exact: true })).toHaveAttribute('href', 'https://doc.rust-lang.org/book/');
  await expect(panel.getByText('不安全协议来源', { exact: true }).locator('..')).not.toHaveAttribute('href');
  await expect(panel.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => 'searchAnswerExecuted' in window)).toBe(false); expect(remoteImages).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // Capture readable UI fixtures only after exercising the malicious answer above.
  securityPayload = false; await diagnose.click(); await expect(panel.getByText(previewAnswer, { exact: true })).toBeVisible();
  const resultCard = panel.locator('[aria-live="polite"]');
  for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await resultCard.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `.amp/in/artifacts/search-14-codex-result-${device}-${info.project.name}.png`, animations: 'disabled' });
    if (device === 'mobile') {
      await panel.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await page.screenshot({ path: `.amp/in/artifacts/search-14-codex-sources-mobile-${info.project.name}.png`, animations: 'disabled' });
    }
  }
  withSources = false; await diagnose.click();
  await expect(panel.getByText('Codex Hosted Search · 已生成回答 · 0 条来源 · 23 ms', { exact: true })).toBeVisible();
  await expect(panel.getByText('服务已响应，但没有找到匹配的结果。', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(panel.getByText('未登录 · Codex', { exact: true })).toBeVisible(); await expect(diagnose).toBeDisabled(); expect(fixture.logouts).toBe(1);
  await region.getByRole('tab', { name: '模型配置', exact: true }).click();
  await expect(region.getByLabel('模型', { exact: true })).toHaveText('Teaching fixture');
  await expect(region.getByRole('button', { name: '保存选择', exact: true })).toBeDisabled();
  expect(fixture.teachingWrites).toBe(0); expect(errors).toEqual([]);
});

test('Codex cancellation waits for terminal state and cancels on provider switch, inactivity and unmount', async ({ page }) => {
  const fixture = await mockCodex(page, 'codex');
  const { region, panel } = await openSearch(page);
  const login = panel.getByRole('button', { name: '登录 Codex', exact: true });
  fixture.holdCancelTerminal = true;
  await login.click(); await panel.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect.poll(() => fixture.cancellations.length).toBe(1);
  await expect.poll(() => fixture.polls).toBeGreaterThan(0); await expect(login).toBeDisabled();
  await panel.getByPlaceholder('合成授权码', { exact: true }).fill('must-not-submit-while-cancelling');
  await expect(panel.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '取消登录', exact: true }).click();
  expect(fixture.cancellations).toHaveLength(1); expect(fixture.answers).toEqual([]);
  fixture.holdCancelTerminal = false;
  await expect(panel.getByText('已取消。', { exact: true })).toBeVisible(); await expect(login).toBeEnabled();
  const terminalPolls = fixture.polls; await page.waitForTimeout(1000); expect(fixture.polls).toBe(terminalPolls);

  await login.click(); await expect(panel.getByPlaceholder('合成授权码', { exact: true })).toBeVisible();
  await chooseProvider(page, 'Kimi'); await expect.poll(() => fixture.cancellations.length).toBe(2);
  await expect(panel.getByLabel('搜索模型', { exact: true })).toHaveValue('kimi-k2.6');
  const switchedPolls = fixture.polls; await page.waitForTimeout(1000); expect(fixture.polls).toBe(switchedPolls);
  await chooseProvider(page, 'Codex Hosted Search'); await login.click();
  await expect(panel.getByPlaceholder('合成授权码', { exact: true })).toBeVisible();
  await region.getByRole('tab', { name: 'MCP', exact: true }).click(); await expect.poll(() => fixture.cancellations.length).toBe(3);
  const inactivePolls = fixture.polls; await page.waitForTimeout(1000); expect(fixture.polls).toBe(inactivePolls);
  await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
  await expect(panel.getByPlaceholder('合成授权码', { exact: true })).toHaveCount(0);
  await login.click(); await expect(panel.getByPlaceholder('合成授权码', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: '返回', exact: true }).click(); await expect.poll(() => fixture.cancellations.length).toBe(4);
  const unmountedPolls = fixture.polls; await page.waitForTimeout(1000); expect(fixture.polls).toBe(unmountedPolls);
  expect(fixture.teachingWrites).toBe(0); expect(fixture.search.writes).toEqual([]);
});

for (const leave of ['provider', 'tab', 'unmount'] as const) {
  test(`Codex late login-start response is cancelled after ${leave} departure`, async ({ page }) => {
    const fixture = await mockCodex(page, 'codex'); fixture.holdStart = true;
    const { region, panel } = await openSearch(page);
    await panel.getByRole('button', { name: '登录 Codex', exact: true }).click();
    await expect.poll(() => fixture.starts).toBe(1);
    await expect(panel.getByRole('button', { name: '登录 Codex', exact: true })).toBeDisabled();
    if (leave === 'provider') await chooseProvider(page, 'DuckDuckGo');
    if (leave === 'tab') await region.getByRole('tab', { name: 'MCP', exact: true }).click();
    if (leave === 'unmount') await region.getByRole('button', { name: '返回', exact: true }).click();
    fixture.releaseStart!();
    await expect.poll(() => fixture.cancellations.length).toBe(1);
    await page.waitForTimeout(1000); expect(fixture.polls).toBe(0);
    if (leave === 'tab') await region.getByRole('tab', { name: '搜索服务', exact: true }).click();
    if (leave !== 'unmount') await expect(panel.getByPlaceholder('合成授权码', { exact: true })).toHaveCount(0);
    expect(fixture.teachingWrites).toBe(0); expect(fixture.search.writes).toEqual([]);
  });
}

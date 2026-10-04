import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LoginSession, ModelSettings, ModelSummary } from '../../packages/contracts/src/settings';
import type { seedWorkspaces } from '../seed-workspaces';

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['tablet', { width: 820, height: 1180 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`model settings load, fit ${name} and restore the saved selection`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    // Seed only this disposable server, without logging in or making model requests.
    const status = await page.evaluate(async () => {
      const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
      return (await fetch('/api/settings/model', { method: 'POST', headers: { 'X-TMC-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openrouter', model: 'stealth/space-bunny-alpha', thinkingLevel: 'low' }) })).status;
    });
    expect(status).toBe(200);
    const homeInput = page.getByRole('textbox', { name: '你想学什么', exact: true });
    await homeInput.fill('保留未发送的学习需求');
    await page.getByRole('button', { name: '应用设置', exact: true }).click();
    const settingsPage = page.getByRole('region', { name: '应用设置', exact: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(homeInput).toBeHidden();
    await expect(settingsPage.getByLabel('Provider', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('OpenRouter');
    await expect(settingsPage.getByLabel('推理强度', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('低');
    await expect(settingsPage.getByLabel('模型', { exact: true })).toHaveValue('Space Bunny Alpha');
    expect(await settingsPage.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    expect(await settingsPage.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(settingsPage.getByRole('tablist')).toHaveAttribute('data-orientation', viewport.width >= 768 ? 'vertical' : 'horizontal');
    await settingsPage.getByRole('tab', { name: '模型配置', exact: true }).focus();
    await page.keyboard.press(viewport.width >= 768 ? 'ArrowDown' : 'ArrowRight');
    await expect(settingsPage.getByRole('tab', { name: 'MCP', exact: true })).toBeFocused();
    await settingsPage.getByRole('tab', { name: '模型配置', exact: true }).click();
    await settingsPage.getByLabel('Provider', { exact: true }).click();
    const providerOption = page.locator('[data-slot="select-content"]').getByRole('option', { name: /OpenRouter/ });
    await expect(providerOption).toBeVisible();
    await providerOption.click();
    await settingsPage.getByLabel('模型', { exact: true }).fill('space-bunny');
    const popup = page.locator('[data-slot="combobox-content"]');
    const modelOption = popup.getByRole('option').filter({ hasText: 'stealth/space-bunny-alpha' });
    await expect(modelOption).toBeVisible();
    expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `.amp/in/artifacts/settings-search-${name}-${info.project.name}.png`, animations: 'disabled' });
    await modelOption.click();
    await settingsPage.getByLabel('推理强度', { exact: true }).click();
    await page.getByRole('option', { name: '高', exact: true }).click();
    // Categories must not discard an unsaved model choice or show the model form in a placeholder.
    for (const category of ['MCP', 'Skills']) {
      const tab = settingsPage.getByRole('tab', { name: category, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = settingsPage.getByRole('tabpanel', { name: category, exact: true });
      await expect(panel.getByText('功能待开发', { exact: true })).toBeVisible();
      await expect(settingsPage.getByLabel('Provider', { exact: true })).toBeHidden();
      await page.screenshot({ path: `.amp/in/artifacts/settings-${category.toLowerCase()}-${name}-${info.project.name}.png`, animations: 'disabled' });
    }
    await settingsPage.getByRole('tab', { name: '模型配置', exact: true }).click();
    await expect(settingsPage.getByLabel('推理强度', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('高');
    await expect(settingsPage.getByRole('button', { name: '保存选择', exact: true })).toBeEnabled();
    await settingsPage.getByRole('button', { name: '保存选择', exact: true }).click();
    await expect(settingsPage.getByRole('button', { name: '保存选择', exact: true })).toBeDisabled();
    await settingsPage.getByRole('button', { name: '返回学习', exact: true }).click();
    await expect(homeInput).toHaveValue('保留未发送的学习需求');
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused();
    await page.reload();
    await page.getByRole('button', { name: '应用设置', exact: true }).click();
    await expect(settingsPage.getByLabel('Provider', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('OpenRouter');
    await expect(settingsPage.getByLabel('推理强度', { exact: true }).locator('[data-slot="select-value"]')).toHaveText('高');
    await expect(settingsPage.getByLabel('模型', { exact: true })).toHaveValue('Space Bunny Alpha');
    const oauth = settingsPage.getByRole('button', { name: 'Sign in with OpenRouter', exact: true });
    await oauth.scrollIntoViewIfNeeded();
    expect((await oauth.boundingBox())!.y + (await oauth.boundingBox())!.height).toBeLessThanOrEqual(viewport.height);
    expect((await settingsPage.getByRole('heading', { name: '设置', exact: true }).boundingBox())!.y).toBeLessThan(64);
    await settingsPage.getByRole('tabpanel', { name: '模型配置', exact: true }).evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: `.amp/in/artifacts/settings-page-${name}-${info.project.name}.png`, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

test('settings cancellation waits for its terminal state and credential removal uses POST', async ({ page }) => {
  let cancelled = false;
  const methods: string[] = [];
  const settings: ModelSettings = {
    selection: { provider: 'synthetic', model: 'fixture-v1', thinkingLevel: 'high' }, ready: true, issue: null,
    providers: [{ id: 'synthetic', name: 'Synthetic Provider', models: 1, stored: 'api_key', configured: { type: 'api_key' }, auth: { apiKey: { name: 'Fixture key', login: true } } }],
  };
  const models: ModelSummary[] = [{ id: 'fixture-v1', name: 'Fixture Model', reasoning: true, thinkingLevels: ['high'], contextWindow: 128000, maxTokens: 8192, input: ['text'] }];
  const login: LoginSession = { id: '00000000-0000-4000-8000-000000000001', providerId: 'synthetic', type: 'api_key', state: 'running', events: [], error: null,
    prompt: { id: '00000000-0000-4000-8000-000000000002', type: 'secret', message: 'Enter a synthetic key.' } };
  await page.route('**/api/settings/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/settings/model' && method === 'GET') return json(settings);
    if (path.endsWith('/models') && method === 'GET') return json(models);
    if (path.endsWith('/login') && method === 'POST') { cancelled = false; return json(login); }
    if (path.endsWith('/cancel')) {
      methods.push(`${method} cancel`);
      if (method !== 'POST') return route.fulfill({ status: 405, json: { error: 'POST required' } });
      cancelled = true;
      // The real service can acknowledge abort before the login promise settles.
      return json(login);
    }
    if (path.endsWith(`/login/${login.id}`) && method === 'GET') return json(cancelled ? { ...login, state: 'cancelled', prompt: null } : login);
    if (path.endsWith('/logout')) {
      methods.push(`${method} logout`);
      if (method !== 'POST') return route.fulfill({ status: 405, json: { error: 'POST required' } });
      settings.providers[0]!.stored = null; settings.providers[0]!.configured = null;
      settings.ready = false; settings.issue = '尚未配置凭据。';
      return json(settings);
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected settings request' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settingsPage = page.getByRole('region', { name: '应用设置', exact: true });
  await settingsPage.getByRole('button', { name: '输入 API Key', exact: true }).click();
  await expect(settingsPage.getByText('Enter a synthetic key.', { exact: true })).toBeVisible();
  await settingsPage.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(settingsPage.getByText('已取消。', { exact: true })).toBeVisible();
  await settingsPage.getByRole('button', { name: '清除已存凭据', exact: true }).click();
  await expect(settingsPage.getByRole('button', { name: '清除已存凭据', exact: true })).toHaveCount(0);
  await expect(settingsPage.getByText('未配置凭据', { exact: true })).toBeVisible();
  expect(methods).toEqual(['POST cancel', 'POST logout']);
});

test('settings preserves the current unit, unsaved code, conversation input and PTY connection', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  // Other browser tests rename seeded files and stop their shell; use a dedicated file and restart if needed.
  writeFileSync(join(seed.root, 'projects', seed.spaceId, 'settings-navigation.rs'), '// saved settings fixture');
  await page.setViewportSize({ width: 1440, height: 1000 });
  let socketCount = 0, closed = 0;
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/terminal/socket')) { socketCount++; socket.on('close', () => closed++); }
  });
  const url = `/?space=${seed.spaceId}&tab=unit&unit=${seed.unitIds[0]}`;
  await page.goto(url);
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  const tree = page.getByRole('tree', { name: '项目目录树', exact: true });
  await tree.getByRole('treeitem', { name: 'settings-navigation.rs', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑 settings-navigation.rs', exact: true });
  const composer = page.getByRole('textbox', { name: '向 Agent 提问', exact: true });
  await expect(page.getByRole('textbox', { name: '本机终端输入', exact: true })).toBeEnabled();
  await expect.poll(() => socketCount).toBe(1);
  await expect(page.getByText('本机终端 · 非沙箱', { exact: true })).toBeVisible();
  const restart = page.getByRole('button', { name: '新建终端', exact: true });
  if (await restart.isVisible()) await restart.click();
  await expect(page.getByRole('button', { name: '停止终端', exact: true })).toBeEnabled();
  await editor.fill('// unsaved settings navigation');
  await composer.fill('保留本单元未发送的问题');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect(editor).toBeHidden();
  const settingsPage = page.getByRole('region', { name: '应用设置', exact: true });
  await settingsPage.getByRole('tab', { name: 'Skills', exact: true }).click();
  await expect(settingsPage.getByRole('tabpanel', { name: 'Skills', exact: true }).getByText('功能待开发', { exact: true })).toBeVisible();
  await settingsPage.getByRole('button', { name: '返回学习', exact: true }).click();
  await expect(editor).toHaveValue('// unsaved settings navigation');
  await expect(composer).toHaveValue('保留本单元未发送的问题');
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '本机终端输入', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(url);
  expect({ socketCount, closed }).toEqual({ socketCount: 1, closed: 0 });
});

for (const exit of ['category', 'back', 'late-response'] as const) {
  test(`leaving model settings cancels login (${exit})`, async ({ page }) => {
    let release: (() => void) | undefined;
    let started = false, cancelled = false, polls = 0;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const settings: ModelSettings = {
      selection: { provider: 'synthetic', model: 'fixture-v1', thinkingLevel: 'high' }, ready: false, issue: '尚未配置凭据。',
      providers: [{ id: 'synthetic', name: 'Synthetic Provider', models: 1, stored: null, configured: null, auth: { apiKey: { name: 'Fixture key', login: true } } }],
    };
    const login: LoginSession = { id: '00000000-0000-4000-8000-000000000011', providerId: 'synthetic', type: 'api_key', state: 'running', events: [], error: null,
      prompt: { id: '00000000-0000-4000-8000-000000000012', type: 'secret', message: 'Synthetic login in progress' } };
    await page.route('**/api/settings/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/settings/model') return route.fulfill({ json: settings });
      if (path.endsWith('/models')) return route.fulfill({ json: [] });
      if (path.endsWith('/login')) { started = true; if (exit === 'late-response') await wait; return route.fulfill({ json: login }); }
      if (path.endsWith('/cancel')) { expect(route.request().method()).toBe('POST'); cancelled = true; return route.fulfill({ json: login }); }
      polls++; return route.fulfill({ json: login });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '应用设置', exact: true }).click();
    const settingsPage = page.getByRole('region', { name: '应用设置', exact: true });
    await settingsPage.getByRole('button', { name: '输入 API Key', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    if (exit !== 'late-response') await expect(settingsPage.getByText('Synthetic login in progress')).toBeVisible();
    if (exit === 'category') await settingsPage.getByRole('tab', { name: 'MCP', exact: true }).click();
    else await settingsPage.getByRole('button', { name: '返回学习', exact: true }).click();
    release!();
    await expect.poll(() => cancelled).toBe(true);
    const count = polls;
    await page.waitForTimeout(1000); // Span one scheduled poll to check cleanup, not just the cancel request.
    expect(polls).toBe(count);
  });
}

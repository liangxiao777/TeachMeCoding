import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings/skills/leaderboard?*', (route) => route.fulfill({ json: {
    skills: [{ id: 'fixture/repo/browse-fixture', source: 'fixture/repo', skillId: 'browse-fixture', name: 'browse-fixture', installs: 93 }],
    page: 0, hasMore: false, total: 1,
  } }));
});

test('Skills discovery installs a real bundle, preserves drafts and manages updates, resources and uninstall', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const source = join(seed.root, 'catalog-fixture', 'reviewing-arrays');
  mkdirSync(join(source, 'reference'), { recursive: true });
  const original = '---\nname: reviewing-arrays\ndescription: Explain array indexing when reviewing learner code.\n---\nRead reference/indexing.md before explaining an index.';
  writeFileSync(join(source, 'SKILL.md'), original);
  writeFileSync(join(source, 'reference/indexing.md'), 'Use index 3 for the fourth array element.');
  const catalog = { id: 'fixture/teaching-skills/reviewing-arrays', source, skillId: 'reviewing-arrays', name: 'reviewing-arrays', installs: 1379 };
  let outage = true;
  await page.route('**/api/settings/skills/search?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('q')).toBe('array');
    await route.fulfill({ status: outage ? 503 : 200, json: outage ? { error: '暂时无法搜索 skills.sh，请重试。' } : { skills: [catalog] } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await expect(settings.getByRole('tab', { name: /^已安装/ })).toHaveAttribute('aria-selected', 'true');
  const installedTab = (await settings.getByRole('tab', { name: /^已安装/ }).boundingBox())!;
  const discoveryTab = (await settings.getByRole('tab', { name: '技能市场', exact: true }).boundingBox())!;
  expect(discoveryTab.y).toBe(installedTab.y);
  expect(discoveryTab.x).toBeGreaterThan(installedTab.x);
  await expect(settings.getByRole('textbox', { name: /路径/ })).toHaveCount(0);
  await settings.getByRole('tab', { name: '技能市场', exact: true }).click();
  await settings.getByRole('textbox', { name: '搜索 skills.sh', exact: true }).fill('array');
  await settings.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('暂时无法搜索 skills.sh，请重试。');
  await expect(settings.getByText('没有找到相关技能', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/skills-search-error-${info.project.name}.png`, animations: 'disabled' });
  outage = false;
  await settings.getByRole('button', { name: '重试', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'reviewing-arrays', exact: true })).toBeVisible();
  await expect(settings.getByLabel('1,379 次安装', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '安装 reviewing-arrays', exact: true }).click();
  await expect(settings.getByText('已安装', { exact: true }).last()).toBeVisible();
  await expect(settings.getByRole('button', { name: '安装 reviewing-arrays', exact: true })).toHaveCount(0);
  const installedFile = join(seed.root, 'skills/reviewing-arrays/SKILL.md');
  expect(readFileSync(installedFile, 'utf8')).toBe(original);
  expect(readFileSync(join(seed.root, 'skills/reviewing-arrays/reference/indexing.md'), 'utf8')).toBe('Use index 3 for the fourth array element.');
  await settings.getByRole('tab', { name: /^已安装/ }).click();
  const row = settings.getByRole('listitem', { name: 'reviewing-arrays', exact: true });
  await expect(row.getByRole('switch', { name: '启用 reviewing-arrays', exact: true })).toBeChecked();
  const actions = row.getByRole('button', { name: '管理 reviewing-arrays', exact: true });
  expect((await actions.boundingBox())!.x).toBeLessThan((await row.getByRole('switch').boundingBox())!.x);
  await page.screenshot({ path: `.amp/in/artifacts/skills-installed-light-${info.project.name}.png`, animations: 'disabled' });
  await actions.click();
  await page.getByRole('menuitem', { name: '查看详情', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('技能文件内容', { exact: true })).toContainText(original);
  await dialog.getByRole('combobox', { name: '技能文件', exact: true }).click();
  await page.getByRole('option', { name: 'reference/indexing.md', exact: true }).click();
  await expect(dialog.getByLabel('技能文件内容', { exact: true })).toHaveText('Use index 3 for the fourth array element.');
  await page.screenshot({ path: `.amp/in/artifacts/skills-resource-${info.project.name}.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(actions).toBeFocused();
  writeFileSync(join(source, 'reference/indexing.md'), 'An updated upstream example uses index 5.');
  await actions.click();
  await page.getByRole('menuitem', { name: '检查更新', exact: true }).click();
  await expect(dialog.getByText('发现新版本', { exact: true })).toBeVisible();
  expect(readFileSync(join(seed.root, 'skills/reviewing-arrays/reference/indexing.md'), 'utf8')).toBe('Use index 3 for the fourth array element.');
  await dialog.getByRole('button', { name: '更新技能', exact: true }).click();
  await expect(dialog.getByText('已是最新版本', { exact: true })).toBeVisible();
  expect(readFileSync(join(seed.root, 'skills/reviewing-arrays/reference/indexing.md'), 'utf8')).toBe('An updated upstream example uses index 5.');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  writeFileSync(installedFile, `${original}\nKeep my local instruction.`);
  writeFileSync(join(source, 'reference/indexing.md'), 'Next upstream update.');
  await actions.click();
  await page.getByRole('menuitem', { name: '检查更新', exact: true }).click();
  await expect(dialog.getByText('检测到本地改动，更新不会覆盖这些文件。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '更新技能', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `.amp/in/artifacts/skills-modified-mobile-${info.project.name}.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await row.getByRole('switch', { name: '启用 reviewing-arrays', exact: true }).click();
  await expect(row.getByRole('switch', { name: '启用 reviewing-arrays', exact: true })).not.toBeChecked();
  await settings.getByRole('button', { name: '切换到暗色主题', exact: true }).click();
  expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `.amp/in/artifacts/skills-installed-dark-mobile-${info.project.name}.png`, animations: 'disabled' });
  await settings.getByRole('button', { name: '从链接安装', exact: true }).click();
  const link = dialog.getByLabel('来源链接', { exact: true });
  await link.fill('--global');
  await dialog.getByRole('button', { name: '安装技能', exact: true }).click();
  await expect(dialog.getByText('请填写 skills.sh 链接、HTTPS 仓库链接或 owner/repo。', { exact: true })).toBeVisible();
  await expect(link).toHaveValue('--global');
  await link.fill('https://skills.sh/example/repo/reviewing-code');
  await page.screenshot({ path: `.amp/in/artifacts/skills-link-mobile-${info.project.name}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(settings.getByRole('button', { name: '从链接安装', exact: true })).toBeFocused();
  // Settings own a URL, so a reload stays on the settings page.
  await page.reload();
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await expect(row.getByRole('switch', { name: '启用 reviewing-arrays', exact: true })).not.toBeChecked();
  await actions.click();
  await page.getByRole('menuitem', { name: '卸载', exact: true }).click();
  await dialog.getByRole('button', { name: '卸载技能', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0); expect(existsSync(installedFile)).toBe(false);
  expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
  await settings.getByRole('button', { name: '导入本地目录', exact: true }).click();
  await dialog.getByLabel('目录或 SKILL.md 路径', { exact: true }).fill(source);
  await dialog.getByRole('button', { name: '添加目录', exact: true }).click();
  await expect(row.getByText('本地目录', { exact: true })).toBeVisible();
  await actions.click(); await page.getByRole('menuitem', { name: '移除', exact: true }).click();
  await expect(dialog.getByText('仅移除应用中的引用，原始文件会保留。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '移除引用', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0); expect(existsSync(join(source, 'SKILL.md'))).toBe(true);
});

test('late skill search responses cannot replace results for a newer query', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done });
  let firstReceived!: () => void;
  const started = new Promise<void>((done) => { firstReceived = done });
  await page.route('**/api/settings/skills/search?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'old') { firstReceived(); await gate; }
    await route.fulfill({ json: { skills: [{ id: `source/repo/${q}`, source: 'source/repo', skillId: q, name: q, installs: 31 }] } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await settings.getByRole('tab', { name: '技能市场', exact: true }).click();
  const query = settings.getByRole('textbox', { name: '搜索 skills.sh', exact: true });
  await query.fill('old'); await settings.getByRole('button', { name: '搜索', exact: true }).click(); await started;
  await query.fill('new'); await settings.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'new', exact: true })).toBeVisible();
  const received = page.waitForResponse((response) => new URL(response.url()).searchParams.get('q') === 'old');
  release(); await received;
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(settings.getByRole('heading', { name: 'new', exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'old', exact: true })).toHaveCount(0);
});

test('single Markdown references select their actual filename and recover a failed details request', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const directory = join(seed.root, 'single-reference'); mkdirSync(directory);
  const filePath = join(directory, 'conditions.md');
  writeFileSync(filePath, '---\nname: explaining-conditions\ndescription: Explain conditions when reviewing branch decisions.\n---\nCompare 7 with the threshold 5.');
  await page.goto('/'); await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await settings.getByRole('button', { name: '导入本地目录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('目录或 SKILL.md 路径', { exact: true }).fill(filePath);
  await dialog.getByRole('button', { name: '添加目录', exact: true }).click();
  let unavailable = true;
  const detailsUrl = '**/api/settings/skills/details?*';
  await page.route(detailsUrl, (route) => unavailable ? route.fulfill({ status: 503, json: { error: '暂时无法读取技能。' } }) : route.continue());
  await settings.getByRole('button', { name: '管理 explaining-conditions', exact: true }).click();
  await page.getByRole('menuitem', { name: '查看详情', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法读取技能。');
  unavailable = false;
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '技能文件', exact: true })).toContainText('conditions.md');
  await expect(dialog.getByLabel('技能文件内容', { exact: true })).toContainText('Compare 7 with the threshold 5.');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  if (info.project.name === 'development') {
    // Strict Mode starts a second initial read. A late failure from the first must not replace its success.
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.unroute(detailsUrl);
    let first = true, release!: () => void;
    const gate = new Promise<void>((done) => { release = done });
    await page.route(detailsUrl, async (route) => {
      if (!first) return route.continue();
      first = false; await gate;
      await route.fulfill({ status: 503, json: { error: '迟到的旧请求失败。' } });
    });
    await settings.getByRole('button', { name: '管理 explaining-conditions', exact: true }).click();
    await page.getByRole('menuitem', { name: '查看详情', exact: true }).click();
    await expect(dialog.getByLabel('技能文件内容', { exact: true })).toContainText('Compare 7 with the threshold 5.');
    const response = page.waitForResponse((response) => response.url().includes('/settings/skills/details?') && response.status() === 503);
    release(); await response;
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  }
});

test('market loads rankings without a query, retains rows on pagination failure and ignores late board responses', async ({ page }, info) => {
  const skill = (name: string, installs: number, change?: number) => ({ id: `source/repo/${name}`, source: 'source/repo', skillId: name, name, installs, ...(change === undefined ? {} : { change }) });
  let paginationOutage = true, release!: () => void, started!: () => void;
  const gate = new Promise<void>((done) => { release = done }), received = new Promise<void>((done) => { started = done });
  await page.route('**/api/settings/skills/leaderboard?*', async (route) => {
    const url = new URL(route.request().url()), view = url.searchParams.get('view'), pageNumber = Number(url.searchParams.get('page'));
    if (view === 'trending') { started(); await gate; }
    if (pageNumber && paginationOutage) return route.fulfill({ status: 503, json: { error: '暂时无法读取 skills.sh 榜单，请重试。' } });
    const skills = view === 'hot' ? [skill('growth-first', 81, 47), skill('volume-second', 206, -8)] : view === 'trending' ? [skill('late-trending', 375)] : pageNumber ? [skill('page-two', 137)] : [skill('all-time-first', 2379), skill('all-time-second', 701)];
    await route.fulfill({ json: { skills, page: pageNumber, hasMore: view === 'all-time' && !pageNumber, total: 3 } });
  });
  await page.route('**/api/settings/skills/search?*', (route) => route.fulfill({ json: { skills: [] } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
  await expect(settings.getByRole('button', { name: '发现技能', exact: true })).toHaveCount(0);
  for (const name of ['从链接安装', '导入本地目录']) await expect(settings.getByRole('button', { name, exact: true })).toHaveCount(1);
  await settings.getByRole('tab', { name: '技能市场', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: '搜索 skills.sh', exact: true })).toHaveValue('');
  await expect(settings.getByRole('heading', { name: 'all-time-first', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('暂时无法读取 skills.sh 榜单');
  await expect(settings.getByRole('heading', { name: 'all-time-first', exact: true })).toBeVisible();
  paginationOutage = false; await settings.getByRole('button', { name: '重试', exact: true }).click();
  await expect(settings.getByRole('row', { name: 'page-two', exact: true }).getByRole('cell').first()).toHaveText('3');
  await expect(settings.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  await settings.getByRole('tab', { name: 'Trending (24h)', exact: true }).click(); await received;
  await settings.getByRole('tab', { name: 'Hot', exact: true }).click();
  await expect(settings.getByRole('table')).toHaveAccessibleName('Hot 技能榜单');
  await expect(settings.getByRole('row', { name: 'growth-first', exact: true }).getByRole('cell').first()).toHaveText('1');
  await expect(settings.getByLabel('较昨日同小时变化').first()).toHaveText('+47');
  await expect(settings.getByLabel('较昨日同小时变化').last()).toHaveText('-8');
  const response = page.waitForResponse((response) => new URL(response.url()).searchParams.get('view') === 'trending');
  release(); await response;
  await expect(settings.getByRole('heading', { name: 'late-trending', exact: true })).toHaveCount(0);
  const hot = settings.getByRole('tab', { name: 'Hot', exact: true });
  expect(await hot.evaluate((el) => { const style = getComputedStyle(el, '::after'); return parseFloat(style.width) > parseFloat(style.height) && parseFloat(style.height) === 2 })).toBe(true);
  await page.screenshot({ path: `.amp/in/artifacts/skills-market-hot-${info.project.name}.png`, animations: 'disabled' });
  const query = settings.getByRole('textbox', { name: '搜索 skills.sh', exact: true });
  await query.fill('no-match'); await settings.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(settings.getByText('没有找到相关技能', { exact: true })).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'growth-first', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'growth-first', exact: true })).toBeVisible();
});

test('market installs by skill identifier and fits light/dark desktop and mobile with category navigation intact', async ({ page }, info) => {
  const entries = [ ['find-skills', 'vercel-labs/skills', 3704225], ['grill-me', 'mattpocock/skills', 1285831],
    ['react-best-practices', 'vercel-labs/agent-skills', 992731], ['ui-taste', 'uizze.sh', 362302], ['web-design-guidelines', 'vercel-labs/agent-skills', 337011],
    ['frontend-design', 'anthropics/skills', 294853], ['skill-creator', 'anthropics/skills', 231875] ] as const;
  const skills = entries.map(([name, source, installs]) => ({ id: `${source}/${name}`, name, source, installs, skillId: name === 'ui-taste' ? 'stable-skill-id' : name }));
  await page.route('**/api/settings/skills/leaderboard?*', (route) => route.fulfill({ json: { skills, page: 0, hasMore: false, total: skills.length } }));
  let installationOutage = true;
  await page.route('**/api/settings/skills/install', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ source: 'uizze.sh', skill: 'stable-skill-id' });
    if (installationOutage) return route.fulfill({ status: 503, json: { error: '技能来源暂时不可用，请重试。' } });
    await route.fulfill({ status: 201, json: { directory: '/fixture/skills', configuration: { paths: [], disabled: [], excluded: [] }, diagnostics: [], skills: [{
      name: 'stable-skill-id', description: 'Fixture', enabled: true, automatic: true, filePath: '/fixture/skills/stable-skill-id/SKILL.md',
      installation: { source: 'https://uizze.sh/', skill: 'stable-skill-id', ref: null, upstreamHash: null, cliVersion: '1.7.0', contentHash: 'fixture' },
    }] } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await settings.getByRole('tab', { name: 'Skills', exact: true }).click(); await settings.getByRole('tab', { name: '技能市场', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'ui-taste', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '安装 ui-taste', exact: true }).click();
  await expect(settings.getByRole('row', { name: 'ui-taste', exact: true }).getByRole('alert')).toHaveText('技能来源暂时不可用，请重试。');
  await page.screenshot({ path: `.amp/in/artifacts/skills-market-install-failure-${info.project.name}.png`, animations: 'disabled' });
  installationOutage = false; await settings.getByRole('button', { name: '安装 ui-taste', exact: true }).click();
  await expect(settings.getByRole('row', { name: 'ui-taste', exact: true })).toContainText('已安装');
  await expect(settings.getByRole('row', { name: 'ui-taste', exact: true }).getByRole('alert')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: '安装 ui-taste', exact: true })).toHaveCount(0);
  for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      for (const category of ['模型配置', 'MCP', 'Skills']) await expect(settings.getByRole('tab', { name: category, exact: true })).toBeVisible();
      expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await settings.getByRole('table').evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.amp/in/artifacts/skills-market-${size.name}-${theme}-${info.project.name}.png`, animations: 'disabled' });
    }
  }
});

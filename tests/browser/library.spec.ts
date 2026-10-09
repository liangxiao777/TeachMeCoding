import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
const capture = async (page: Page, info: TestInfo, state: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `.amp/in/artifacts/library-${state}-${info.project.name}.png`, animations: 'disabled' });
};

test('standalone library uploads arbitrary bytes, retries safely, shares globally and preserves navigation', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const home = page.getByRole('textbox', { name: '你想学什么', exact: true });
  await home.fill('从资料库返回后保留我的学习需求');
  await capture(page, info, 'home');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, info, 'home-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  const library = page.getByRole('region', { name: '资料库', exact: true });
  await expect(home).toBeHidden();
  await expect(library.getByRole('heading', { name: '资料库', exact: true })).toBeFocused();
  await expect(library.getByText('还没有资料', { exact: true })).toBeVisible();
  await expect(library.getByRole('tablist')).toHaveCount(0);
  await expect(library.getByRole('switch')).toHaveCount(0);
  await capture(page, info, 'empty');
  const picker = library.getByLabel('选择资料文件', { exact: true });
  expect(await picker.getAttribute('accept')).toBeNull();
  const bytes = Buffer.from([0, 255, 130, 13, 10, 42]);
  const names = [`自定义资料-${info.project.name}.未知格式`, '学习笔记.md', 'Rust 入门.pdf', '项目需求.docx'];
  let dropped = false;
  await page.route('**/api/library/files?*', async (route) => {
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await picker.setInputFiles([
    { name: names[0]!, mimeType: 'application/octet-stream', buffer: bytes },
    { name: names[1]!, mimeType: 'text/markdown', buffer: Buffer.from('# 学习笔记\n参考资料') },
    { name: names[2]!, mimeType: 'application/pdf', buffer: readFileSync(new URL('../fixtures/library-reference.pdf', import.meta.url)) },
    { name: names[3]!, mimeType: 'application/octet-stream', buffer: readFileSync(new URL('../fixtures/library-reference.docx', import.meta.url)) },
  ]);
  await expect(library.getByRole('alert')).toBeVisible();
  await capture(page, info, 'retry');
  await library.getByRole('button', { name: '重试上传', exact: true }).click();
  for (const name of names) await expect(library.getByRole('listitem', { name, exact: true })).toHaveCount(1);
  await expect(library.getByText('4 个文件', { exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
  await capture(page, info, 'default');
  await library.getByRole('textbox', { name: '筛选资料', exact: true }).fill('  rUST  ');
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await expect(library.getByRole('listitem')).toHaveAttribute('aria-label', 'Rust 入门.pdf');
  await library.getByRole('textbox', { name: '筛选资料', exact: true }).fill('not-a-file');
  await expect(library.getByText('没有匹配的资料', { exact: true })).toBeVisible();
  await library.getByRole('textbox', { name: '筛选资料', exact: true }).fill('');
  await library.getByRole('button', { name: '更多操作 项目需求.docx', exact: true }).click();
  await capture(page, info, 'menu');
  await page.keyboard.press('Escape');
  await library.getByRole('button', { name: `更多操作 ${names[0]}`, exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(names[0]);
  expect(readFileSync((await download.path())!)).toEqual(bytes);
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5000 });
  await page.goBack(); await expect(home).toHaveValue('从资料库返回后保留我的学习需求');
  await expect(page.getByRole('button', { name: '资料库', exact: true })).toBeFocused();
  await page.goForward(); await expect(library).toBeVisible();
  await library.getByRole('button', { name: '返回学习', exact: true }).click();
  await expect(home).toHaveValue('从资料库返回后保留我的学习需求');
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.reload(); await expect(page).toHaveURL(/\/library$/);
  await expect(library.getByRole('listitem')).toHaveCount(4);
  await expect(library.getByRole('switch')).toHaveCount(0);
  await library.getByRole('button', { name: `更多操作 ${names[0]}`, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await capture(page, info, 'delete-confirmation');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(library.getByRole('listitem', { name: names[0]!, exact: true })).toBeVisible();
  let deleteDropped = false;
  await page.route('**/api/library/files/*/delete', async (route) => {
    if (!deleteDropped) { deleteDropped = true; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await library.getByRole('button', { name: `更多操作 ${names[0]}`, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '删除文件', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '删除文件', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(library.getByRole('listitem', { name: names[0]!, exact: true })).toHaveCount(0);
  await page.goto(`/?space=${seed(info).otherId}`);
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page).toHaveURL(/\/library\?space=/);
  await expect(library.getByRole('listitem', { name: '学习笔记.md', exact: true })).toBeVisible();
  await library.getByRole('button', { name: '刷新资料库', exact: true }).click();
  await expect(library.getByText('3 个文件', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('library round trips retain unsaved editor, composer, fullscreen and the same PTY connection', async ({ page }, info) => {
  const data = seed(info);
  writeFileSync(join(data.root, 'projects', data.spaceId, 'library-navigation.rs'), '// saved library fixture');
  let sockets = 0, closed = 0;
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/terminal/socket')) { sockets++; socket.on('close', () => closed++); }
  });
  const url = `/?space=${data.spaceId}&tab=unit&unit=${data.unitIds[0]}`;
  await page.goto(url);
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  await page.getByRole('treeitem', { name: 'library-navigation.rs', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑 library-navigation.rs', exact: true });
  const composer = page.getByRole('textbox', { name: '向 Agent 提问', exact: true });
  await editor.fill('// unsaved library navigation'); await composer.fill('尚未发送的资料问题');
  await expect.poll(() => sockets).toBe(1);
  for (const fullscreen of [false, true]) {
    if (fullscreen) await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
    await capture(page, info, fullscreen ? 'fullscreen-entry' : 'workbench-entry');
    await page.getByRole('button', { name: '资料库', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page).toHaveURL(/\/library\?space=.*tab=unit/);
    await page.getByRole('region', { name: '资料库', exact: true }).getByRole('button', { name: '返回学习', exact: true }).click();
    await expect(editor).toHaveValue('// unsaved library navigation');
    await expect(composer).toHaveValue('尚未发送的资料问题');
    await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('textbox', { name: '本机终端输入', exact: true })).toBeEnabled();
  }
  expect({ sockets, closed }).toEqual({ sockets: 1, closed: 0 });
});

test('direct library navigation handles outages and fits mobile and dark layouts with long filenames', async ({ page }, info) => {
  let outage = true;
  await page.route('**/api/library', (route) => outage ? route.fulfill({ status: 503, json: { error: '资料库暂不可用，请重试。' } }) : route.continue());
  await page.goto('/library');
  const library = page.getByRole('region', { name: '资料库', exact: true });
  await expect(library.getByRole('alert')).toContainText('资料库暂不可用');
  outage = false; await library.getByRole('button', { name: '重试', exact: true }).click();
  await expect(library.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
  const name = `参考资料-${'长文件名'.repeat(12)}.自定义`;
  await library.getByLabel('选择资料文件', { exact: true }).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('Raw data') });
  await expect(library.getByRole('listitem', { name, exact: true })).toBeVisible();
  for (const [state, viewport, dark] of [
    ['mobile', { width: 390, height: 844 }, false],
    ['dark', { width: 1440, height: 1000 }, true],
  ] as const) {
    await page.setViewportSize(viewport);
    if (dark) await library.getByRole('button', { name: '切换到暗色主题', exact: true }).click();
    expect(await library.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(library.getByRole('button', { name: '返回学习', exact: true })).toBeVisible();
    await capture(page, info, state);
  }
  await library.getByRole('button', { name: '返回学习', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('textbox', { name: '你想学什么', exact: true })).toBeVisible();
});

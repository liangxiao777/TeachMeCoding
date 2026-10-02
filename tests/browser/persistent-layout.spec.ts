import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1439, 999);
  await page.screenshot({ path: `.amp/in/artifacts/persistent-layout-${name}-${info.project.name}.png`, animations: 'disabled' });
}

test('real home and intake retain the approved hero, space cards and conversation-summary layout', async ({ page }, info) => {
  await page.goto('/');
  const hero = await box(page.locator('.learning-entry'));
  const heading = await box(page.getByRole('heading', { name: '今天你想学习什么?' }));
  expect(Math.abs(heading.x + heading.width / 2 - 720)).toBeLessThan(2);
  expect(hero.height).toBeGreaterThan(850);
  await expect(page.locator('.orbital-field svg')).toBeVisible();
  await capture(page, info, 'home');
  await page.getByRole('button', { name: '我的学习空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '存储验收 Rust', exact: true })).toBeVisible();
  const rustCard = await box(page.locator('[data-slot="card"]').filter({ hasText: '存储验收 Rust' }));
  const pythonCard = await box(page.locator('[data-slot="card"]').filter({ hasText: '另一个 Python 空间' }));
  expect(rustCard.width).toBeGreaterThan(350);
  expect(Math.abs(rustCard.width - pythonCard.width)).toBeLessThan(1);
  await capture(page, info, 'spaces');

  await page.goto(`/?space=${seed(info).otherId}`);
  const conversation = await box(page.getByRole('complementary', { name: '学习会话' }));
  const summary = await box(page.getByRole('region', { name: '学习需求摘要' }));
  expect(conversation.x + conversation.width).toBeLessThanOrEqual(summary.x);
  expect(summary.width).toBeGreaterThanOrEqual(375);
  expect(summary.width).toBeLessThanOrEqual(385);
  expect(conversation.width).toBeGreaterThan(650);
  await expect(page.getByRole('button', { name: '确认需求', exact: true })).toBeVisible();
  await capture(page, info, 'requirements');
});

test('real route and IDE retain timeline, full-height tree, split editor and visible fullscreen Agent', async ({ page }, info) => {
  const data = seed(info);
  await page.goto(`/?space=${data.spaceId}&tab=route`);
  await expect(page.getByTestId('route-timeline')).toBeVisible();
  const route = await box(page.getByTestId('route-content'));
  expect(route.x).toBeLessThan(120); // No unrelated project/navigation sidebar on the route.
  expect(route.width).toBeGreaterThan(850);
  await capture(page, info, 'route');

  await page.goto(`/?space=${data.spaceId}&tab=unit&unit=${data.unitIds[0]}`);
  await page.getByRole('button', { name: '项目 IDE', exact: true }).click();
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByRole('textbox', { name: '新路径', exact: true }).fill('layout.rs');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('button', { name: 'layout.rs', exact: true }).click();
  await page.getByRole('textbox', { name: '代码编辑器', exact: true }).fill('fn main() {\n    println!("local project");\n}\n');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  const tree = await box(page.getByRole('complementary', { name: '单元材料' }));
  const editor = await box(page.getByRole('textbox', { name: '代码编辑器', exact: true }));
  const terminal = await box(page.getByRole('region', { name: '终端' }));
  expect(tree.width).toBeGreaterThanOrEqual(235);
  expect(tree.width).toBeLessThanOrEqual(245);
  expect(tree.y).toBeLessThan(65);
  expect(tree.y + tree.height).toBeGreaterThan(960);
  expect(terminal.x).toBeGreaterThan(editor.x);
  expect(Math.abs(terminal.y - editor.y)).toBeLessThan(100);
  await capture(page, info, 'ide-normal');

  const ide = page.getByRole('region', { name: '项目 IDE' });
  const initialHeight = (await box(ide)).height;
  await page.getByRole('separator', { name: '调整 IDE 高度' }).press('ArrowUp');
  await expect.poll(async () => (await box(ide)).height).toBeGreaterThan(initialHeight + 5);
  const normalHeight = (await box(ide)).height;
  await page.getByRole('textbox', { name: '代码编辑器', exact: true }).fill('// unsaved local edit');
  await page.getByRole('textbox', { name: '会话草稿', exact: true }).fill('保留本单元草稿');
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  const fullscreenEditor = await box(page.getByRole('textbox', { name: '代码编辑器', exact: true }));
  const fullscreenTerminal = await box(page.getByRole('region', { name: '终端' }));
  const agent = await box(page.getByRole('complementary', { name: '学习会话' }));
  expect(fullscreenTerminal.y).toBeGreaterThan(fullscreenEditor.y + fullscreenEditor.height);
  expect(agent.x).toBeGreaterThan(fullscreenEditor.x + fullscreenEditor.width - 2);
  expect(agent.width).toBe(384);
  await capture(page, info, 'ide-fullscreen');
  await page.getByRole('button', { name: '查看课件', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await capture(page, info, 'lesson-drawer');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '项目 IDE' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '项目 IDE' })).toBeHidden();
  await page.getByRole('button', { name: '项目 IDE', exact: true }).click();
  await expect.poll(async () => (await box(ide)).height).toBeCloseTo(normalHeight, 0);
  await page.getByRole('button', { name: '全部空间', exact: true }).click();
  await page.getByRole('button', { name: '继续学习 另一个 Python 空间', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '会话草稿', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '全部空间', exact: true }).click();
  await page.getByRole('button', { name: '继续学习 存储验收 Rust', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '代码编辑器', exact: true })).toHaveValue('// unsaved local edit');
  await expect(page.getByRole('textbox', { name: '会话草稿', exact: true })).toHaveValue('保留本单元草稿');
  await expect.poll(async () => (await box(ide)).height).toBeCloseTo(normalHeight, 0);
});

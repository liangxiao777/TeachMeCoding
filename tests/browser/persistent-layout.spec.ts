import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
const spaceCard = (page: Page, name: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: name }) });
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
  await expect(spaceCard(page, '存储验收 Rust')).toBeVisible();
  const rustCard = await box(spaceCard(page, '存储验收 Rust'));
  const pythonCard = await box(spaceCard(page, '另一个 Python 空间'));
  expect(rustCard.width).toBeGreaterThan(350);
  expect(Math.abs(rustCard.width - pythonCard.width)).toBeLessThan(1);
  await capture(page, info, 'spaces');

  await page.goto(`/?space=${seed(info).otherId}`);
  // Original intake uses a chat div beside a Card, not the unit Agent aside/region.
  const summaryCard = page.locator('[data-slot="card"][aria-labelledby="req-title"]');
  const intake = page.locator('.grid').filter({ has: summaryCard });
  const conversation = await box(intake.locator(':scope > div').filter({ has: page.getByRole('textbox', { name: '回复 Agent', exact: true }) }));
  const summary = await box(summaryCard);
  expect(conversation.x + conversation.width).toBeLessThanOrEqual(summary.x);
  expect(summary.width).toBeGreaterThanOrEqual(375);
  expect(summary.width).toBeLessThanOrEqual(385);
  expect(conversation.width).toBeGreaterThan(650);
  await expect(page.getByRole('button', { name: '确认学习需求', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '修改', exact: true })).toBeVisible();
  await capture(page, info, 'requirements');
});

test('real route and IDE retain timeline, full-height tree, split editor and visible fullscreen Agent', async ({ page }, info) => {
  const data = seed(info);
  await page.goto(`/?space=${data.spaceId}&tab=route`);
  const stage = page.getByRole('region', { name: /阶段 1.*语言基础/ });
  await expect(stage).toBeVisible();
  await expect(stage.locator(':scope > ol > li')).toHaveCount(2);
  const route = await box(page.getByRole('main').locator('.max-w-4xl'));
  expect(route.x).toBeLessThan(120); // No unrelated project/navigation sidebar on the route.
  expect(route.width).toBeGreaterThan(850);
  await capture(page, info, 'route');

  await stage.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: '所有权与借用' }) }).getByRole('button', { name: /^(进入|继续|复习)$/ }).click();
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  const projectTree = page.getByRole('tree', { name: '项目目录树', exact: true });
  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('layout');
  await page.getByRole('textbox', { name: '文件夹名称', exact: true }).press('Enter');
  await expect(projectTree.getByRole('treeitem', { name: 'layout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByRole('textbox', { name: '文件名称', exact: true }).fill('layout.rs');
  await page.getByRole('textbox', { name: '文件名称', exact: true }).press('Enter');
  await expect(projectTree.getByRole('treeitem', { name: 'layout.rs', exact: true })).toHaveAttribute('data-entry-id', 'layout/layout.rs');
  await expect(projectTree.getByRole('treeitem', { name: 'layout.rs', exact: true })).toHaveAttribute('aria-level', '2');
  const code = page.getByRole('textbox', { name: '编辑 layout.rs', exact: true });
  const draft = page.getByRole('textbox', { name: '向 Agent 提问', exact: true });
  const ide = page.getByRole('region', { name: 'IDE 与终端', exact: true });
  // The original resizable panel now contains the actual xterm input, not a fixture log.
  const terminalInput = page.getByRole('textbox', { name: '本机终端输入', exact: true });
  const terminalPanel = ide.locator('[data-slot="resizable-panel"]').filter({ has: terminalInput });
  await code.fill('fn main() {\n    println!("local project");\n}\n');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(ide.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  const tree = await box(page.getByRole('complementary', { name: '单元材料' }));
  const editor = await box(code);
  const terminal = await box(terminalPanel);
  expect(tree.width).toBeGreaterThanOrEqual(235);
  expect(tree.width).toBeLessThanOrEqual(245);
  expect(tree.y).toBeLessThan(65);
  expect(tree.y + tree.height).toBeGreaterThan(960);
  expect(terminal.x).toBeGreaterThan(editor.x);
  expect(Math.abs(terminal.y - editor.y)).toBeLessThan(100);
  await expect(terminalInput).toBeEnabled();
  await capture(page, info, 'ide-normal');

  const initialHeight = (await box(ide)).height;
  await page.getByRole('separator', { name: '调整 IDE 高度' }).press('ArrowUp');
  await expect.poll(async () => (await box(ide)).height).toBeGreaterThan(initialHeight + 5);
  const normalHeight = (await box(ide)).height;
  await code.fill('// unsaved local edit');
  await draft.fill('保留本单元草稿');
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  await expect(code).toHaveValue('// unsaved local edit');
  await expect(draft).toHaveValue('保留本单元草稿');
  const fullscreenEditor = await box(code);
  const fullscreenTerminal = await box(terminalPanel);
  const agent = await box(page.getByRole('complementary', { name: 'Agent', exact: true }));
  expect(fullscreenTerminal.y).toBeGreaterThan(fullscreenEditor.y + fullscreenEditor.height);
  expect(agent.x).toBeGreaterThan(fullscreenEditor.x + fullscreenEditor.width - 2);
  expect(agent.width).toBe(384);
  await capture(page, info, 'ide-fullscreen');
  await page.getByRole('button', { name: '查看课件', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '当前课件', exact: true })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '所有权与借用', exact: true })).toBeVisible();
  await capture(page, info, 'lesson-drawer');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(ide).toBeVisible();
  await expect(page.getByRole('button', { name: '返回学习', exact: true })).toBeVisible();
  await expect(code).toHaveValue('// unsaved local edit');
  await expect(draft).toHaveValue('保留本单元草稿');
  await page.keyboard.press('Escape');
  await expect(ide).toBeHidden();
  await expect(page.getByRole('button', { name: 'IDE 与终端', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await expect.poll(async () => (await box(ide)).height).toBeCloseTo(normalHeight, 0);
  await page.getByRole('button', { name: '存储验收 Rust', exact: true }).click();
  await page.getByRole('menuitem', { name: '查看全部学习空间', exact: true }).click();
  await spaceCard(page, '另一个 Python 空间').getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '回复 Agent', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '全部学习空间', exact: true }).click();
  await spaceCard(page, '存储验收 Rust').getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(code).toHaveValue('// unsaved local edit');
  await expect(draft).toHaveValue('保留本单元草稿');
  await expect(ide.getByRole('status').filter({ hasText: /^未保存$/ })).toBeVisible();
  await expect(page.getByLabel('会话草稿状态', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存会话', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await box(ide)).height).toBeCloseTo(normalHeight, 0);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { SessionDetail, UnitDetail, Workspace } from '../../packages/contracts/src/workspace';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: `.amp/in/artifacts/persistent-${name}-${info.project.name}.png` });
const visible = (page: Page, label: string) => page.getByRole('textbox', { name: label, exact: true }).filter({ visible: true });
const spaceCard = (page: Page, name: string) => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: name }) });
const composer = (page: Page) => page.getByRole('complementary', { name: 'Agent', exact: true }).locator('form');
const sessionMenu = (page: Page) => page.getByRole('button', { name: '切换会话', exact: true });

async function expectTemporaryComposer(page: Page) {
  await expect(page.getByRole('button', { name: '保存会话', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('会话草稿状态', { exact: true })).toHaveCount(0);
}

async function enterUnit(page: Page, title: string) {
  const row = page.getByRole('main').locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: title }) });
  await row.getByRole('button', { name: /^(进入|继续|复习)$/ }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function goRoute(page: Page) {
  await page.getByRole('navigation', { name: '空间导航' }).getByRole('button', { name: '学习路线', exact: true }).click();
}

async function saveAssessment(page: Page) {
  const save = page.getByRole('button', { name: '保存答案草稿', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
  await expect(save).toBeDisabled();
}

test('spaces and sent messages persist while unsent input is temporary and retries preserve newer edits', async ({ page }, info) => {
  await page.goto('/');
  const goal = `学习持久化 ${info.project.name}`;
  await visible(page, '你想学什么').fill(goal);
  let dropped = false;
  await page.route('**/api/spaces', async (route) => {
    if (route.request().method() === 'POST' && !dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(visible(page, '你想学什么')).toHaveValue(goal);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(visible(page, '学习空间名称')).toHaveValue(goal);
  await expect(page.locator('[data-slot="card-title"]').filter({ hasText: /^学习需求摘要$/ })).toBeVisible();
  await expect(page).toHaveURL(/[?&]space=/);
  const url = page.url();
  const name = `${goal} · 已命名`;
  await visible(page, '学习空间名称').fill(name);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/name') && response.ok()),
    visible(page, '学习空间名称').press('Tab'),
  ]);
  await expect(page.getByText(goal, { exact: true })).toHaveCount(1);
  await expect(page.locator('dd').filter({ hasText: /^待补充$/ })).toHaveCount(4);
  await expect(page.getByRole('button', { name: '确认学习需求', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await visible(page, '学习目标').fill('理解持久化数据的生命周期');
  await visible(page, '已有基础').fill('Python 基础，尚未学习 Rust');
  await expect(page.getByRole('button', { name: '确认学习需求', exact: true })).toBeDisabled();
  // The requirement editor is unmounted, but its unsaved values belong to the provider.
  await page.getByRole('button', { name: '全部学习空间', exact: true }).click();
  // Match the original goal too: a duplicate created by retry must not hide behind the rename.
  await expect(spaceCard(page, goal)).toHaveCount(1);
  await spaceCard(page, name).getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(visible(page, '已有基础')).toHaveValue('Python 基础，尚未学习 Rust');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: /^Python 基础，尚未学习 Rust$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认学习需求', exact: true }).click();
  await expect(page.getByRole('button', { name: '已确认学习需求', exact: true })).toBeDisabled();
  await visible(page, '回复 Agent').fill('独立保存的需求问题');
  await expectTemporaryComposer(page);
  await shot(page, info, 'requirements');
  await page.reload();
  await expect(visible(page, '学习空间名称')).toHaveValue(name);
  await expect(page.getByRole('button', { name: '已确认学习需求', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(visible(page, '已有基础')).toHaveValue('Python 基础，尚未学习 Rust');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(visible(page, '回复 Agent')).toHaveValue('');
  await visible(page, '回复 Agent').fill('独立保存的需求问题');
  let messageDropped = false;
  await page.route('**/sessions/*/messages', async (route) => {
    if (!messageDropped) { messageDropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: '保存问题', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(visible(page, '回复 Agent')).toHaveValue('独立保存的需求问题');
  await visible(page, '回复 Agent').fill('重试期间的新草稿');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('独立保存的需求问题', { exact: true })).toHaveCount(1);
  await expect(visible(page, '回复 Agent')).toHaveValue('重试期间的新草稿');
  await expectTemporaryComposer(page);
  await page.getByRole('button', { name: '查看学习路线', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('尚无学习路线', { exact: true })).toBeVisible();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(page.getByText('独立保存的需求问题', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('menuitem', { name: '查看全部学习空间', exact: true }).click();
  await expect(spaceCard(page, name)).toHaveCount(1);
  await spaceCard(page, '另一个 Python 空间').getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(visible(page, '回复 Agent')).toHaveValue('');
  await page.goto(url);
  await expect(page.getByText('独立保存的需求问题', { exact: true })).toHaveCount(1);
  await expect(visible(page, '回复 Agent')).toHaveValue('');
  await expect(page.getByTestId('fixture-notice')).toHaveCount(0);
});

test('a delayed requirement response preserves sessions created while saving', async ({ page }, info) => {
  // Use an independent intake so this confirmation cannot change another test's fixture.
  await page.goto('/');
  await visible(page, '你想学什么').fill(`延迟需求保存 ${info.project.name}`);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await visible(page, '学习目标').fill('学习保存和会话隔离');
  await visible(page, '已有基础').fill('保存期间继续创建会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: /^保存期间继续创建会话$/ })).toBeVisible();
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const responseReceived = new Promise<void>((resolve) => { received = resolve; });
  await page.route('**/api/spaces/*/requirement', async (route) => {
    const response = await route.fetch(); received(); await held; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '确认学习需求', exact: true }).click();
    await responseReceived;
    await expect(page.getByRole('button', { name: '确认学习需求', exact: true })).toBeDisabled();
    await sessionMenu(page).click();
    await expect(page.getByRole('menuitem')).toHaveCount(2); // One intake session plus the new-session action.
    await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(sessionMenu(page)).toHaveText('新会话');
    await visible(page, '回复 Agent').fill('响应返回前新会话的草稿');
    await sessionMenu(page).click();
    await expect(page.getByRole('menuitem')).toHaveCount(3);
    await expect(page.getByRole('menuitem', { name: /^新会话/ })).toContainText('暂无消息');
    await expect(sessionMenu(page)).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('menuitem').first().press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    release();
    await expect(page.getByRole('button', { name: '已确认学习需求', exact: true })).toBeDisabled();
    await expect(sessionMenu(page)).toHaveText('新会话');
    await expect(visible(page, '回复 Agent')).toHaveValue('响应返回前新会话的草稿');
    await expectTemporaryComposer(page);
    await page.reload();
    await expect(sessionMenu(page)).toHaveText('新会话');
    await expect(visible(page, '回复 Agent')).toHaveValue('');
    await sessionMenu(page).click();
    await expect(page.getByRole('menuitem')).toHaveCount(3);
    await shot(page, info, 'session-menu');
    await page.getByRole('menuitem', { name: /^学习需求/ }).click();
    await expect(visible(page, '回复 Agent')).toHaveValue('');
  } finally { release(); }
});

test('unit sessions, references, assessment drafts, historical records and confirmed proposals stay scoped', async ({ page }, info) => {
  const data = seed(info);
  await page.goto(`/?space=${data.spaceId}&tab=route`);
  await enterUnit(page, '所有权与借用');
  const passage = page.locator('.lesson-prose p').filter({ hasText: /^这是 所有权与借用 的验收课件。$/ });
  await expect(passage).toBeVisible();
  await passage.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '向 Agent 提问', exact: true }).click();
  await expect(composer(page)).toContainText('所有权与借用 · 课件');
  await expect(composer(page)).toContainText('这是 所有权与借用 的验收课件。');
  await visible(page, '向 Agent 提问').fill('借用的问题');
  await expectTemporaryComposer(page);
  await page.getByRole('button', { name: /^(开始单元测评|继续测评)$/ }).click();
  await visible(page, '你的回答').fill('单元一解释');
  await visible(page, '编辑 代码答案').fill('// 单元一代码');
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '提交测评', exact: true })).toBeDisabled();
  await saveAssessment(page);
  await page.getByRole('button', { name: '返回单元（答案会保留）', exact: true }).click();
  await goRoute(page);
  await enterUnit(page, '错误处理');
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await goRoute(page);
  await enterUnit(page, '所有权与借用');
  await expect(visible(page, '向 Agent 提问')).toHaveValue('借用的问题');
  await expect(composer(page)).toContainText('所有权与借用 · 课件');
  await goRoute(page);
  await enterUnit(page, '错误处理');
  await page.getByRole('button', { name: /^(开始单元测评|继续测评)$/ }).click();
  await expect(visible(page, '你的回答')).toHaveValue('');
  await visible(page, '你的回答').fill('单元二解释');
  await visible(page, '编辑 代码答案').fill('// 单元二代码');
  await saveAssessment(page);
  await page.reload();
  await expect(visible(page, '你的回答')).toHaveValue('单元二解释');
  await expect(visible(page, '编辑 代码答案')).toHaveValue('// 单元二代码');
  await page.getByRole('button', { name: '返回单元（答案会保留）', exact: true }).click();
  await goRoute(page);
  await enterUnit(page, '所有权与借用');
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await visible(page, '向 Agent 提问').fill('借用的问题');
  await page.getByRole('button', { name: /^(开始单元测评|继续测评)$/ }).click();
  await expect(visible(page, '你的回答')).toHaveValue('单元一解释');
  await expect(visible(page, '编辑 代码答案')).toHaveValue('// 单元一代码');
  await shot(page, info, 'assessment');
  await page.getByRole('button', { name: '返回单元（答案会保留）', exact: true }).click();
  const materials = page.getByRole('complementary', { name: '单元材料', exact: true });
  await materials.locator('summary').filter({ hasText: /^测评记录/ }).click();
  await materials.getByRole('button', { name: /所有权与借用.*加强.*第 1 次/ }).click();
  await expect(page.getByText('再巩固一下会更扎实', { exact: true })).toBeVisible();
  await expect(page.getByText('验收记录：需要更多证据', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('历史解释', { exact: true })).toBeVisible();
  await expect(page.getByText('历史代码', { exact: true })).toBeVisible();
  await page.getByRole('main').locator('li').filter({ hasText: '补充借用示例' }).getByRole('button', { name: '就此提问', exact: true }).click();
  await expect(composer(page)).toContainText('所有权与借用 · 测评');
  await expect(composer(page)).toContainText('补充借用示例');
  await expectTemporaryComposer(page);
  await shot(page, info, 'record');
  await sessionMenu(page).click();
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await visible(page, '向 Agent 提问').fill('第二个会话的草稿');
  await expectTemporaryComposer(page);
  await sessionMenu(page).click();
  await page.getByRole('menuitem', { name: /^所有权与借用/ }).click();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('借用的问题');
  await expect(composer(page)).toContainText('补充借用示例');
  await sessionMenu(page).click();
  await page.getByRole('menuitem', { name: /^新会话/ }).click();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('第二个会话的草稿');
  await page.reload();
  await expect(page.getByText('验收记录：需要更多证据', { exact: true })).toBeVisible();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await sessionMenu(page).click();
  await page.getByRole('menuitem', { name: /^所有权与借用/ }).click();
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await goRoute(page);
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await page.getByRole('button', { name: '收起 Agent', exact: true }).click();
  await expect(visible(page, '路线调整想法')).toHaveValue('');
  await visible(page, '路线调整想法').fill('路线会话的独立草稿');
  await expectTemporaryComposer(page);
  await page.reload();
  await page.getByRole('button', { name: '收起 Agent', exact: true }).click();
  await expect(visible(page, '路线调整想法')).toHaveValue('');
  await expect(page.getByText('验收数据：两个独立单元。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认调整路线', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认调整路线', exact: true })).toHaveCount(0);
  await expect(page.getByText('用户确认后的路线说明', { exact: true })).toBeVisible();
  await shot(page, info, 'route');
  await page.reload();
  await expect(page.getByText('用户确认后的路线说明', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认调整路线', exact: true })).toHaveCount(0);
});

test('disk editing preserves local changes on failure, compares external content and survives fullscreen and refresh', async ({ page }, info) => {
  const data = seed(info);
  await page.goto(`/?space=${data.spaceId}&tab=route`);
  await enterUnit(page, '所有权与借用');
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  const tree = page.getByRole('tree', { name: '项目目录树', exact: true });
  await tree.getByRole('treeitem', { name: 'src', exact: true }).press('ArrowRight');
  await tree.getByRole('treeitem', { name: 'main.rs', exact: true }).click();
  await visible(page, '编辑 main.rs').fill('local editing survives');
  writeFileSync(join(data.root, 'projects', data.spaceId, 'src/main.rs'), 'external edit 42');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '外部修改' })).toBeVisible();
  await expect(visible(page, '编辑 main.rs')).toHaveValue('local editing survives');
  await shot(page, info, 'file-conflict');
  await page.getByRole('button', { name: '读取磁盘版本', exact: true }).click();
  const comparison = page.getByRole('region', { name: '磁盘版本比较', exact: true });
  await expect(comparison.getByText('external edit 42', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  await expect(visible(page, '编辑 main.rs')).toHaveValue('local editing survives');
  await expect(comparison.getByText('external edit 42', { exact: true })).toBeVisible();
  await shot(page, info, 'file-comparison');
  await page.getByRole('button', { name: '保留编辑，基于此版本继续' }).click();
  await expect(comparison).toHaveCount(0);
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  const ide = page.getByRole('region', { name: 'IDE 与终端', exact: true });
  await expect(ide.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  expect(readFileSync(join(data.root, 'projects', data.spaceId, 'src/main.rs'), 'utf8')).toBe('local editing survives');
  await page.keyboard.press('Escape');
  await expect(ide).toBeHidden();
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('button', { name: '关闭 src/main.rs' }).click();
  await tree.getByRole('treeitem', { name: 'main.rs', exact: true }).click();
  await expect(visible(page, '编辑 main.rs')).toHaveValue('local editing survives');
  await tree.getByRole('treeitem', { name: 'main.rs', exact: true }).press('F2');
  await visible(page, '重命名').fill('renamed.rs');
  await visible(page, '重命名').press('Enter');
  await expect(tree.getByRole('treeitem', { name: 'renamed.rs', exact: true })).toHaveAttribute('data-entry-id', 'src/renamed.rs');
  await expect(page.getByRole('button', { name: '关闭 src/main.rs' })).toHaveCount(0);
  await page.reload();
  await tree.getByRole('treeitem', { name: 'src', exact: true }).press('ArrowRight');
  await tree.getByRole('treeitem', { name: 'renamed.rs', exact: true }).click();
  await expect(visible(page, '编辑 renamed.rs')).toHaveValue('local editing survives');
  await page.getByRole('button', { name: '询问这个文件', exact: true }).click();
  await expectTemporaryComposer(page);
  await expect(composer(page)).toContainText('src/renamed.rs');
  await expect(composer(page)).toContainText('local editing survives');
  await shot(page, info, 'ide');
  await page.reload();
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
});

test('unavailable business API displays a retryable failure, never demo spaces', async ({ page }, info) => {
  await page.route('**/api/spaces', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试服务暂时不可用' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('测试服务暂时不可用');
  await visible(page, '你想学什么').fill('服务恢复前不能创建空间');
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
  await expect(spaceCard(page, '存储验收 Rust')).toHaveCount(0);
  await expect(page.getByTestId('fixture-notice')).toHaveCount(0);
  await shot(page, info, 'load-error');
  await page.unroute('**/api/spaces');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '我的学习空间', exact: true }).click();
  await expect(spaceCard(page, '存储验收 Rust')).toBeVisible();
});

test('original lesson quotation and bring-to-IDE actions retain real data through retries', async ({ page }, info) => {
  const data = seed(info), unit = data.unitIds[1]!;
  // Present a valid newly generated unit without a session, with a stored code example.
  await page.route(`**/api/spaces/${data.spaceId}`, async (route) => {
    const response = await route.fetch(); const workspace = await response.json() as Workspace;
    await route.fulfill({ json: { ...workspace, sessions: workspace.sessions.filter((s) => s.unitId !== unit) } });
  });
  await page.route(`**/api/spaces/${data.spaceId}/units/${unit}`, async (route) => {
    const response = await route.fetch(); const detail = await response.json() as UnitDetail;
    await route.fulfill({ json: { ...detail, lesson: { title: '错误处理', content: '保留第一条课件引用。\n\n```rust\nfn main() { println!("example"); }\n```' } } });
  });
  let dropped = false;
  await page.route(`**/api/spaces/${data.spaceId}/sessions`, async (route) => {
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.goto(`/?space=${data.spaceId}&tab=unit&unit=${unit}`);
  await expect(visible(page, '向 Agent 提问')).toBeDisabled();
  const passage = page.getByText('保留第一条课件引用。', { exact: true });
  await passage.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '向 Agent 提问', exact: true }).click();
  await expect(page.getByRole('alert').filter({ has: page.getByRole('button', { name: '重试', exact: true }) })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(composer(page)).toContainText('保留第一条课件引用。');
  await expectTemporaryComposer(page);
  await page.getByRole('button', { name: '带入 IDE', exact: true }).click();
  const code = 'fn main() { println!("example"); }';
  await expect(visible(page, '编辑 example.rs')).toHaveValue(code);
  expect(readFileSync(join(data.root, 'projects', data.spaceId, 'example.rs'), 'utf8')).toBe('');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '带入 IDE', exact: true }).click();
  await expect(visible(page, '编辑 example-1.rs')).toHaveValue(code);
  expect(readFileSync(join(data.root, 'projects', data.spaceId, 'example.rs'), 'utf8')).toBe(code);
  expect(readFileSync(join(data.root, 'projects', data.spaceId, 'example-1.rs'), 'utf8')).toBe('');
});

test('stored Markdown sections and assessment prompts render headings, tables and code without rewriting artifacts', async ({ page }, info) => {
  const data = seed(info), unit = data.unitIds[1]!;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const code = 'const name: string = "learner";\nconsole.log(`你好，${name}`);';
  const body = '编译配置保留**类型检查**与 `strict`。\n\n| 选项 | 含义 |\n| --- | --- |\n| target | ES2022 |\n| strict | 开启检查 |\n\n### 示例代码\n\n```ts\n' + code + '\n```\n\n1. 检查类型\n2. 编译运行';
  const assessment = '修复**工具链**，保留文件结构。\n\n```text\nreport-tool/\n  src/index.ts\n```\n\n```ts\n' + code + '\n```\n\n| 命令 | 作用 |\n| --- | --- |\n| tsc | 编译 |\n\n1. 启用 strict\n2. 解释输出';
  const rawHeading = `## 编译配置\r\n\r\n${body.replaceAll('\n', '\r\n')}`;
  await page.route(`**/api/spaces/${data.spaceId}/units/${unit}`, async (route) => {
    const response = await route.fetch(), detail = await response.json() as UnitDetail;
    await route.fulfill({ json: { ...detail, lesson: { title: '错误处理', content: '', intro: '学习配置，不把正文当标题。', blocks: [
      { type: 'h2', id: 'compiler-options', text: rawHeading },
      { type: 'callout', title: '检查结果', text: '保留换行。\n\n```text\nline one\n  line two\n```' },
      { type: 'p', text: '### 补充说明\n\n这段正文也支持 Markdown。' },
      { type: 'h2', id: 'review', text: '复习' },
    ] }, assessment: { ...detail.assessment, q1: '解释 `tsc`。\n\n- 编译\n- 执行', q2: assessment, starter: '' } } });
  });
  await page.goto(`/?space=${data.spaceId}&tab=unit&unit=${unit}`);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const article = page.locator('.lesson-prose'), heading = article.locator('#compiler-options');
  await expect(heading).toHaveText('编译配置');
  await expect(article.getByRole('heading', { name: '示例代码', exact: true })).toBeVisible();
  await expect(article.getByRole('heading', { name: '补充说明', exact: true })).toHaveCount(1);
  await expect(article.locator('table tbody tr')).toHaveCount(2);
  await expect(article.locator('table')).toContainText('ES2022');
  expect(await article.locator('pre').first().textContent()).toBe(code);
  await expect(article.locator('pre').nth(1)).toHaveText('line one\n  line two');
  await expect(article.locator('ol > li')).toHaveText(['检查类型', '编译运行']);
  const toc = page.getByRole('complementary', { name: '单元材料' });
  await expect(toc.getByRole('link')).toHaveText(['编译配置', '复习']);
  await toc.getByRole('link', { name: '复习', exact: true }).click();
  await expect.poll(() => article.locator('..').evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await toc.getByRole('link', { name: '编译配置', exact: true }).click();
  await expect(heading).toBeInViewport();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: `.amp/in/artifacts/markdown-lesson-light-${info.project.name}.png`, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `.amp/in/artifacts/markdown-lesson-dark-${info.project.name}.png`, animations: 'disabled' });
  // Render-only compatibility must not modify the source heading or lose code when copied into the IDE.
  expect((await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await fetch(`/api/spaces/${space}/units/${unit}`, { headers: { 'X-TMC-Token': token } })).json();
  }, { space: data.spaceId, unit })).lesson.blocks[0].text).toBe(rawHeading);
  await article.getByRole('button', { name: '带入 IDE', exact: true }).first().click();
  await expect(visible(page, '编辑 example.ts')).toHaveValue(code);
  await page.goto(`/?space=${data.spaceId}&tab=assessment&unit=${unit}`);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const questions = page.locator('[data-slot="card-description"]');
  await expect(questions.first().locator('ul > li')).toHaveText(['编译', '执行']);
  const question = questions.nth(1);
  await expect(question.locator('pre')).toHaveCount(2);
  expect(await question.locator('pre').nth(1).textContent()).toBe(`${code}\n`);
  await expect(question.locator('table')).toContainText('编译');
  await expect(question.locator('ol > li')).toHaveText(['启用 strict', '解释输出']);
  await expect(page.locator('p pre, h2 pre, h2 table')).toHaveCount(0);
  // The existing application shell has a 1100px minimum width.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await question.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(question.locator('ol > li').last()).toBeInViewport();
  await page.screenshot({ path: `.amp/in/artifacts/markdown-assessment-dark-${info.project.name}.png`, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a late requirement save does not close or discard a newer edit', async ({ page }, info) => {
  await page.goto('/');
  await visible(page, '你想学什么').fill(`需求草稿竞争 ${info.project.name}`);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await visible(page, '学习目标').fill('学习需求版本管理');
  await visible(page, '已有基础').fill('提交的旧内容');
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const responseReceived = new Promise<void>((resolve) => { received = resolve; });
  await page.route('**/api/spaces/*/requirement', async (route) => {
    const response = await route.fetch(); received(); await held; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await responseReceived;
    await visible(page, '已有基础').fill('响应返回前的新内容');
    release();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expect(visible(page, '已有基础')).toHaveValue('响应返回前的新内容');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('dd').filter({ hasText: /^响应返回前的新内容$/ })).toBeVisible();
    await page.reload();
    await expect(page.locator('dd').filter({ hasText: /^响应返回前的新内容$/ })).toBeVisible();
  } finally { release(); }
});

test('composer edits never save drafts or restore legacy draft bodies; sending still uses the saved revision', async ({ page, request }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { token } = await (await request.get('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
  const headers = { 'X-TMC-Token': token };
  const created = await request.post('/api/spaces', { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { name: '临时输入检查', goal: '验证临时输入与已发送消息的区别' } });
  expect(created.ok()).toBe(true);
  const space = await created.json() as Workspace;
  const session = space.sessions.find((s) => s.scope === 'route')!;
  const path = `/api/spaces/${space.id}/sessions/${session.id}`;
  const legacy = { text: '旧版保存的输入', quote: { source: 'code', label: '旧版引用', text: 'legacy source' }, routeSuggestion: '旧版路线草稿' };
  const stored = await request.post(`${path}/draft`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { ...legacy, revision: 0 } });
  expect(stored.ok()).toBe(true);
  const draftWrites: string[] = [];
  page.on('request', (req) => { if (req.method() === 'POST' && /\/sessions\/[^/]+\/draft$/.test(req.url())) draftWrites.push(req.url()); });
  await page.goto(`/?space=${space.id}&tab=route`);
  await expectTemporaryComposer(page);
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await expect(composer(page).getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await visible(page, '向 Agent 提问').fill('尚未发送的另一个问题');
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  await page.getByRole('button', { name: '收起 Agent', exact: true }).click();
  await expect(visible(page, '路线调整想法')).toHaveValue('');
  await visible(page, '路线调整想法').fill('我想先做项目');
  const unchanged = await (await request.get(path, { headers })).json() as SessionDetail;
  expect(unchanged.draft).toEqual({ ...legacy, revision: 1 });
  await shot(page, info, 'temporary-route-input');
  await page.getByRole('button', { name: '保存路线调整想法', exact: true }).click();
  await expect(page.getByText('我想先做项目', { exact: true })).toHaveCount(1);
  await expect(visible(page, '向 Agent 提问')).toHaveValue('尚未发送的另一个问题');
  await page.reload();
  await expect(page.getByText('我想先做项目', { exact: true })).toHaveCount(1);
  await expect(visible(page, '向 Agent 提问')).toHaveValue('');
  await page.getByRole('button', { name: '收起 Agent', exact: true }).click();
  await expect(visible(page, '路线调整想法')).toHaveValue('');
  expect(draftWrites).toEqual([]);
  const saved = await (await request.get(path, { headers })).json() as SessionDetail;
  expect(saved.messages.map((m) => ({ text: m.text, quote: m.quote }))).toEqual([{ text: '我想先做项目', quote: null }]);
});

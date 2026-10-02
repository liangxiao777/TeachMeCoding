import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

test('explicit preview creates a space only after a goal and confirms edited requirements', async ({ page }, info) => {
  const businessRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) businessRequests.push(request.url()); });
  await page.goto('/preview');
  await expect(page.getByRole('heading', { name: '今天你想学习什么?' })).toBeVisible();
  await expect(page.getByTestId('fixture-notice')).toContainText('模拟回复与执行');
  await page.screenshot({ path: `.amp/in/artifacts/home-${info.project.name}.png` });
  await page.getByRole('button', { name: '我的学习空间' }).click();
  await expect(page.getByText('还没有学习空间，先创建一个')).toBeVisible();
  await page.getByRole('button', { name: '创建学习空间', exact: true }).click();
  await page.getByLabel('你想学什么', { exact: true }).fill('我想学习 Rust，最后能写一个命令行工具');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '熟悉 Python，写过一些自动化脚本，没接触过 C/C++', exact: true }).click();
  await page.getByRole('button', { name: '每周大概 5 小时，希望两个月内完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认，开始规划路线' })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('每周 7 小时，先学所有权');
  await expect(page.getByRole('button', { name: '确认，开始规划路线' })).toBeDisabled();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: '每周 7 小时，先学所有权' })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/requirements-${info.project.name}.png` });
  await page.getByRole('button', { name: '确认，开始规划路线' }).click();
  await expect(page.getByRole('heading', { name: 'Rust 入门', exact: true })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: '每周 7 小时，先学所有权' })).toBeVisible();
  expect(businessRequests).toEqual([]);
});

test('route input hands off to Agent, preserves independent drafts, and waits for proposal confirmation', async ({ page }, info) => {
  await page.goto('/preview?scene=route');
  const agent = page.getByRole('complementary', { name: 'Agent', exact: true });
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('保留在 Agent 中的草稿');
  await page.getByRole('button', { name: '收起 Agent' }).click();
  const routeInput = page.getByRole('textbox', { name: '路线调整想法' });
  await routeInput.fill('我想先做项目');
  await expect(page.getByLabel('向 Agent 提问', { exact: true })).toHaveCount(0);
  await routeInput.press('Enter');
  await expect(agent).toBeVisible();
  await expect(routeInput).toHaveCount(0);
  await expect(page.locator('textarea:visible')).toHaveCount(1);
  await expect(page.getByLabel('向 Agent 提问', { exact: true })).toHaveValue('保留在 Agent 中的草稿');
  await expect(agent.getByRole('button', { name: '确认调整路线' })).toBeVisible({ timeout: 12000 });
  const proposedUnit = page.getByRole('main').locator('[data-slot="card-title"]').filter({ hasText: '练习项目：单词计数器' });
  await expect(proposedUnit).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/route-agent-${info.project.name}.png` });
  await agent.getByRole('button', { name: '确认调整路线' }).click();
  await expect(proposedUnit).toHaveCount(1);
  await expect(agent.getByText('路线已更新', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起 Agent' }).click();
  await expect(routeInput).toHaveValue('');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByLabel('向 Agent 提问', { exact: true })).toBeFocused();
});

test('messages, selected sessions, drafts and lesson quotes stay in their space and unit', async ({ page }) => {
  await page.goto('/preview?scene=unit');
  const composer = page.getByLabel('向 Agent 提问', { exact: true });
  const agent = page.getByRole('complementary', { name: 'Agent', exact: true });
  const intro = page.locator('.lesson-prose > p').first();
  await intro.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '向 Agent 提问', exact: true }).click();
  await composer.fill('所有权草稿 A');
  await expect(agent.getByRole('button', { name: '移除引用' })).toBeVisible();
  await agent.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(agent.getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await composer.fill('所有权草稿 B');
  await agent.getByRole('button', { name: '新会话', exact: true }).click();
  await page.getByRole('menuitem', { name: /理解所有权转移/ }).click();
  await expect(composer).toHaveValue('所有权草稿 A');
  await expect(agent.getByRole('button', { name: '移除引用' })).toBeVisible();
  await page.getByRole('button', { name: '学习路线', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(agent.getByRole('button', { name: '移除引用' })).toHaveCount(0);
  await expect(agent.getByText('为什么赋值后原变量不能用了？', { exact: true })).toHaveCount(0);
  await composer.fill('路线草稿 C');
  await page.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: '结构体与枚举' }) }).getByRole('button', { name: '进入', exact: true }).click();
  await expect(composer).toHaveValue('');
  await composer.fill('结构体草稿 D');
  await page.getByRole('button', { name: '学习路线', exact: true }).click();
  await expect(composer).toHaveValue('路线草稿 C');
  await page.getByRole('button', { name: 'Rust 入门', exact: true }).click();
  await page.getByRole('menuitem', { name: /PyTorch 基础/ }).click();
  await expect(composer).toHaveValue('');
  await expect(agent.getByText(/为什么 \(2, 2\)/)).toBeVisible();
  await composer.fill('PyTorch 草稿 E');
  await page.getByRole('button', { name: 'PyTorch 基础', exact: true }).click();
  await page.getByRole('menuitem', { name: /Rust 入门/ }).click();
  await expect(composer).toHaveValue('路线草稿 C');
  await page.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: '所有权与借用' }) }).getByRole('button', { name: '继续', exact: true }).click();
  await expect(composer).toHaveValue('所有权草稿 A');
  await expect(agent.getByRole('button', { name: '移除引用' })).toBeVisible();
  await expect(agent.getByText('为什么赋值后原变量不能用了？', { exact: true })).toBeVisible();
});

test('scripted reply failure retains the question and retries in the original session', async ({ page }, info) => {
  await page.goto('/preview?scene=route&fault=reply');
  const input = page.getByLabel('向 Agent 提问', { exact: true });
  await input.fill('这条路线大概要多久？');
  await input.press('Enter');
  await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/reply-failure-${info.project.name}.png` });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 12000 });
  await expect(page.getByRole('complementary', { name: 'Agent', exact: true }).locator('ol').getByText('这条路线大概要多久？', { exact: true })).toHaveCount(1);
});

test('an in-flight route reply finishes in its original session after switching spaces', async ({ page }) => {
  await page.goto('/preview?scene=route');
  const composer = page.getByLabel('向 Agent 提问', { exact: true });
  const agent = page.getByRole('complementary', { name: 'Agent', exact: true });
  await composer.fill('我想先做项目');
  await composer.press('Enter');
  await expect(agent.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rust 入门', exact: true }).click();
  await page.getByRole('menuitem', { name: /PyTorch 基础/ }).click();
  await composer.fill('另一个空间尚未发送的草稿');
  // Allow the 800ms delay and streamed reply to finish while its panel is unmounted.
  await page.waitForTimeout(3000);
  await expect(agent.getByRole('button', { name: '确认调整路线' })).toHaveCount(0);
  await expect(agent.getByText('我想先做项目', { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('另一个空间尚未发送的草稿');
  await page.getByRole('button', { name: 'PyTorch 基础', exact: true }).click();
  await page.getByRole('menuitem', { name: /Rust 入门/ }).click();
  await expect(agent.getByRole('button', { name: '确认调整路线' })).toBeVisible();
  await expect(agent.locator('ol').getByText('我想先做项目', { exact: true })).toHaveCount(1);
  await expect(composer).toHaveValue('');
});

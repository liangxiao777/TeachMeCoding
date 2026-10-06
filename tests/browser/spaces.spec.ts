import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

test('startup header actions share ghost styling, keyboard focus and mobile touch targets', async ({ page }, info) => {
  const actions = page.locator('.startup-header .startup-actions > [data-slot="button"]');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(actions).toHaveCount(3);
    await page.mouse.move(0, 0);
    for (const action of await actions.all()) {
      await expect(action).toHaveCSS('height', '32px');
      await expect(action).toHaveCSS('border-radius', '8px');
      await expect(action).toHaveCSS('font-size', '13px');
      await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(action).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
      await expect(action).toHaveCSS('transition-duration', '0.15s, 0.15s');
      await expect(action.locator('svg')).toHaveCSS('width', '16px');
      const before = (await action.boundingBox())!;
      await action.hover();
      await expect(action).toHaveCSS('background-color', scheme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.08)');
      expect(await action.boundingBox()).toEqual(before);
      await page.mouse.move(0, 0);
      await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await page.screenshot({ path: `.amp/in/artifacts/startup-actions-${scheme}-${info.project.name}.png`, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '应用设置', exact: true }).focus();
  await page.keyboard.press('Tab');
  const spaces = page.getByRole('button', { name: '学习空间', exact: true });
  await expect(spaces).toBeFocused();
  expect(await spaces.evaluate(el => el.matches(':focus-visible'))).toBe(true);
  await expect(spaces).not.toHaveCSS('box-shadow', 'none');
  await page.getByRole('textbox', { name: '你想学什么', exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const action of await actions.all()) {
    const target = await action.evaluate(el => {
      const style = getComputedStyle(el, '::after');
      return { width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBe(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const theme = page.getByRole('button', { name: '切换到亮色主题', exact: true });
  const themeBox = (await theme.boundingBox())!;
  // Click outside the visible 32px button but inside its expanded touch target.
  await page.mouse.click(themeBox.x + themeBox.width / 2, themeBox.y + themeBox.height + 4);
  await expect(page.getByRole('button', { name: '切换到暗色主题', exact: true })).toBeVisible();
  await expect(actions.first()).toHaveCSS('color', 'oklch(0.145 0 0)');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `.amp/in/artifacts/startup-actions-mobile-${info.project.name}.png`, animations: 'disabled' });
  const settings = page.getByRole('button', { name: '应用设置', exact: true });
  const settingsBox = (await settings.boundingBox())!;
  await page.mouse.click(settingsBox.x + settingsBox.width / 2, settingsBox.y + settingsBox.height + 4);
  await expect(page.getByRole('region', { name: '应用设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await spaces.click();
  await expect(page.getByRole('button', { name: '创建学习空间', exact: true })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // Home-only overrides must not change settings buttons on other pages.
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toHaveCSS('height', '28px');
});

test('startup light moves without moving content, softens while writing and respects reduced motion', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
  await page.goto('/preview');
  const input = page.getByRole('textbox', { name: '你想学什么', exact: true });
  const field = page.locator('.startup-field');
  const surface = page.locator('.startup-prompt > [data-slot="input-group"]');
  const planes = page.locator('.startup-light-plane');
  const light = planes.first().locator('span');
  await expect(input).toBeFocused();
  await expect(page.locator('.startup-page')).toHaveCSS('background-color', 'rgb(251, 251, 251)');
  await expect(surface).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.95)');
  await expect(surface).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
  await expect(field).toHaveCSS('opacity', '1');
  await expect(page.locator('.startup-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.startup-header')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
  await expect(light).toHaveCSS('animation-duration', '12s');
  await expect(planes.nth(1).locator('span')).toHaveCSS('animation-duration', '16s');
  const initial = await light.evaluate((el) => getComputedStyle(el).transform);
  await expect.poll(() => light.evaluate((el) => getComputedStyle(el).transform)).not.toBe(initial);

  const hero = (await page.locator('.learning-entry').boundingBox())!;
  const heading = page.getByRole('heading', { name: '今天你想学习什么?' });
  const headingBefore = (await heading.boundingBox())!;
  await page.mouse.move(hero.x + hero.width * 0.85, hero.y + hero.height * 0.3);
  await expect.poll(() => planes.first().evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)).toBeCloseTo(5.6, 1);
  await expect.poll(() => planes.first().evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42)).toBeCloseTo(-2.4, 1);
  await expect.poll(() => planes.nth(1).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)).toBeCloseTo(-3.36, 1);
  expect((await heading.boundingBox())!.x).toBe(headingBefore.x);
  expect((await heading.boundingBox())!.y).toBe(headingBefore.y);
  await page.mouse.move(10, 10);
  await expect.poll(() => planes.first().evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)).toBeCloseTo(0, 1);
  await page.locator('.learning-entry').dispatchEvent('pointermove', { pointerType: 'touch', clientX: 1200, clientY: 100 });
  expect(await field.evaluate((el) => el.style.getPropertyValue('--light-x'))).toBe('0px');

  await input.fill('我想做一个属于自己的小工具');
  await expect(field).toHaveCSS('opacity', '0.5');
  await input.fill('');
  await expect(field).toHaveCSS('opacity', '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(light).toHaveCSS('animation-name', 'none');
  await expect(planes.first()).toHaveCSS('transform', 'none');
  await page.mouse.move(hero.x + hero.width * 0.2, hero.y + hero.height * 0.8);
  await expect(planes.first()).toHaveCSS('transform', 'none');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(light).toHaveCSS('animation-name', 'startup-light-drift');
  const mobileInitial = await light.evaluate((el) => getComputedStyle(el).transform);
  await expect.poll(() => light.evaluate((el) => getComputedStyle(el).transform)).not.toBe(mobileInitial);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const prompt = (await page.locator('.startup-prompt').boundingBox())!;
  expect(prompt.width).toBeLessThanOrEqual(342);
  await page.screenshot({ path: `.amp/in/artifacts/startup-light-mobile-${info.project.name}.png` });
  await input.fill('主题切换后保留这个目标');
  await page.getByRole('button', { name: '切换到暗色主题', exact: true }).click();
  await expect(input).toHaveValue('主题切换后保留这个目标');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('.startup-page')).toHaveCSS('background-color', 'rgb(16, 16, 16)');
  await expect(page.locator('.startup-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(surface).toHaveCSS('background-color', 'rgba(27, 27, 27, 0.96)');
  await input.fill('');
  await expect(surface).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
  await page.screenshot({ path: `.amp/in/artifacts/startup-dark-mobile-${info.project.name}.png` });
});

test('short example labels still submit the complete selected goal', async ({ page }) => {
  await page.goto('/preview');
  const input = page.getByRole('textbox', { name: '你想学什么', exact: true });
  await input.fill('不要提交这条未发送的草稿');
  await page.getByRole('button', { name: '我想用 PyTorch 训练一个图像分类模型', exact: true }).click();
  await expect(page.getByText('我想用 PyTorch 训练一个图像分类模型', { exact: true })).toBeVisible();
  await expect(page.getByText('不要提交这条未发送的草稿', { exact: true })).toHaveCount(0);
  await expect(page.locator('.startup-field')).toHaveCount(0);
});

test('explicit preview creates a space only after a goal and confirms edited requirements', async ({ page }, info) => {
  const businessRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) businessRequests.push(request.url()); });
  await page.goto('/preview');
  await expect(page.getByRole('heading', { name: '今天你想学习什么?' })).toBeVisible();
  await expect(page.getByTestId('fixture-notice')).toContainText('模拟回复与执行');
  await page.screenshot({ path: `.amp/in/artifacts/home-${info.project.name}.png` });
  await page.getByRole('button', { name: '学习空间', exact: true }).click();
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
  await agent.getByRole('button', { name: '切换会话', exact: true }).click();
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

import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });

test('startup header actions share ghost styling, keyboard focus and mobile touch targets', async ({ page }, info) => {
  const actions = page.locator('.startup-header .startup-actions > [data-slot="button"]');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(actions).toHaveCount(4);
    await expect(page.getByRole('button', { name: '资料库', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: '资料库', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused();
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
  await page.goto('/');
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

test('startup examples only fill the complete goal until manual submission', async ({ page }, info) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) mutations.push(new URL(request.url()).pathname);
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const url = page.url();
  const input = page.getByRole('textbox', { name: '你想学什么', exact: true });
  const start = page.getByRole('button', { name: '开始', exact: true });
  await expect(page.locator('.startup-examples').getByText('试一试：', { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await page.screenshot({ path: `.amp/in/artifacts/startup-suggestions-default-${info.project.name}.png`, animations: 'disabled' });
  await input.fill('不要提交这条未发送的草稿');
  for (const goal of ['我想学习 Rust，最后能写一个命令行工具', '我想用 PyTorch 训练一个图像分类模型', '我想学会用 Go 写后端服务']) {
    await page.getByRole('button', { name: goal, exact: true }).click();
    await expect(input).toHaveValue(goal);
    await expect(start).toBeEnabled();
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('heading', { name: '今天你想学习什么?' })).toBeVisible();
  }
  await page.screenshot({ path: `.amp/in/artifacts/startup-suggestions-filled-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.amp/in/artifacts/startup-suggestions-mobile-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(mutations).toEqual([]);
  const editedGoal = '我想学会用 Go 写后端服务，先实现一个健康检查接口';
  await input.fill(editedGoal);
  const creation = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/spaces');
  await input.press('Enter');
  expect((await creation).postDataJSON()).toMatchObject({ goal: editedGoal });
  await expect(page.locator('.startup-field')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '学习空间名称', exact: true })).toHaveValue(editedGoal);
  expect(mutations).toEqual(['/api/spaces']);
});

import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'no-preference' }, screenshot: 'off', video: 'off', trace: 'off' });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;

// Sample the rendered transition, not just its declared duration or final state.
async function disclosureFrames(root: Locator) {
  return root.evaluate(async (el) => {
    el.querySelector<HTMLButtonElement>('button')!.click();
    const frames = [];
    const start = performance.now();
    while (performance.now() - start < 350) {
      await new Promise(requestAnimationFrame);
      const panel = el.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
      frames.push({ height: panel?.getBoundingClientRect().height ?? 0, natural: panel?.scrollHeight ?? 0,
        opacity: panel ? Number(getComputedStyle(panel).opacity) : 0, mounted: !!panel });
    }
    return frames;
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`motion: route Agent retains content on exit and reverses naturally (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/preview?scene=route');
    const panel = page.locator('aside[aria-label="Agent"]');
    const dock = panel.locator('..');
    await page.getByRole('textbox', { name: '向 Agent 提问', exact: true }).fill('不要丢掉这条未发送的问题');
    await expect(dock).toHaveCSS('width', '384px');
    const frames = await dock.evaluate(async (el) => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!.click();
      const frames = [];
      const start = performance.now();
      while (performance.now() - start < 350) {
        await new Promise(requestAnimationFrame);
        const panel = el.querySelector<HTMLElement>('aside');
        frames.push({ width: el.getBoundingClientRect().width, retained: !!panel?.querySelector('textarea'),
          inert: panel?.inert, opacity: panel ? Number(getComputedStyle(panel).opacity) : 0 });
      }
      return frames;
    });
    expect(frames.some((f) => f.width > 1 && f.width < 383 && f.retained && f.inert)).toBe(true);
    expect(frames.some((f) => f.opacity > 0 && f.opacity < 1)).toBe(true);
    expect(frames.at(-1)).toMatchObject({ width: 0, retained: false });
    // The aside is gone now; locate the stable dock through the main's sibling.
    const stableDock = page.getByRole('main').locator('..').locator(':scope > div');
    const reversal = await stableDock.evaluate(async (el) => {
      const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!;
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 55));
      const input = el.querySelector('textarea');
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 45));
      const before = el.getBoundingClientRect().width;
      toggle.click();
      await new Promise(requestAnimationFrame);
      const after = el.getBoundingClientRect().width;
      await new Promise((resolve) => setTimeout(resolve, 350));
      return { before, after, sameInput: !!input && el.querySelector('textarea') === input };
    });
    expect(reversal.before).toBeGreaterThan(0);
    expect(reversal.before).toBeLessThan(384);
    expect(reversal.after).toBeGreaterThan(0);
    expect(reversal.after).toBeLessThan(384);
    expect(reversal.sameInput).toBe(true);
    await expect(stableDock).toHaveCSS('width', '384px');
    await expect(page.getByRole('textbox', { name: '向 Agent 提问', exact: true })).toHaveValue('不要丢掉这条未发送的问题');
    await page.getByRole('button', { name: '收起 Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeFocused();
  });

  test(`motion: settings keeps the learning surface during entry and preserves drafts on return (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    const home = page.getByRole('textbox', { name: '你想学什么', exact: true });
    await home.fill('保留学习目标草稿');
    await home.evaluate((el) => el.setAttribute('data-motion-probe', 'retained'));
    const frames = await page.locator('.app-layout').evaluate(async (el) => {
      document.querySelector<HTMLButtonElement>('button[aria-label="应用设置"]')!.click();
      const frames = [];
      const start = performance.now();
      while (performance.now() - start < 350) {
        await new Promise(requestAnimationFrame);
        const settings = document.querySelector<HTMLElement>('section[aria-label="应用设置"]');
        frames.push({ opacity: settings ? Number(getComputedStyle(settings).opacity) : 0,
          learningVisible: getComputedStyle(el).display !== 'none' });
      }
      return frames;
    });
    expect(frames.some((f) => f.opacity > 0 && f.opacity < 1 && f.learningVisible)).toBe(true);
    expect(frames.at(-1)).toEqual({ opacity: 1, learningVisible: false });
    const settings = page.getByRole('region', { name: '应用设置', exact: true });
    await expect(settings.getByRole('heading', { name: '设置', exact: true })).toBeFocused();
    await expect(home).toBeHidden();
    await settings.getByRole('tab', { name: 'Skills', exact: true }).click();
    await settings.getByRole('textbox', { name: '筛选已安装技能', exact: true }).fill('未提交的筛选');
    const reversal = await settings.evaluate(async (el) => {
      el.querySelector<HTMLButtonElement>('button')!.click();
      await new Promise((resolve) => setTimeout(resolve, 55));
      const opacity = Number(getComputedStyle(el).opacity);
      const exitingInert = el instanceof HTMLElement && el.inert;
      const trigger = document.querySelector<HTMLButtonElement>('.app-layout button[aria-label="应用设置"]')!;
      trigger.focus();
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      return { opacity, exitingInert, samePage: document.querySelector('section[aria-label="应用设置"]') === el };
    });
    expect(reversal.opacity).toBeGreaterThan(0);
    expect(reversal.opacity).toBeLessThan(1);
    expect(reversal.exitingInert).toBe(true);
    expect(reversal.samePage).toBe(true);
    await expect(settings.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByRole('textbox', { name: '筛选已安装技能', exact: true })).toHaveValue('未提交的筛选');
    await expect(home).toBeHidden();
    await settings.getByRole('button', { name: '返回', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(home).toHaveValue('保留学习目标草稿');
    await expect(home).toHaveAttribute('data-motion-probe', 'retained');
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused();
  });

  test(`motion: result disclosures animate both directions and return to natural height (${theme})`, async ({ page }, info) => {
    const data = seed(info);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/?space=${data.spaceId}&tab=result&unit=${data.unitIds[0]}&record=${data.recordId}`);
    await expect(page.getByText('验收记录：需要更多证据', { exact: true })).toBeVisible();
    for (const name of ['补充反馈', '查看我的回答']) {
      const root = page.locator('.result-disclosure').filter({ has: page.getByRole('button', { name, exact: true }) });
      const frames = await disclosureFrames(root);
      expect(frames.some((f) => f.height > 0 && f.height < f.natural - 1 && f.opacity > 0 && f.opacity < 1)).toBe(true);
      const panel = root.locator('[data-slot="collapsible-content"]');
      await expect(panel).toHaveCSS('transition-duration', '0.2s, 0.2s');
      expect(await panel.evaluate((el) => el.style.getPropertyValue('--collapsible-panel-height'))).toBe('auto');
      const reversal = await root.evaluate(async (el) => {
        const panel = el.querySelector('[data-slot="collapsible-content"]')!;
        const height = panel.getBoundingClientRect().height;
        const trigger = el.querySelector<HTMLButtonElement>('button')!;
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 65));
        const before = panel.getBoundingClientRect().height;
        trigger.click();
        await new Promise(requestAnimationFrame);
        const after = panel.getBoundingClientRect().height;
        await new Promise((resolve) => setTimeout(resolve, 350));
        return { height, before, after, samePanel: el.querySelector('[data-slot="collapsible-content"]') === panel };
      });
      expect(reversal.before).toBeGreaterThan(0);
      expect(reversal.before).toBeLessThan(reversal.height);
      expect(reversal.after).toBeGreaterThan(0);
      expect(reversal.after).toBeLessThan(reversal.height);
      expect(reversal.samePanel).toBe(true);
      const closing = await disclosureFrames(root);
      expect(closing.some((f) => f.mounted && f.height > 0 && f.height < f.natural - 1)).toBe(true);
      expect(closing.at(-1)).toEqual({ height: 0, natural: 0, opacity: 0, mounted: false });
    }
  });
}

test('motion: settings restores route reading position without replacing its scroll container', async ({ page }, info) => {
  const data = seed(info);
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.goto(`/?space=${data.spaceId}&tab=route`);
  const reader = page.getByRole('main').locator(':scope > div');
  await expect(page.getByRole('heading', { name: '存储验收 Rust', exact: true })).toBeVisible();
  await reader.evaluate((el) => { el.setAttribute('data-motion-probe', 'reader'); el.scrollTop = 137; });
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(137);
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect(reader).toBeHidden();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(reader).toBeVisible();
  await expect(reader).toHaveAttribute('data-motion-probe', 'reader');
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(137);
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused();
});

test('motion: reduced-motion switches all three samples without an animated interval', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/preview?scene=route');
  const widths = await page.locator('aside[aria-label="Agent"]').locator('..').evaluate(async (el) => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Agent"]')!.click();
    const widths = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      widths.push(el.getBoundingClientRect().width);
    }
    return widths;
  });
  expect(widths.every((width) => width === 0 || width === 384)).toBe(true);
  expect(widths.at(-1)).toBe(0);
  await expect(page.locator('aside[aria-label="Agent"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.locator('aside[aria-label="Agent"]').locator('..')).toHaveCSS('width', '384px');
  await page.goto('/');
  const opacities = await page.getByRole('button', { name: '应用设置', exact: true }).evaluate(async (el) => {
    (el as HTMLButtonElement).click();
    const opacities = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      const settings = document.querySelector('section[aria-label="应用设置"]');
      opacities.push(settings ? Number(getComputedStyle(settings).opacity) : 0);
    }
    return opacities;
  });
  expect(opacities.every((opacity) => opacity === 0 || opacity === 1)).toBe(true);
  expect(opacities.at(-1)).toBe(1);
  const settings = page.getByRole('region', { name: '应用设置', exact: true });
  await expect(settings).toHaveCSS('opacity', '1');
  await expect(settings).toHaveCSS('transform', 'none');
  await settings.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.locator('section[aria-label="应用设置"]')).toHaveCount(0);
  const data = seed(info);
  await page.goto(`/?space=${data.spaceId}&tab=result&unit=${data.unitIds[0]}&record=${data.recordId}`);
  for (const name of ['补充反馈', '查看我的回答']) {
    const trigger = page.getByRole('button', { name, exact: true });
    await trigger.click();
    const panel = trigger.locator('..').locator('[data-slot="collapsible-content"]');
    await expect(panel).toHaveCSS('transition-duration', '0s');
    await expect(trigger.locator('svg')).toHaveCSS('transition-duration', '0s');
    expect(await panel.evaluate((el) => el.getAnimations().length)).toBe(0);
    await trigger.click();
    await expect(panel).toHaveCount(0);
  }
});

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { seedWorkspaces } from '../seed-workspaces';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });
test('formal IDE auto-connects real PTY, keeps it through refresh/fullscreen and reports exit', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?space=${seed.spaceId}&tab=unit&unit=${seed.unitIds[0]}`);
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('treeitem', { name: 'src', exact: true }).press('ArrowRight');
  await page.getByRole('treeitem', { name: 'main.rs', exact: true }).click();
  await expect(page.getByText('本机终端 · 非沙箱', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '本机终端输入', exact: true });
  await expect(page.getByText('使用本机账号权限', { exact: false })).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.xterm-rows')).toHaveCSS('font-family', /monospace/);
  await input.pressSequentially("printf 'REAL_OUTPUT_73\\n'; export TMC_RECONNECT=kept"); await input.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('REAL_OUTPUT_73');
  await page.screenshot({ path: `.amp/in/artifacts/terminal-normal-${info.project.name}.png` });
  await page.getByLabel('本机终端', { exact: true }).locator('..').screenshot({ path: `.amp/in/artifacts/terminal-clean-${info.project.name}.png` });
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  await expect(page.getByText('使用本机账号权限', { exact: false })).toHaveCount(0);
  await input.pressSequentially('printf "RECONNECTED_%s\\n" "$TMC_RECONNECT"'); await input.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RECONNECTED_kept');
  await page.reload();
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('treeitem', { name: 'src', exact: true }).press('ArrowRight');
  await page.getByRole('treeitem', { name: 'main.rs', exact: true }).click();
  await expect(page.locator('.xterm-rows')).toContainText('RECONNECTED_kept');
  await input.pressSequentially('exit 7'); await input.press('Enter');
  await expect(page.getByText('终端已退出：7（信号 无）', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/terminal-exit-${info.project.name}.png` });
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByText('终端已退出：7（信号 无）', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await expect(page.getByText(/终端已退出：/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('terminal waits for the latest autosave, discovers external files and never replays input after save failure', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const root = join(seed.root, 'projects', seed.spaceId);
  writeFileSync(join(root, 'run.sh'), 'printf "OLD_17\\n"\n');
  await page.goto(`/?space=${seed.spaceId}&tab=unit&unit=${seed.unitIds[0]}`);
  await page.getByRole('treeitem', { name: 'run.sh', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑 run.sh', exact: true }).filter({ visible: true });
  const input = page.getByRole('textbox', { name: '本机终端输入', exact: true });
  const send = async (command: string) => { await input.pressSequentially(command); await input.press('Enter'); };
  await expect(page.getByText('本机终端 · 非沙箱', { exact: true })).toBeVisible();
  const restart = page.getByRole('button', { name: '新建终端', exact: true });
  if (await restart.isVisible()) { await restart.click(); await expect(restart).toHaveCount(0); }
  let saved = false, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/project/save', async (route) => {
    const response = await route.fetch();
    if (route.request().postDataJSON().content === 'printf "LATEST_83\\n"\n') { saved = true; await held; }
    await route.fulfill({ response });
  });
  await editor.fill('printf "LATEST_83\\n"\n');
  await expect.poll(() => saved).toBe(true);
  await editor.fill('printf "INTERMEDIATE_61\\n"\n');
  await editor.fill('printf "LATEST_91\\n"\n');
  await send('bash run.sh > result.txt; cat result.txt');
  expect(existsSync(join(root, 'result.txt'))).toBe(false);
  expect(readFileSync(join(root, 'run.sh'), 'utf8')).toBe('printf "LATEST_83\\n"\n');
  const ide = page.getByRole('region', { name: 'IDE 与终端', exact: true });
  await expect(ide.getByRole('status').filter({ hasText: /^正在保存…$/ })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/terminal-autosaving-${info.project.name}.png` });
  release();
  await expect.poll(() => { try { return readFileSync(join(root, 'result.txt'), 'utf8'); } catch { return ''; } }).toBe('LATEST_91\n');
  await expect(page.locator('.xterm-rows')).toContainText('LATEST_91');
  await expect(ide.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
  await page.unroute('**/project/save');
  await expect(page.getByRole('button', { name: '保存全部文件', exact: true })).toHaveCount(0);
  await send('printf "changed by terminal" > run.sh');
  await expect.poll(() => readFileSync(join(root, 'run.sh'), 'utf8')).toBe('changed by terminal');
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(editor).toHaveText('changed by terminal', { useInnerText: true });
  await expect(page.getByRole('treeitem', { name: 'result.txt', exact: true })).toBeVisible();
  let outage = true;
  await page.route('**/project/save', (route) => outage ? route.fulfill({ status: 503, json: { error: '测试写入失败' } }) : route.continue());
  await editor.fill('printf "RECOVERED_57\\n"\n');
  await expect(ide.getByRole('status').filter({ hasText: /^保存失败$/ })).toBeVisible();
  await send('touch must-not-run');
  await expect(page.getByRole('alert').filter({ hasText: '文件自动保存失败' })).toBeVisible();
  expect(existsSync(join(root, 'must-not-run'))).toBe(false);
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(editor).toHaveText('printf "RECOVERED_57\\n"\n', { useInnerText: true });
  outage = false;
  await editor.press('End');
  await editor.pressSequentially('# retry on input');
  await expect(ide.getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
  expect(readFileSync(join(root, 'run.sh'), 'utf8')).toContain('RECOVERED_57');
  expect(existsSync(join(root, 'must-not-run'))).toBe(false);
  await input.press('Control+c');
  await send('tmc_nonexistent_toolchain_83');
  await expect(page.locator('.xterm-rows')).toContainText('command not found');
  await page.getByRole('button', { name: '引用终端输出', exact: true }).click();
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  await page.screenshot({ path: `.amp/in/artifacts/terminal-files-fullscreen-${info.project.name}.png` });
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
});

test('Ctrl+C and a new shell discard terminal input waiting for an autosave', async ({ page }, info) => {
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  const root = join(seed.root, 'projects', seed.spaceId);
  writeFileSync(join(root, 'cancel-save.txt'), 'original');
  await page.goto(`/?space=${seed.spaceId}&tab=unit&unit=${seed.unitIds[0]}`);
  await page.getByRole('treeitem', { name: 'cancel-save.txt', exact: true }).click();
  await expect(page.getByText('本机终端 · 非沙箱', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '本机终端输入', exact: true });
  const restart = page.getByRole('button', { name: '新建终端', exact: true });
  if (await restart.isVisible()) { await restart.click(); await expect(restart).toHaveCount(0); }
  for (const cancel of ['interrupt', 'restart']) {
    let saved = false, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/project/save', async (route) => {
      const response = await route.fetch();
      if (route.request().postDataJSON().content === cancel) { saved = true; await held; }
      await route.fulfill({ response });
    });
    await page.getByRole('textbox', { name: '编辑 cancel-save.txt', exact: true }).fill(cancel);
    await expect.poll(() => saved).toBe(true);
    await input.pressSequentially(`touch cancelled-${cancel}`); await input.press('Enter');
    if (cancel === 'interrupt') await input.press('Control+c');
    else {
      await page.getByRole('button', { name: '停止终端', exact: true }).click();
      await restart.click(); await expect(restart).toHaveCount(0);
    }
    release();
    await expect(page.getByRole('region', { name: 'IDE 与终端', exact: true }).getByRole('status').filter({ hasText: /^已保存$/ })).toBeVisible();
    await input.pressSequentially(`printf 'READY_${cancel}\\n'`); await input.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText(`READY_${cancel}`);
    expect(existsSync(join(root, `cancelled-${cancel}`))).toBe(false);
    await page.unroute('**/project/save');
  }
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
});

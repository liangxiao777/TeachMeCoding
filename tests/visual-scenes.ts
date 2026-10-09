import { expect, type Page } from '@playwright/test';

/** The same interactions feed the Vite baselines and the read-only Next reference capture. */
export async function visualScenes(page: Page, source: 'preview' | 'prototype', capture: (name: string) => Promise<void>) {
  await page.clock.setFixedTime(new Date('2026-10-02T10:00:00Z'));
  async function open(scene = '', fault = '') {
    if (source === 'preview') {
      await page.goto(`/preview?scene=${scene}&fault=${fault}`);
    } else {
      await page.goto('/');
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
      await page.getByRole('button', { name: '原型控制', exact: true }).click();
      await page.getByRole('button', { name: scene ? '已有多个空间' : '首次使用（空）', exact: true }).click();
      if (fault) await page.getByRole('switch', { name: fault === 'reply' ? '下一次 Agent 回答失败' : '下一次课件生成失败' }).check();
      await page.keyboard.press('Escape');
      if (scene === 'route' || scene === 'unit') {
        await page.getByRole('button', { name: '继续学习', exact: true }).first().click();
        if (scene === 'route') await page.getByRole('button', { name: '学习路线', exact: true }).click();
      }
    }
  }
  async function shot(name: string) {
    await page.evaluate(() => document.fonts.ready);
    if (source === 'preview') {
      const editor = page.locator('.cm-content'), snippet = page.locator('.lesson-prose pre').first();
      if (await editor.count()) await expect.poll(() => editor.evaluate((el) => new Set([el, ...el.querySelectorAll('*')].map((node) => getComputedStyle(node).color)).size)).toBeGreaterThan(2);
      if (await snippet.count()) await expect(snippet).toHaveClass(/shiki/);
    }
    await page.mouse.move(1439, 999);
    await capture(name);
  }

  await open();
  await expect(page.getByRole('heading', { name: '今天你想学习什么?' })).toBeVisible();
  await page.getByLabel('你想学什么', { exact: true }).focus();
  await shot('home');
  await page.getByLabel('你想学什么', { exact: true }).fill('我想学习 Rust，最后能写一个命令行工具');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByRole('button', { name: '熟悉 Python，写过一些自动化脚本，没接触过 C/C++', exact: true }).click();
  await page.getByRole('button', { name: '每周大概 5 小时，希望两个月内完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认，开始规划路线' })).toBeVisible();
  await shot('requirements');

  await open('spaces');
  await expect(page.getByRole('button', { name: '继续学习', exact: true })).toHaveCount(2);
  await shot('spaces');

  await open('route');
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('保留在 Agent 中的草稿');
  await page.getByRole('button', { name: '收起 Agent' }).click();
  const routeInput = page.getByRole('textbox', { name: '路线调整想法' });
  await routeInput.fill('我想先做项目');
  await routeInput.press('Enter');
  await expect(page.getByRole('button', { name: '确认调整路线' })).toBeVisible({ timeout: 12000 });
  await page.getByRole('main').locator(':scope > div').evaluate((el) => el.scrollTop = 0);
  await shot('route-agent');

  await open('unit');
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByLabel('编辑 move_demo.rs', { exact: true }).fill('fn main() {\n    println!("layout kept");\n}');
  await expect(page.getByRole('region', { name: 'IDE 与终端', exact: true }).locator('[title^="rustc"]')).toBeVisible();
  const command = page.getByRole('textbox', { name: '终端命令' });
  await command.fill('rustc examples/move_demo.rs');
  await command.press('Enter');
  await expect(page.getByRole('log', { name: '终端输出' })).toContainText('layout kept');
  await page.getByRole('button', { name: '引用终端输出' }).click();
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('保留工作台草稿');
  await command.fill('ls examples');
  await shot('ide-normal');
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  await shot('ide-fullscreen');
  await page.getByRole('button', { name: '查看课件' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Wait for the sheet's autofocus (which scrolls to the first code action), then show the header.
  await expect(page.getByRole('dialog').getByRole('button', { name: '复制', exact: true }).first()).toBeFocused();
  await page.getByRole('dialog').locator('.lesson-prose').evaluate((el) => el.parentElement!.scrollTop = 0);
  await shot('lesson-drawer');

  await open('unit');
  await page.getByRole('button', { name: '开始单元测评' }).click();
  await page.getByLabel('你的回答', { exact: true }).fill('我还不明白变量为什么不能使用');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText('error[E0382]: borrow of moved value: `name`', { exact: true })).toBeVisible();
  await shot('assessment');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText(source === 'prototype' ? '再巩固一下会更扎实' : '这次还有需要修改的地方', { exact: true })).toBeVisible();
  await shot('needs-work');
  // Prototype record IDs use Date.now(); keep distinct attempts distinct without nondeterministic dates.
  await page.clock.setFixedTime(new Date('2026-10-02T10:01:00Z'));
  await page.getByRole('button', { name: '重新测评', exact: true }).click();
  await page.getByLabel('你的回答', { exact: true }).fill('let b = a 将所有权转移给 b，a 失效；用 clone 复制或借用 &a 保持 a 可用。');
  await page.getByLabel('编辑 assessment_fix.rs', { exact: true }).fill('fn shout(s: &String) -> String {\n    s.to_uppercase()\n}\n\nfn main() {\n    let name = String::from("ferris");\n    let loud = shout(&name);\n    println!("{} -> {}", name, loud);\n}');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText(source === 'prototype' ? '你已经掌握了这个单元' : '本次测评通过', { exact: true })).toBeVisible();
  await shot('passed');

  await open('route', 'lesson');
  await page.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: '结构体与枚举' }) }).getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByText('课件生成失败', { exact: true })).toBeVisible();
  await shot('lesson-failure');

  await open('route', 'reply');
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('这条路线大概要多久？');
  await page.getByLabel('向 Agent 提问', { exact: true }).press('Enter');
  await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
  await shot('reply-failure');
}

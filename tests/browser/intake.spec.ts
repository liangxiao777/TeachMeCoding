import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { SessionDetail, Workspace } from '../../packages/contracts/src/workspace';
import type { ResearchDossier } from '../../packages/contracts/src/intake';

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });
const confirm = (page: Page) => page.getByRole('button', { name: '确认并规划路线', exact: true });
const composer = (page: Page) => page.getByLabel('回复 Agent', { exact: true });
const customAnswer = (page: Page) => page.getByLabel('填写自定义回答', { exact: true });
const shot = async (page: Page, info: TestInfo, state: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `.amp/in/artifacts/adaptive-${state}-${info.project.name}.png`, animations: 'disabled' });
};
async function business<T>(page: Page, path: string, body?: unknown): Promise<{ status: number; value: T }> {
  return page.evaluate(async ({ path, body }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-TMC-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { path, body });
}
async function open(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('你想学什么', { exact: true }).fill(`自适应问答验收 ${name}`);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByText('待确认问题', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get('space')!;
  const saved = (await business<Workspace>(page, `/spaces/${id}`)).value;
  const session = saved.sessions.find((s) => s.scope === 'intake')!.id;
  return { id, session, saved };
}
async function researched(page: Page, name: string) {
  const opened = await open(page, name);
  await page.getByRole('radio', { name: /离线命令行工具/ }).check();
  await page.getByRole('button', { name: '下一个', exact: true }).click();
  await page.getByRole('checkbox', { name: /识别坏输入/ }).check();
  await page.getByRole('button', { name: '提交全部回答', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  const saved = (await business<Workspace>(page, `/spaces/${opened.id}`)).value;
  const ref = saved.requirement.intake!.researchRef!;
  const dossier = (await business<ResearchDossier>(page, `/spaces/${opened.id}/research/${ref.id}/${ref.revision}`)).value;
  return { ...opened, saved, ref, dossier };
}

test('tool errors before or after a valid draft do not fail intake and remain visible after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  for (const order of ['先失败', '后失败']) {
    await page.goto('/');
    await page.getByLabel('你想学什么', { exact: true }).fill(`工具错误验收 ${order} ${info.project.name}`);
    await page.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.getByText('补充抓取未完成；需求草稿已整理，请核对。', { exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get('space')!;
    await expect.poll(async () => (await business<Workspace>(page, `/spaces/${id}`)).value.runs[0]?.state).toBe('succeeded');
    const saved = (await business<Workspace>(page, `/spaces/${id}`)).value;
    expect(saved.requirement.value.rows).toEqual([{ question: '想学习什么？', answer: '理解文件读取与错误处理' }]);
    expect(saved.requirement.revision).toBe(1); expect(saved.requirement.confirmed).toBe(false);
    await page.reload();
    await expect(page.getByText('补充抓取未完成；需求草稿已整理，请核对。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    const group = page.getByTestId('tool-call-group');
    await expect(group).toContainText('2 次调用');
    await expect(group).toContainText('1 次成功');
    await expect(group.getByTestId('tool-call-issues')).toContainText('1 次失败');
    await group.getByRole('button', { name: '工具调用', exact: true }).click();
    const failed = group.getByTestId('tool-call').filter({ hasText: 'web_fetch' });
    await failed.getByRole('button').click();
    await expect(failed.locator('pre')).toContainText('http://127.0.0.1/private');
    const session = saved.sessions.find((s) => s.scope === 'intake')!.id;
    const detail = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value;
    expect(detail.messages.at(-1)?.status).toBe('done');
    expect(detail.messages.at(-1)?.parts?.filter((part) => part.type === 'tool').map((part) => part.status))
      .toEqual(order === '先失败' ? ['error', 'done'] : ['done', 'error']);
    await shot(page, info, order === '先失败' ? 'tool-error-before' : 'tool-error-after');
  }
  expect(errors).toEqual([]);
});

test('options/custom answers survive a lost receipt, preserve the composer, and hand a pinned dossier to planning', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const { id, session } = await open(page, `答案重试 ${info.project.name}`);
  await expect(confirm(page)).toBeDisabled();
  await expect(page.getByText('请回答待确认问题，或修改需求后重新核对。', { exact: true })).toBeVisible();
  const submit = page.getByRole('button', { name: '提交全部回答', exact: true });
  const navigation = page.getByRole('navigation', { name: '问题切换', exact: true });
  const previous = navigation.getByRole('button', { name: '上一个', exact: true });
  const next = navigation.getByRole('button', { name: '下一个', exact: true });
  await expect(page.locator('fieldset')).toHaveCount(1);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(navigation.getByRole('status')).toContainText('问题 1 / 2');
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(submit).toBeDisabled();
  await shot(page, info, 'questions');
  await page.getByRole('radio', { name: /离线命令行工具/ }).focus();
  await page.keyboard.press('Space');
  await expect(submit).toBeDisabled(); // Completing only the visible question is not enough.
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('fieldset')).toHaveCount(1);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(navigation.getByRole('status')).toContainText('问题 2 / 2');
  await expect(next).toBeDisabled();
  await page.getByRole('checkbox', { name: /识别坏输入/ }).check();
  await page.getByRole('checkbox', { name: /解释状态/ }).check();
  await page.getByRole('checkbox', { name: /其他/ }).check();
  await expect(submit).toBeDisabled();
  await customAnswer(page).fill('希望对比中文、英文与损坏记录 <保留 & 原文>');
  const labelGap = await customAnswer(page).evaluate((input) => {
    const label = input.parentElement!.querySelector('label')!;
    return input.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
  });
  expect(labelGap).toBeGreaterThanOrEqual(8);
  await expect(submit).toBeEnabled();
  await previous.click();
  await expect(page.getByRole('radio', { name: /离线命令行工具/ })).toBeChecked();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await next.click();
  await expect(page.getByRole('checkbox', { name: /识别坏输入/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /解释状态/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /测量内存/ })).not.toBeChecked();
  await expect(customAnswer(page)).toHaveValue('希望对比中文、英文与损坏记录 <保留 & 原文>');
  await shot(page, info, 'custom');
  await page.setViewportSize({ width: 390, height: 844 });
  await confirm(page).scrollIntoViewIfNeeded();
  await expect(confirm(page)).toBeInViewport();
  await previous.click();
  const firstOption = page.getByRole('radio', { name: /离线命令行工具/ });
  await firstOption.scrollIntoViewIfNeeded();
  await expect(firstOption).toBeInViewport();
  await expect(firstOption).toBeChecked();
  await next.click();
  await customAnswer(page).scrollIntoViewIfNeeded();
  await expect(customAnswer(page)).toBeInViewport();
  expect(await previous.evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect(customAnswer(page)).toHaveValue('希望对比中文、英文与损坏记录 <保留 & 原文>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, info, 'narrow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await composer(page).fill('尚未发送的想法，不属于选项回答');
  let dropped = false;
  await page.route('**/questions/*/answer', async (route) => {
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await submit.click();
  await expect(page.getByRole('alert').filter({ hasText: '答案提交未确认' })).toBeVisible();
  await expect(customAnswer(page)).toHaveValue('希望对比中文、英文与损坏记录 <保留 & 原文>');
  await composer(page).fill('断线后新写的想法，必须保留');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  await expect(composer(page)).toHaveValue('断线后新写的想法，必须保留');
  const saved = (await business<Workspace>(page, `/spaces/${id}`)).value;
  expect(saved.runs).toHaveLength(2); expect(saved.requirement.confirmed).toBe(false);
  const detail = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value;
  expect(detail.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  const round = detail.questions![0]!;
  expect(round.state).toBe('answered');
  expect(round.answers).toEqual([
    { questionId: round.questions[0]!.id, optionIds: [round.questions[0]!.options[0]!.id], customText: '' },
    { questionId: round.questions[1]!.id, optionIds: [round.questions[1]!.options[0]!.id, round.questions[1]!.options[2]!.id], customText: '希望对比中文、英文与损坏记录 <保留 & 原文>' },
  ]);
  await page.locator('summary').filter({ hasText: '确认问题 · 已回答' }).click();
  await expect(page.getByText('其他（自定义）：希望对比中文、英文与损坏记录 <保留 & 原文>', { exact: true })).toBeVisible();
  const history = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '确认问题 · 已回答' }) });
  await history.getByRole('button', { name: '上一个', exact: true }).click();
  await expect(history.getByText('已选：离线命令行工具', { exact: true })).toBeVisible();
  await expect(history.getByText('其他（自定义）：希望对比中文、英文与损坏记录 <保留 & 原文>', { exact: true })).toHaveCount(0);
  await history.getByRole('button', { name: '下一个', exact: true }).click();
  await expect(history.getByText('已选：离线命令行工具', { exact: true })).toHaveCount(0);
  await expect(history.getByText('其他（自定义）：希望对比中文、英文与损坏记录 <保留 & 原文>', { exact: true })).toBeVisible();
  const layout = await history.evaluate((card) => {
    const conversation = card.closest('[role="log"]')!.getBoundingClientRect();
    const question = card.getBoundingClientRect();
    const composer = document.getElementById('ob-input')!.closest('form')!.getBoundingClientRect();
    return { questionWidth: question.width, scrollSpacing: conversation.right - question.right,
      composerSpacing: composer.top - conversation.bottom };
  });
  expect(layout.questionWidth).toBeGreaterThanOrEqual(700);
  expect(layout.scrollSpacing).toBeGreaterThanOrEqual(24);
  expect(layout.composerSpacing).toBeGreaterThanOrEqual(16);
  await shot(page, info, 'answered');
  const ref = saved.requirement.intake!.researchRef!;
  expect(ref.revision).toBe(1);
  await page.getByRole('button', { name: '查看固定版本资料', exact: true }).click();
  const research = page.getByRole('region', { name: '固定版本调研资料', exact: true });
  await expect(research.getByRole('heading', { name: 'Cedar（验收用项目） 4.7.2', exact: true })).toBeVisible();
  await expect(research.getByRole('table')).toContainText('Node 24');
  await expect(research.locator('pre')).toHaveText('  parse("a");\n');
  await expect(research.getByRole('link')).toHaveAttribute('href', 'https://docs.example.org/cedar/4.7.2');
  await expect(research).not.toContainText(ref.id);
  await research.screenshot({ path: `.amp/in/artifacts/adaptive-research-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await research.getByRole('heading', { name: '学习范围', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(research.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  await research.getByRole('link').scrollIntoViewIfNeeded();
  await expect(research.getByRole('link')).toBeInViewport();
  // Keep the tested narrow width; a taller capture includes the whole document
  // without clipping it at the requirement panel's scroll-container boundary.
  await page.setViewportSize({ width: 390, height: 1000 });
  await research.screenshot({ path: `.amp/in/artifacts/adaptive-research-narrow-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const file = await download, filePath = `.amp/in/artifacts/adaptive-dossier-${info.project.name}.md`;
  expect(file.suggestedFilename()).toBe(`research-${ref.id}-v1.md`);
  await file.saveAs(filePath);
  const markdown = readFileSync(filePath, 'utf8');
  expect(markdown).toContain('# Cedar（验收用项目） 4.7.2');
  expect(markdown).toContain('Cedar 用来逐块解析记录'); expect(markdown).not.toContain('FULL-PAGE-ONLY');
  expect(markdown).toContain('```ts\n  parse("a");\n```');
  expect(markdown).toContain('[官方资料](https://docs.example.org/cedar/4.7.2)');
  const dossier = (await business<ResearchDossier>(page, `/spaces/${id}/research/${ref.id}/${ref.revision}`)).value;
  expect(dossier.content).toBe(markdown);
  expect(dossier).not.toHaveProperty('facts'); expect(dossier).not.toHaveProperty('sources');
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('只改时间：每周三 45 分钟');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  expect((await business<Workspace>(page, `/spaces/${id}`)).value.requirement.intake!.researchRef).toEqual(ref);
  await confirm(page).click();
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  expect((await business<Workspace>(page, `/spaces/${id}`)).value.route.intake!.researchRef).toEqual(ref);
  expect(errors).toEqual([]);
});

test('research Markdown renders without executing HTML, loading images or enabling unsafe source links', async ({ page }, info) => {
  const requests: string[] = [];
  await page.route('https://research-tracker.example/**', async (route) => { requests.push(route.request().url()); await route.abort(); });
  await open(page, `不可信 Markdown 验收 ${info.project.name}`);
  await page.getByRole('radio', { name: /离线命令行工具/ }).check();
  await page.getByRole('button', { name: '下一个', exact: true }).click();
  await page.getByRole('checkbox', { name: /识别坏输入/ }).check();
  await page.getByRole('button', { name: '提交全部回答', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  await page.getByRole('button', { name: '查看固定版本资料', exact: true }).click();
  const research = page.getByRole('region', { name: '固定版本调研资料', exact: true });
  await expect(research.getByRole('heading', { name: 'Cedar（验收用项目） 4.7.2', exact: true })).toBeVisible();
  await expect(research.locator('script, img, iframe')).toHaveCount(0);
  await expect(research.getByRole('link')).toHaveCount(1);
  await expect(research.getByRole('link')).toHaveAttribute('href', 'https://docs.example.org/cedar/4.7.2');
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '调研资料预览', exact: true });
  await expect(modal.getByRole('heading', { name: 'Cedar（验收用项目） 4.7.2', exact: true })).toBeVisible();
  await expect(modal.locator('script, img, iframe')).toHaveCount(0);
  await expect(modal.getByRole('link')).toHaveCount(1);
  await expect(modal.getByRole('link')).toHaveAttribute('href', 'https://docs.example.org/cedar/4.7.2');
  await modal.getByRole('tab', { name: 'Markdown 原文', exact: true }).click();
  await expect(modal.getByLabel('Markdown 原文内容', { exact: true })).toContainText('window.__researchInjected');
  await modal.getByRole('tab', { name: '渲染预览', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __researchInjected?: boolean }).__researchInjected)).toBeUndefined();
  expect(requests).toEqual([]);
});

test('a failed continuation retains actual custom text and retry does not accept the answer twice', async ({ page }, info) => {
  const { id, session } = await open(page, `模型失败 ${info.project.name}`);
  await page.getByRole('radio', { name: /其他/ }).check();
  await customAnswer(page).fill('回答后失败一次；我想处理自己的离线账本');
  await page.getByRole('button', { name: '下一个', exact: true }).click();
  await page.getByRole('checkbox', { name: /测量内存/ }).check();
  await page.getByRole('button', { name: '提交全部回答', exact: true }).click();
  const failure = page.getByRole('alert').filter({ hasText: '模型响应未正常完成，未保存生成产物。' });
  await expect(failure).toBeVisible();
  await expect(page.getByRole('button', { name: '提交全部回答', exact: true })).toHaveCount(0);
  const before = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value;
  expect(before.questions![0]!.state).toBe('answered');
  expect(before.questions![0]!.answers![0]!.customText).toBe('回答后失败一次；我想处理自己的离线账本');
  await composer(page).fill('重试模型回复期间的新草稿');
  await shot(page, info, 'failure');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue('重试模型回复期间的新草稿');
  const after = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value;
  expect(after.questions).toEqual(before.questions);
  expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  expect(after.messages.at(-1)!.retryOf).toBe(before.messages.at(-1)!.id);
  expect(after.messages.find((m) => m.status === 'error')).toEqual(before.messages.find((m) => m.status === 'error'));
  expect((await business<Workspace>(page, `/spaces/${id}`)).value.runs).toHaveLength(3);
  await page.reload();
  await expect(confirm(page)).toBeEnabled();
  await expect(composer(page)).toBeEnabled();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await shot(page, info, 'retry-recovered');
});

for (const count of [1, 4] as const) test(`one visible question preserves distinct custom answers and handles ${count} questions`, async ({ page }, info) => {
  const { id, session } = await open(page, `${count === 1 ? '单题问答' : '四题问答'} ${info.project.name}`);
  const submit = page.getByRole('button', { name: '提交全部回答', exact: true });
  const navigation = page.getByRole('navigation', { name: '问题切换', exact: true });
  const texts = ['先写脱敏账本 CLI', '失败样例与分块边界', '先试合成中文记录', '测试日志结合解释'];
  const types = ['radio', 'checkbox', 'radio', 'checkbox'] as const;
  await expect(navigation).toHaveCount(count === 1 ? 0 : 1);
  const rightInset = await submit.evaluate((button) =>
    button.closest('form')!.getBoundingClientRect().right - button.getBoundingClientRect().right);
  expect(Math.abs(rightInset)).toBeLessThanOrEqual(1);
  for (let index = 0; index < count; index++) {
    await expect(page.locator('fieldset')).toHaveCount(1);
    if (count > 1) await expect(navigation.getByRole('status')).toContainText(`问题 ${index + 1} / ${count}`);
    await page.getByRole(types[index]!, { name: /其他/ }).check();
    await customAnswer(page).fill(texts[index]!);
    if (index < count - 1) {
      await expect(submit).toBeDisabled();
      await navigation.getByRole('button', { name: '下一个', exact: true }).click();
    }
  }
  await expect(submit).toBeEnabled();
  if (count > 1) {
    await expect(navigation.getByRole('button', { name: '下一个', exact: true })).toBeDisabled();
    await shot(page, info, 'many-last');
    for (let index = count - 2; index >= 0; index--) {
      await navigation.getByRole('button', { name: '上一个', exact: true }).click();
      await expect(customAnswer(page)).toHaveValue(texts[index]!);
    }
    await expect(navigation.getByRole('button', { name: '上一个', exact: true })).toBeDisabled();
  } else await shot(page, info, 'single');
  await submit.click(); // Submitting from the first question still includes every answer.
  await expect(confirm(page)).toBeEnabled();
  const saved = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value;
  expect(saved.questions![0]!.questions).toHaveLength(count);
  expect(saved.questions![0]!.answers!.map((answer) => answer.customText)).toEqual(texts.slice(0, count));
  expect(saved.questions![0]!.answers!.map((answer) => answer.optionIds)).toEqual(Array.from({ length: count }, () => []));
  expect(saved.messages.filter((message) => message.role === 'user')).toHaveLength(2);
});

test('table edits supersede old questions and reject stale answers without forcing technology metadata', async ({ page }, info) => {
  const { id, session } = await open(page, `旧问题 ${info.project.name}`);
  const round = (await business<SessionDetail>(page, `/spaces/${id}/sessions/${session}`)).value.questions![0]!;
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('用户重新核对：周末半小时');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '确认问题 · 已取代' })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交全部回答', exact: true })).toHaveCount(0);
  const stale = await business(page, `/spaces/${id}/sessions/${session}/questions/${round.id}/answer`, {
    answers: round.questions.map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id], customText: '' })),
  });
  expect(stale.status).toBe(409);
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByLabel('学习对象类型', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加问题', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('问题 5', { exact: true }).fill('哪些信息还没确定？');
  await page.getByLabel('回答 5', { exact: true }).fill('版本暂不决定，之后结合调研再核对。');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await shot(page, info, 'editing');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('cell', { name: '版本暂不决定，之后结合调研再核对。', exact: true })).toBeVisible();
  await expect(confirm(page)).toBeEnabled();
  const current = (await business<Workspace>(page, `/spaces/${id}`)).value;
  expect(current.requirement.value.rows).toHaveLength(5);
  expect(current.requirement.value.rows[4]).toEqual({ question: '哪些信息还没确定？', answer: '版本暂不决定，之后结合调研再核对。' });
  expect(current.requirement.intake).toBeUndefined();
  expect(current.runs).toHaveLength(1);
});

test('the two-column table supports arbitrary questions, add/remove, blank answers and one whole-table document reference', async ({ page }, info) => {
  const { id, ref } = await researched(page, `轻量需求表格 ${info.project.name}`);
  const table = page.getByRole('table', { name: '学习需求', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['问题', '回答']);
  await expect(table.getByRole('row')).toHaveCount(5);
  await shot(page, info, 'qa-table');
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('问题 1', { exact: true }).fill('希望解决什么实际困难？');
  await page.getByLabel('回答 1', { exact: true }).fill('能定位中文账本中的损坏记录，保留行号。');
  await page.getByRole('button', { name: '移除第 2 行', exact: true }).click();
  await expect(page.getByLabel('回答 2', { exact: true })).toHaveValue('处理本地流水账的坏输入');
  await page.getByRole('button', { name: '添加问题', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('问题 4', { exact: true }).fill('有什么暂时没决定的？');
  await expect(page.getByLabel('回答 4', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await shot(page, info, 'qa-editor');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(confirm(page)).toBeEnabled();
  const current = (await business<Workspace>(page, `/spaces/${id}`)).value;
  expect(current.requirement.value.rows).toEqual([
    { question: '希望解决什么实际困难？', answer: '能定位中文账本中的损坏记录，保留行号。' },
    { question: '希望完成什么？', answer: '处理本地流水账的坏输入' },
    { question: '时间安排？', answer: '每周两次，每次 30 分钟' },
    { question: '有什么暂时没决定的？', answer: '' },
  ]);
  expect(current.requirement.intake).toEqual({ researchRef: ref });
  await page.reload();
  await expect(table.getByRole('cell', { name: '有什么暂时没决定的？', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '待补充', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('aside').scrollIntoViewIfNeeded();
  await expect(table).toBeInViewport();
  await expect(page.getByRole('button', { name: '全屏预览', exact: true })).toBeInViewport();
  await expect(confirm(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, info, 'qa-narrow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '修改', exact: true }).click();
  for (let count = 4; count > 0; count--) await page.getByRole('button', { name: '移除第 1 行', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(confirm(page)).toBeDisabled();
  await expect(table).toHaveCount(0);
  await shot(page, info, 'qa-empty');
  const empty = (await business<Workspace>(page, `/spaces/${id}`)).value;
  expect(empty.requirement.value).toEqual({ rows: [] });
  expect(empty.requirement.intake).toEqual({ researchRef: ref });
  expect((await business(page, `/spaces/${id}/requirement`, { ...empty.requirement, confirmed: true })).status).toBe(422);
});

test('fullscreen Markdown supports rendered/source modes, dirty-close protection and one durable save after a lost receipt', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const { id, saved, ref, dossier } = await researched(page, `全屏 Markdown ${info.project.name}`);
  const trigger = page.getByRole('button', { name: '全屏预览', exact: true });
  await trigger.click();
  const modal = page.getByRole('dialog', { name: '调研资料预览', exact: true });
  const raw = modal.getByLabel('Markdown 原文内容', { exact: true });
  await expect(modal.getByRole('heading', { name: 'Cedar（验收用项目） 4.7.2', exact: true })).toBeVisible();
  await expect(modal.getByRole('table')).toContainText('Node 24');
  await expect(modal.locator('pre')).toHaveText('  parse("a");\n');
  const geometry = await modal.boundingBox();
  expect(geometry).not.toBeNull();
  expect(Math.abs(geometry!.x + geometry!.width / 2 - 720)).toBeLessThan(2);
  expect(Math.abs(geometry!.y + geometry!.height / 2 - 500)).toBeLessThan(2);
  expect(geometry!.width).toBeGreaterThan(1000); expect(geometry!.height).toBeGreaterThan(850);
  const backdrop = await page.locator('[data-slot="dialog-overlay"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return { filter: style.backdropFilter, background: style.backgroundColor };
  });
  expect(backdrop.filter).toMatch(/blur\((?!0px)/);
  expect(backdrop.background).toMatch(/0\.2\b|20%/);
  await shot(page, info, 'markdown-preview');
  await modal.getByRole('tab', { name: 'Markdown 原文', exact: true }).click();
  await expect(raw).toHaveValue(dossier.content);
  await expect(raw).toHaveJSProperty('readOnly', true);
  await shot(page, info, 'markdown-source');
  await modal.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(raw).toHaveJSProperty('readOnly', false);
  await expect(modal.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  const content = '# Cedar（验收用项目） 4.7.2\n\n## 我补充的学习重点\n\n先处理中文账本，比较整文件与分块解析。\n\n- 保留损坏记录的行号\n- 对比内存占用\n\n| 环境 | 版本 |\n| --- | --- |\n| Node | 24 |\n\n```ts\n  parse("中文账本");\n```\n\n[官方资料](https://docs.example.org/cedar/4.7.2)\n';
  await raw.fill(content);
  await shot(page, info, 'markdown-edit');
  await page.keyboard.press('Escape');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('alert')).toHaveText('有未保存的修改，是否放弃并关闭？');
  await modal.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(raw).toHaveValue(content);
  await modal.getByRole('tab', { name: '渲染预览', exact: true }).click();
  await expect(modal.getByRole('heading', { name: '我补充的学习重点', exact: true })).toBeVisible();
  expect((await business<ResearchDossier>(page, `/spaces/${id}/research/${ref.id}/1`)).value.content).toBe(dossier.content);

  const keys: string[] = [];
  await page.route(`**/spaces/${id}/research/${ref.id}/1`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key']!);
    if (keys.length === 1) { await route.fetch(); await route.abort(); } else await route.continue();
  });
  await modal.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('输入已保留。');
  await modal.getByRole('tab', { name: 'Markdown 原文', exact: true }).click();
  await expect(raw).toHaveValue(content);
  await modal.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(modal.getByRole('status').filter({ hasText: '已保存 · 修订 2' })).toBeVisible();
  await expect(modal).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  const current = (await business<Workspace>(page, `/spaces/${id}`)).value;
  expect(current.requirement.revision).toBe(saved.requirement.revision + 1);
  expect(current.requirement.confirmed).toBe(false);
  expect(current.requirement.intake!.researchRef).toEqual({ id: ref.id, revision: 2 });
  expect((await business<ResearchDossier>(page, `/spaces/${id}/research/${ref.id}/2`)).value).toMatchObject({ content, runId: null });
  expect((await business(page, `/spaces/${id}/research/${ref.id}/3`)).status).toBe(404);
  await modal.getByRole('tab', { name: '渲染预览', exact: true }).click();
  await expect(modal.getByRole('heading', { name: '我补充的学习重点', exact: true })).toBeVisible();
  await shot(page, info, 'markdown-saved');
  await modal.getByRole('button', { name: '关闭资料预览', exact: true }).click();
  await expect(modal).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  await modal.getByRole('tab', { name: 'Markdown 原文', exact: true }).click();
  await expect(raw).toHaveValue(content); await expect(raw).toHaveJSProperty('readOnly', true);
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: '关闭资料预览', exact: true }).click();
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const file = await download, filePath = `.amp/in/artifacts/adaptive-edited-${info.project.name}.md`;
  expect(file.suggestedFilename()).toBe(`research-${ref.id}-v2.md`);
  await file.saveAs(filePath); expect(readFileSync(filePath, 'utf8')).toBe(content);
  expect(errors).toEqual([]);
});

test('a stale fullscreen edit retains input and cannot overwrite another saved document', async ({ page }, info) => {
  const { id, ref, dossier } = await researched(page, `资料冲突 ${info.project.name}`);
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '调研资料预览', exact: true });
  await modal.getByRole('button', { name: '编辑', exact: true }).click();
  const raw = modal.getByLabel('Markdown 原文内容', { exact: true });
  const draft = '# 未保存的窗口草稿\n\n不能丢失这个说明。';
  await raw.fill(draft);
  const newer = '# 另一处的修改\n\n保留这个已保存内容。';
  expect((await business(page, `/spaces/${id}/research/${ref.id}/1`, { content: newer })).status).toBe(200);
  await modal.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('内容已改变');
  await expect(raw).toHaveValue(draft);
  await expect(modal.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  expect((await business<ResearchDossier>(page, `/spaces/${id}/research/${ref.id}/2`)).value.content).toBe(newer);
  expect((await business<ResearchDossier>(page, `/spaces/${id}/research/${ref.id}/1`)).value.content).toBe(dossier.content);
  expect((await business(page, `/spaces/${id}/research/${ref.id}/3`)).status).toBe(404);
  await modal.getByRole('button', { name: '关闭资料预览', exact: true }).click();
  await expect(modal.getByRole('alert').filter({ hasText: '有未保存的修改' })).toHaveText('有未保存的修改，是否放弃并关闭？');
  await shot(page, info, 'markdown-conflict');
  await modal.getByRole('button', { name: '放弃并关闭', exact: true }).click();
  await expect(modal).not.toBeVisible();
});

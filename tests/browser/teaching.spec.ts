import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });
async function create(page: Page, goal: string) {
  await page.goto('/');
  await page.getByLabel('你想学什么', { exact: true }).fill(goal);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByLabel('学习空间名称', { exact: true })).toHaveValue(goal);
}
async function send(page: Page, text: string) {
  await page.getByLabel('回复 Agent', { exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
test('formal intake uses streamed API output, editable drafts and explicit confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  await create(page, `真实需求 API ${info.project.name}`);
  let dropped = false;
  await page.route('**/sessions/*/runs', async (route) => {
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await send(page, '我有 Python 自动化经验，每周 3 小时，6 周做一个命令行工具');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('回复 Agent', { exact: true }).fill('请求重试时的新草稿');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^每周 3 小时，共 6 周$/ })).toBeVisible();
  await expect(page.getByLabel('回复 Agent', { exact: true })).toHaveValue('请求重试时的新草稿');
  await expect(page.getByText('我有 Python 自动化经验，每周 3 小时，6 周做一个命令行工具', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('每周 4 小时');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('dd').filter({ hasText: /^每周 4 小时$/ })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-intake-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await expect(page.getByTestId('route-proposal')).toContainText('参数与输入');
  await expect(page.getByText('尚无学习路线', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-proposal-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByTestId('route-proposal')).toBeVisible();
  await page.getByRole('button', { name: '确认调整路线', exact: true }).click();
  await expect(page.getByTestId('route-proposal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^每周 4 小时$/ })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-route-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await expect(page.getByText('本示例尚未在本机执行。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByPlaceholder('说说你的想法…', { exact: true }).fill('参数读取和验证有什么区别？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '采纳结论', exact: true }).click();
  await expect(page.getByText('学习结论 · 已采纳', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-tutor-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '撤销采纳', exact: true }).click();
  await expect(page.getByText('学习结论 · 待采纳', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始单元测评', exact: true }).click();
  await expect(page.getByText('解释命令行参数来自哪里', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeDisabled();
  await page.getByLabel('你的回答', { exact: true }).fill('固定提交：由程序的调用者传入');
  await page.getByRole('button', { name: '载入起始代码', exact: true }).click();
  await expect(page.getByLabel('编辑 代码答案', { exact: true })).toHaveValue('import sys\n');
  await page.getByLabel('编辑 代码答案', { exact: true }).fill('print(2)');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('正在评估固定提交；你可以继续编辑新草稿。代码不会执行。', { exact: true })).toBeVisible();
  // Hold the terminal refresh at an older saved revision while the user saves a new draft.
  let captured = false, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const unit = new URL(page.url()).searchParams.get('unit');
  await page.route(`**/units/${unit}`, async (route) => {
    if (captured) return route.continue();
    const response = await route.fetch(); captured = true;
    await held; await route.fulfill({ response });
  });
  try {
    await expect.poll(() => captured, { timeout: 15000 }).toBe(true);
    await page.getByLabel('你的回答', { exact: true }).fill('评估期间的新草稿');
    await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存答案草稿', exact: true })).toBeDisabled();
    await page.screenshot({ path: `.amp/in/artifacts/teaching-evaluating-${info.project.name}.png`, animations: 'disabled' });
  } finally { release(); }
  await expect(page.getByText('代码尚未通过真实执行验证', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('固定提交：由程序的调用者传入', { exact: true })).toBeVisible();
  await expect(page.getByText('已经掌握', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.screenshot({ path: `.amp/in/artifacts/teaching-unverified-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '重新测评', exact: true }).click();
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue('评估期间的新草稿');
  await expect(page.getByRole('button', { name: '保存答案草稿', exact: true })).toBeDisabled();
  await expect(page.getByText('单元测评 · 第 2 次', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue('评估期间的新草稿');
});

test('stream survives page reload and session switching; stop and model failure remain visible', async ({ page }, info) => {
  await create(page, `流式状态 ${info.project.name}`);
  await send(page, '慢速说明');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect(page.getByText('正在逐步整理。', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-stream-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await expect(page.getByText('慢速说明', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  await page.getByRole('menuitem', { name: /^学习需求/ }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText(/^已停止生成/)).toBeVisible();
  await send(page, '模型失败');
  await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-failure-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
  await expect(page.getByText('模型失败', { exact: true })).toHaveCount(1);
});

test('reasoning assessment failure retries the same attempt; expired evidence stays historical', async ({ page }, info) => {
  test.setTimeout(60000);
  await create(page, `非执行测评 ${info.project.name}`);
  await send(page, '纯推理');
  await expect(page.locator('dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '确认调整路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始单元测评', exact: true }).click();
  await page.getByLabel('分析题回答', { exact: true }).fill('零个参数不会有用户输入，两个则包含两个字符串。');
  await page.getByLabel('你的回答', { exact: true }).fill('FAIL-ONCE：调用者');
  await page.screenshot({ path: `.amp/in/artifacts/teaching-reasoning-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('任务失败或已中断；原题目和答案仍保留。', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-task-failure-${info.project.name}.png`, animations: 'disabled' });
  await page.getByLabel('你的回答', { exact: true }).fill('NEW-DRAFT');
  await page.getByRole('button', { name: info.project.name === 'development' ? '重试' : '重试原任务', exact: true }).click();
  await expect(page.getByText('你已经掌握了这个单元', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('FAIL-ONCE：调用者', { exact: true })).toBeVisible();
  await expect(page.getByText(/第 1 次测评/)).toBeVisible();
  await expect(page.getByText('分析题', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-nonexecution-result-${info.project.name}.png`, animations: 'disabled' });
  const changed = await page.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('space');
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() };
    const workspace = await (await fetch(`/api/spaces/${id}`, { headers })).json();
    return (await fetch(`/api/spaces/${id}/requirement`, { method: 'POST', headers, body: JSON.stringify({ ...workspace.requirement,
      value: { ...workspace.requirement.value, schedule: '改变后的计划' } }) })).status;
  });
  expect(changed).toBe(200);
  await page.reload();
  await expect(page.getByText('此结果基于旧版本，请重新测评', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^进入下一单元/ })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/teaching-expired-${info.project.name}.png`, animations: 'disabled' });
});

import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' } });
async function create(page: Page, goal: string) {
  await page.goto('/');
  await page.getByLabel('你想学什么', { exact: true }).fill(goal);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByLabel('学习空间名称', { exact: true })).toHaveValue(goal.slice(0, 80));
}
async function send(page: Page, text: string) {
  await page.getByLabel('回复 Agent', { exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
test('formal intake uses streamed API output, editable drafts and explicit confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const opening = `我想做一个命令行工具，有 Python 自动化经验，每周 3 小时，计划 6 周完成。${info.project.name}`;
  await create(page, opening);
  await expect(page.getByText(opening, { exact: true })).toHaveCount(1);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await expect(page.locator('dd').filter({ hasText: opening })).toHaveCount(0);
  await expect(page.getByLabel('回复 Agent', { exact: true })).toHaveValue('');
  await page.screenshot({ path: `.amp/in/artifacts/intake-opening-${info.project.name}.png`, animations: 'disabled' });
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
  await expect(page.getByText(`正在为「${opening.slice(0, 80)}」规划学习路线`, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '学习需求摘要', exact: true })).toHaveCount(0);
  await expect(page.getByText('尚无学习路线', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  await expect(page.getByTestId('route-proposal')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认调整路线', exact: true })).toHaveCount(0);
  await page.reload();
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
  const opening = `慢速说明 ${info.project.name}`;
  await create(page, opening);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect(page.getByText('正在逐步整理。', { exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-stream-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换会话', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await expect(page.getByText(opening, { exact: true })).toHaveCount(0);
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
  await create(page, `纯推理 ${info.project.name}`);
  await expect(page.locator('dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
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

test('a lost opening response retries one space, message and automatically started run', async ({ page }, info) => {
  const opening = `创建响应丢失 ${info.project.name}`;
  let dropped = false, submittedRuns = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && /\/sessions\/[^/]+\/runs$/.test(request.url())) submittedRuns++; });
  await page.route('**/api/spaces', async (route) => {
    if (route.request().method() === 'POST' && !dropped) { dropped = true; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('你想学什么', { exact: true }).fill(opening);
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('你想学什么', { exact: true })).toHaveValue(opening);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText(opening, { exact: true })).toHaveCount(1);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText(opening, { exact: true })).toHaveCount(1);
  const counts = await page.evaluate(async (name) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token };
    const spaces = await (await fetch('/api/spaces', { headers })).json();
    const workspace = await (await fetch(`/api/spaces/${new URL(location.href).searchParams.get('space')}`, { headers })).json();
    return { spaces: spaces.filter((space: { name: string }) => space.name === name).length, runs: workspace.runs.length };
  }, opening);
  expect(counts).toEqual({ spaces: 1, runs: 1 });
  expect(submittedRuns).toBe(0);
});

test('empty requirements are editable and late intake cannot replace saved or unsaved manual edits', async ({ page }, info) => {
  test.setTimeout(45000);
  for (const saveEarly of [false, true]) {
    await create(page, `延迟摘要 ${saveEarly} ${info.project.name}`);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: /^待补充$/ })).toHaveCount(4);
    await expect(page.getByRole('button', { name: '确认，开始规划路线', exact: true })).toBeDisabled();
    if (!saveEarly) await page.screenshot({ path: `.amp/in/artifacts/intake-empty-${info.project.name}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '修改', exact: true }).click();
    await page.getByLabel('学习目标', { exact: true }).fill('手动指定：分析日志文件');
    await page.getByLabel('已有基础', { exact: true }).fill('只会 SQL');
    if (saveEarly) await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 15000 });
    if (!saveEarly) {
      // The tool's result has refreshed the server revision, but not this local edit.
      await expect(page.getByText('需求草稿已更新，请检查右侧摘要。', { exact: false })).toBeVisible();
      await expect(page.getByLabel('学习目标', { exact: true })).toHaveValue('手动指定：分析日志文件');
      await expect(page.getByLabel('已有基础', { exact: true })).toHaveValue('只会 SQL');
      await page.screenshot({ path: `.amp/in/artifacts/intake-manual-${info.project.name}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: '保存', exact: true }).click();
    } else await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
    await expect(page.locator('dd').filter({ hasText: /^手动指定：分析日志文件$/ })).toBeVisible();
    await page.reload();
    await expect(page.locator('dd').filter({ hasText: /^只会 SQL$/ })).toBeVisible();
  }
});

test('standalone planning survives reload and leaving; only later route adjustments need confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `规划恢复 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('PLAN-SLOW 每周 4 小时');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  const title = page.getByText(`正在为「${goal}」规划学习路线`, { exact: true });
  await expect(title).toBeVisible();
  await expect(page.getByRole('button', { name: '执行进度', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('分析学习需求', { exact: true })).toBeVisible();
  await expect(page.getByTestId('tool-call')).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/planning-initial-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(title).toBeVisible();
  await expect(page.getByLabel('回复 Agent', { exact: true })).toHaveCount(0);
  const stageTool = page.getByTestId('tool-call').first();
  await expect(stageTool.getByText('已返回', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('生成路线内容', { exact: true }).locator('../..')).toHaveClass(/text-foreground/);
  await expect(page.getByText('校验路线结构', { exact: true }).locator('../..')).toHaveClass(/text-muted-foreground\/50/);
  await stageTool.getByRole('button').click();
  await expect(stageTool.locator('pre')).toContainText('"title": "工具基础"');
  await page.screenshot({ path: `.amp/in/artifacts/planning-progress-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '全部学习空间', exact: true }).click();
  await expect(title).toHaveCount(0);
  // Completion updates its own space without navigating away from the space list.
  await expect.poll(async () => (await workspace(page, goal)).route.content, { timeout: 15000 }).not.toBeNull();
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '继续学习', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  await expect(page.getByTestId('route-proposal')).toHaveCount(0);
  const first = await workspace(page, goal);
  expect(first.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
  expect(first.tasks).toHaveLength(0); // Route completion must not silently generate lessons.
  await page.getByRole('textbox', { name: '路线调整想法', exact: true }).fill('保留单元，调整为更多边界练习');
  await page.getByRole('textbox', { name: '路线调整想法', exact: true }).press('Enter');
  await expect(page.getByTestId('route-proposal')).toContainText('调整后增加边界练习', { timeout: 15000 });
  expect((await workspace(page, goal)).route).toEqual(first.route);
  await page.screenshot({ path: `.amp/in/artifacts/planning-adjustment-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '确认调整路线', exact: true }).click();
  await expect(page.getByTestId('route-proposal')).toHaveCount(0);
  expect((await workspace(page, goal)).route.content.note).toBe('调整后增加边界练习');
});

test('planning response loss, provider failure and cancellation remain recoverable without repeating confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `规划错误恢复 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('PLAN-FAIL-ONCE PLAN-SLOW');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  let dropped = false, failedRefresh = false, confirmations = 0;
  await page.route('**/plan', async (route) => {
    confirmations++;
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  const spaceId = new URL(page.url()).searchParams.get('space');
  await page.route(`**/api/spaces/${spaceId}`, async (route) => {
    if (!failedRefresh) { failedRefresh = true; await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => failedRefresh).toBe(true);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试规划', exact: true })).toBeVisible({ timeout: 15000 });
  expect(confirmations).toBe(2); // The successful confirmation is not resubmitted after a failed read.
  const failed = await workspace(page, goal);
  expect(failed.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
  expect(failed.route.content).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/planning-failed-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '返回修改需求', exact: true }).click();
  await page.getByRole('button', { name: '查看规划进度', exact: true }).click();
  await page.getByRole('button', { name: '重试规划', exact: true }).click();
  await page.getByRole('button', { name: '停止规划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '路线规划已停止', exact: true })).toBeVisible();
  let reads = 0, captured = false, delivered = false, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/spaces/${spaceId}`, async (route) => {
    // The first read boots the page; delay the interrupted run's subsequent refresh.
    if (++reads !== 2) return route.continue();
    const response = await route.fetch(); captured = true;
    await held; await route.fulfill({ response }); delivered = true;
  });
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: '路线规划已停止', exact: true })).toBeVisible();
    await expect.poll(() => captured).toBe(true);
    expect((await workspace(page, goal)).route.content).toBeNull();
    await page.getByRole('button', { name: '重试规划', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止规划', exact: true })).toBeVisible();
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(page.getByRole('button', { name: '停止规划', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '路线规划已停止', exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible({ timeout: 15000 });
  const completed = await workspace(page, goal);
  expect(completed.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(3);
  expect(completed.requirement.revision).toBe(failed.requirement.revision);
  expect(completed.route.revision).toBe(1);
});

test('AI Elements renders ordered reasoning, tools and Markdown after stream replay', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await create(page, `推理验收 ${info.project.name}`);
  const reasoning = page.getByTestId('reasoning');
  await reasoning.first().getByRole('button').click();
  await expect(reasoning.first()).toContainText('先核对已有基础。');
  await page.screenshot({ path: `.amp/in/artifacts/ai-reasoning-stream-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('heading', { name: '学习建议', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(reasoning).toHaveCount(2);
  const sequence = await page.getByTestId('run-content').locator(':scope > *').evaluateAll((elements) => elements.map((el) => (el as HTMLElement).dataset.testid ?? 'text'));
  expect(sequence).toEqual(['reasoning', 'text', 'tool-call', 'reasoning', 'text']);
  await reasoning.first().getByRole('button').click();
  await expect(reasoning.first()).toContainText('先核对已有基础。再区分目标与时间。最后整理需求。');
  await reasoning.last().getByRole('button').click();
  await expect(reasoning.last()).toContainText('工具已返回。核对学习时间与目标。');
  await expect(page.getByRole('table')).toContainText('每周两次');
  await expect(page.getByText('我会先整理目标。', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '带入 IDE', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: /整理学习需求.*已返回/ }).click();
  await expect(page.getByText('submit_requirement_draft', { exact: true })).toBeVisible();
  await expect(page.getByTestId('tool-call').locator('pre')).toContainText('已有变量基础');
  await expect(page.getByTestId('tool-call').locator('pre')).toContainText('"schedule": "每周两次"');
  await page.getByTestId('tool-call').screenshot({ path: `.amp/in/artifacts/tool-arguments-${info.project.name}.png`, animations: 'disabled' });
  await expect(page.locator('button button')).toHaveCount(0);
  const snapshots = await page.evaluate(async () => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token }, space = new URL(location.href).searchParams.get('space');
    const work = await (await fetch(`/api/spaces/${space}`, { headers })).json();
    const session = await (await fetch(`/api/spaces/${space}/sessions/${work.sessions[0].id}`, { headers })).text();
    return session;
  });
  expect(snapshots).not.toContain('PRIVATE-SIGNATURE');
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.screenshot({ path: `.amp/in/artifacts/ai-reasoning-complete-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '带入 IDE', exact: true }).click();
  await expect(page.getByLabel('编辑 agent_example.py', { exact: true })).toHaveValue('print("hello")');
  await page.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存文件', exact: true })).toBeDisabled();
  const code = await page.evaluate(async () => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const space = new URL(location.href).searchParams.get('space');
    const response = await fetch(`/api/spaces/${space}/project/file?path=agent_example.py`, { headers: { 'X-TMC-Token': token } });
    return response.json();
  });
  expect(code.content).toBe('print("hello")');
  expect(errors).toEqual([]);
});

test('reasoning cancellation retains partial thought and new input; IME does not submit', async ({ page }, info) => {
  await create(page, `推理验收 停止 ${info.project.name}`);
  await page.getByTestId('reasoning').getByRole('button').click();
  await expect(page.getByTestId('reasoning')).toContainText('先核对已有基础。');
  const input = page.getByLabel('回复 Agent', { exact: true });
  await input.fill('下一条未发送输入');
  await input.press('Enter'); // The generating form has a stop button, not a submit button.
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('已停止生成', { exact: false })).toBeVisible();
  await expect(input).toHaveValue('下一条未发送输入');
  await expect(page.getByRole('button', { name: '思考已中断', exact: true })).toBeVisible();
  let sends = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && /\/runs$/.test(new URL(request.url()).pathname)) sends++; });
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await input.dispatchEvent('compositionend');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('下一条未发送输入\n');
  expect(sends).toBe(0);
  await page.screenshot({ path: `.amp/in/artifacts/ai-reasoning-stopped-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: '思考已中断', exact: true }).click();
  await expect(page.getByTestId('reasoning')).toContainText('先核对已有基础。');
  await expect(page.getByTestId('tool-call')).toHaveCount(0);
});

test('fullscreen tutor keeps reasoning, Markdown and the composer inside the dark Agent panel', async ({ page }, info) => {
  await create(page, `深色辅导 ${info.project.name}`);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('推理验收：继续练习');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '采纳结论', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'IDE 与终端', exact: true }).click();
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  const agent = page.getByRole('complementary', { name: 'Agent', exact: true });
  await expect(agent.getByTestId('reasoning')).toHaveCount(2);
  await agent.getByTestId('reasoning').first().getByRole('button').click();
  await expect(agent.getByTestId('reasoning').first()).toContainText('先核对已有基础。');
  await expect(agent.getByRole('table')).toContainText('每周两次');
  await expect(agent.getByRole('button', { name: '带入 IDE', exact: true })).toHaveCount(1);
  const tool = agent.getByTestId('tool-call');
  await tool.getByRole('button').click();
  await expect(tool.locator('pre')).toContainText('根据已有基础继续练习。');
  await tool.screenshot({ path: `.amp/in/artifacts/tool-arguments-dark-${info.project.name}.png`, animations: 'disabled' });
  const composer = await agent.getByLabel('向 Agent 提问', { exact: true }).boundingBox();
  const panel = (await agent.boundingBox())!;
  expect(panel.width).toBe(384);
  expect(composer!.x).toBeGreaterThanOrEqual(panel.x);
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.amp/in/artifacts/ai-reasoning-dark-${info.project.name}.png`, animations: 'disabled' });
});

test('planning shows real phases without counters, idle warnings or skeletons; failure survives reload', async ({ page }, info) => {
  test.setTimeout(45000);
  await page.clock.install();
  const goal = `学习路线 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('PLAN-STREAM-ERROR');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  const tool = page.getByTestId('tool-call');
  await expect(tool.getByText('准备中', { exact: true })).toBeVisible();
  await tool.getByRole('button').click();
  await expect(tool.getByText('add_route_stage', { exact: true })).toBeVisible();
  await expect(tool.locator('pre')).toContainText('工具基础：参数、错误与输出');
  await expect(tool).not.toContainText(/已接收|字符|尚未执行|尚未调用/);
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByText('正在思考…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('生成路线内容', { exact: true })).toBeVisible();
  await expect(page.getByText('生成路线内容', { exact: true }).locator('../..')).toHaveClass(/text-foreground/);
  await expect(page.getByText('校验路线结构', { exact: true }).locator('../..')).toHaveClass(/text-muted-foreground\/50/);
  await expect(tool.getByText('执行中', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/planning-clean-detail-${info.project.name}.png`, animations: 'disabled' });
  const resumed: number[] = [];
  page.on('request', (r) => { if (r.url().includes('/stream?after=')) resumed.push(Number(new URL(r.url()).searchParams.get('after'))); });
  await page.reload();
  await expect(tool.getByText('准备中', { exact: true })).toBeVisible();
  await tool.getByRole('button').click();
  await expect(tool.locator('pre')).toContainText('工具基础：参数、错误与输出');
  await expect.poll(() => resumed.some((cursor) => cursor > 500)).toBe(true);
  await expect(page.getByText('正在思考…', { exact: true })).toHaveCount(0);
  await page.clock.fastForward(31_000);
  await expect(tool.getByText('准备中', { exact: true })).toBeVisible();
  await expect(page.getByTestId('run-inactivity')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/未收到新进度|等待模型继续响应|事件连接中断|正在重连|字符的工具参数/);
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止规划', exact: true })).toBeEnabled();
  await page.screenshot({ path: `.amp/in/artifacts/planning-clean-${info.project.name}.png`, animations: 'disabled' });
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(tool.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByTestId('run-inactivity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试规划', exact: true })).toBeEnabled();
  const failed = await workspace(page, goal);
  expect(failed.route.content).toBeNull();
  expect(failed.requirement.confirmed).toBe(true);
  expect(failed.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible();
  await expect(tool.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('模型响应未正常完成');
  await expect(page.getByRole('alert')).not.toContainText('检查模型服务状态');
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE-');
  await page.screenshot({ path: `.amp/in/artifacts/planning-clean-failed-${info.project.name}.png`, animations: 'disabled' });
});

test('a silent event connection recovers the terminal state by polling every durable event page', async ({ page }, info) => {
  test.setTimeout(45000);
  await page.clock.install();
  const goal = `断线恢复 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('时间安排', { exact: true }).fill('PLAN-STREAM-ERROR');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  // Simulate an intermediary holding SSE open forever, while normal HTTP works.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => String(input).includes('/stream?after=')
      ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': connection opened\n\n'));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
      : original(input, init);
  });
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await expect.poll(async () => (await workspace(page, goal)).runs.find((r: { kind: string }) => r.kind === 'roadmap')?.state, { timeout: 20000 }).toBe('failed');
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toHaveCount(0);
  const cursors: number[] = [];
  page.on('request', (r) => { if (r.url().includes('/events?after=')) cursors.push(Number(new URL(r.url()).searchParams.get('after'))); });
  await page.clock.fastForward(20_001);
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible();
  // The initial session already contains pending/running events. Do not rewind
  // them to zero; each full page must advance its supplied cursor by 500.
  expect(cursors).toHaveLength(2);
  expect([1, 2]).toContain(cursors[0]);
  expect(cursors[1]).toBe(cursors[0]! + 500);
  await expect(page.locator('body')).not.toContainText(/事件连接中断|正在重连/);
  await expect(page.getByTestId('tool-call').getByText('已中断', { exact: true })).toBeVisible();
  await page.getByTestId('reasoning').getByRole('button').click();
  await expect(page.getByTestId('reasoning')).toContainText('核对需求。'.repeat(121));
  const saved = await workspace(page, goal);
  expect(saved.route.content).toBeNull();
  expect(saved.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
});

async function workspace(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token };
    const spaces = await (await fetch('/api/spaces', { headers })).json();
    const id = spaces.find((space: { name: string }) => space.name === name).id;
    return (await fetch(`/api/spaces/${id}`, { headers })).json();
  }, name);
}

test('local proposals require confirmation, recover pending cards and return real execution to their session', async ({ page }, info) => {
  test.setTimeout(60000);
  await create(page, `确认本机操作 ${info.project.name}`);
  await expect(page.locator('dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const ask = async (text: string) => { await page.getByLabel('向 Agent 提问', { exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); };
  const last = page.getByTestId('local-action').last();
  await ask('本机提案文件');
  await expect(last).toContainText('待确认');
  await expect(page.getByRole('treeitem', { name: 'proposal.sh', exact: true })).toHaveCount(0);
  await last.getByText('查看完整修改前后内容', { exact: true }).click();
  await expect(last.locator('pre').last()).toHaveText('printf "CONFIRMED_47\\n"');
  await last.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/action-file-pending-${info.project.name}.png` });
  await page.reload();
  await expect(last).toContainText('待确认');
  await last.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(last).toContainText('已拒绝');
  await expect(page.getByRole('treeitem', { name: 'proposal.sh', exact: true })).toHaveCount(0);
  await ask('本机提案文件');
  await expect(last).toContainText('待确认');
  await last.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(last).toContainText('成功');
  await page.getByRole('treeitem', { name: 'proposal.sh', exact: true }).click();
  await expect(page.getByLabel('编辑 proposal.sh', { exact: true }).filter({ visible: true })).toHaveValue('printf "CONFIRMED_47\\n"\n');
  await ask('本机提案命令');
  await expect(last).toContainText('待确认');
  await page.getByLabel('编辑 proposal.sh', { exact: true }).filter({ visible: true }).fill('new buffer');
  await expect(last.getByRole('button', { name: '确认执行', exact: true })).toBeDisabled();
  await page.getByLabel('编辑 proposal.sh', { exact: true }).filter({ visible: true }).fill('printf "CONFIRMED_47\\n"\n');
  let dropped = false;
  await page.route('**/actions/*', async (route) => {
    if (!dropped && route.request().method() === 'POST') { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await last.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(last).toContainText('成功');
  await expect(last).toContainText('CONFIRMED_47');
  await page.getByRole('treeitem', { name: 'confirmations', exact: true }).click();
  await expect(page.getByLabel('编辑 confirmations', { exact: true }).filter({ visible: true })).toHaveValue('once\n');
  await last.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/action-command-result-${info.project.name}.png` });
  await ask('本机提案等待');
  await expect(last).toContainText('待确认');
  await last.getByRole('button', { name: '确认执行', exact: true }).click();
  await last.getByRole('button', { name: '取消执行', exact: true }).click();
  await expect(last).toContainText('已取消');
  await expect(page.getByRole('treeitem', { name: 'must-not-exist', exact: true })).toHaveCount(0);
});

test('real code assessment shows errors and cancellation, fixes output and keeps newer drafts separate', async ({ page }, info) => {
  test.setTimeout(90000);
  const name = `真实代码测评 ${info.project.name}`;
  await create(page, name);
  await expect(page.locator('dd').filter({ hasText: /^真实代码测评$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始单元测评', exact: true }).click();
  const code = page.getByLabel('编辑 代码答案', { exact: true }), result = page.getByTestId('code-execution');
  await expect(page.getByText(/不是沙箱，拥有服务账号权限/)).toBeVisible();
  await page.getByText('查看执行命令和公开测试', { exact: true }).click();
  await expect(page.getByText("$ node answer.js 'red' 'blue'", { exact: false })).toBeVisible();
  await page.getByLabel('你的回答', { exact: true }).fill('参数由程序的调用者提供');
  await code.fill('syntax error !');
  let dropped = false;
  await page.route('**/units/*/executions', async (route) => {
    if (!dropped && route.request().method() === 'POST') { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(result).toContainText('SyntaxError');
  await expect(result).toContainText('执行失败');
  const stderr = result.locator('pre');
  await expect.poll(() => stderr.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await stderr.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await expect.poll(() => stderr.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  await stderr.evaluate((e) => { e.scrollTop = 0; });
  await page.setViewportSize({ width: 1440, height: 1400 });
  await result.scrollIntoViewIfNeeded();
  await result.screenshot({ path: `.amp/in/artifacts/code-error-${info.project.name}.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await code.fill('while(true) {}');
  let staleListDelivered = false;
  await page.route('**/units/*/executions', async (route) => {
    if (!staleListDelivered && route.request().method() === 'GET') {
      const response = await route.fetch(), list = await response.json();
      if (list.at(-1)?.state === 'running') {
        // Simulate a list captured before this execution and delivered late.
        await route.fulfill({ response, json: list.slice(0, -1) }); staleListDelivered = true; return;
      }
      await route.fulfill({ response }); return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect.poll(() => staleListDelivered).toBe(true);
  await page.waitForTimeout(200); // Allow the stale business refresh to render.
  await expect(result).toContainText('执行中');
  await page.getByRole('button', { name: '停止代码运行', exact: true }).click();
  await expect(result).toContainText('已取消或中断');
  const correct = 'console.log(process.argv.slice(2).length)';
  await code.fill('console.log(2)');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('正在运行并评估固定提交；你可以继续编辑新草稿。', { exact: true })).toBeVisible();
  await code.fill(correct);
  await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
  await expect(page.getByText('再巩固一下会更扎实', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(result).toContainText('用例 2 · succeeded · 退出码 0 · 未匹配');
  await expect(page.getByText('已经掌握', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('console.log(2)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新测评', exact: true }).click();
  await expect(code).toHaveValue(correct);
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('正在运行并评估固定提交；你可以继续编辑新草稿。', { exact: true })).toBeVisible();
  await code.fill('// 第三份新草稿，不属于已提交代码');
  await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
  await expect(page.getByText('你已经掌握了这个单元', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(result).toContainText('用例 1 · succeeded · 退出码 0 · 输出匹配');
  await expect(result).toContainText('用例 2 · succeeded · 退出码 0 · 输出匹配');
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.getByText('你已经掌握了这个单元', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/code-verified-${info.project.name}.png` });
  const saved = await workspace(page, name), unit = saved.route.content.stages[0].units[0].id;
  const evidence = await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await fetch(`/api/spaces/${space}/units/${unit}/executions`, { headers: { 'X-TMC-Token': token } })).json();
  }, { space: saved.id, unit });
  expect(evidence).toHaveLength(4); // Lost-response retry did not rerun the first program.
  expect(evidence.at(-1).code).toBe(correct);
  expect(evidence.at(-1).results.map((r: { result: { stdout: string } }) => r.result.stdout)).toEqual(['2\n', '0\n']);
  await page.getByRole('button', { name: '返回单元', exact: true }).click();
  await page.getByRole('button', { name: '继续测评', exact: true }).click();
  await expect(code).toHaveValue('// 第三份新草稿，不属于已提交代码');
  await expect(page.getByText('以下输出属于较早的固定代码；当前新草稿尚未运行。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(code).toHaveValue('// 第三份新草稿，不属于已提交代码');
  await expect(page.getByText(/不是沙箱，拥有服务账号权限/)).toBeVisible();
});

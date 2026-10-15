import { expect, test, type Page } from '@playwright/test';
import type { AgentContext, AgentDisplayPart, RunEvent, SessionDetail, UnitDetail } from '../../packages/contracts/src/workspace';

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

async function contextShot(page: Page, state: string, project: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Floating placement follows the new height when status text changes.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const popup = (await page.locator('[data-slot="context-content"]').boundingBox())!;
  const trigger = (await page.getByRole('button', { name: '查看上下文用量', exact: true }).boundingBox())!;
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.min(popup.x, trigger.x) - 12), y = Math.max(0, Math.min(popup.y, trigger.y) - 12);
  await page.screenshot({ path: `.amp/in/artifacts/context-${state}-${project}.png`, animations: 'disabled', clip: { x, y,
    width: Math.min(viewport.width, Math.max(popup.x + popup.width, trigger.x + trigger.width) + 12) - x,
    height: Math.min(viewport.height, Math.max(popup.y + popup.height, trigger.y + trigger.height) + 12) - y } });
}

// Browser-only public projection fixtures; the underlying test server is disposable.
async function mockToolRun(page: Page, goal: string, parts: AgentDisplayPart[], live = false, context?: AgentContext) {
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const saved = await workspace(page, goal);
  const runId: string = saved.runs[0].id;
  await page.route(`**/api/spaces/${saved.id}`, async (route) => {
    const response = await route.fetch(), body = await response.json();
    if (live) body.runs = body.runs.map((run: { id: string }) => run.id === runId ? { ...run, state: 'running' } : run);
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/spaces/${saved.id}/sessions/*`, async (route) => {
    const response = await route.fetch(), body = await response.json() as SessionDetail;
    body.messages = body.messages.map((message) => message.id === runId
      ? { ...message, parts, ...(context ? { context } : {}), sequence: 1000, status: live ? 'streaming' : 'done' } : message);
    await route.fulfill({ response, json: body });
  });
  if (live) await page.addInitScript((runId) => {
    const original = window.fetch;
    window.fetch = async (input, init) => String(input).includes(`/runs/${runId}/stream?after=`)
      ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': opened\n\n'));
        window.addEventListener('tool-test-event', (event) => controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify((event as CustomEvent).detail)}\n\n`)));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
      : original(input, init);
  }, runId);
  await page.reload();
  await expect(page.getByTestId('tool-call-group')).toBeVisible();
  return runId;
}

for (const theme of ['light', 'dark'] as const) {
  test(`tool groups bound long interleaved histories and retain failures (${theme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    const parts: AgentDisplayPart[] = [{ type: 'text', id: 'intro', text: '检查公开文件。' }];
    for (let index = 0; index < 20; index++) {
      if (index === 5) parts.push({ type: 'text', id: 'middle', text: '继续检查其他文件。' });
      if (index === 10) parts.push({ type: 'reasoning', id: 'thought', text: '核对调用记录。', status: 'done' });
      parts.push({ type: 'tool', id: `call-${index}`, name: ['ls', 'read', 'grep'][index % 3]!,
        input: { path: `src/file-${index}.ts`, limit: 7 },
        status: index === 3 ? 'error' : index === 7 ? 'interrupted' : index === 19 ? 'running' : 'done' });
    }
    parts.push({ type: 'text', id: 'outcome', text: '公开结果仍显示在工具组外。' });
    await mockToolRun(page, `通用工具分组 ${theme} ${info.project.name}`, parts);
    const group = page.getByTestId('tool-call-group'), toggle = group.getByRole('button', { name: '工具调用', exact: true });
    await expect(group).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toContainText('20 次调用');
    await expect(group).toContainText('17 次成功');
    await expect(group.getByTestId('tool-call-issues')).toContainText('1 次失败 · 1 次中断');
    await expect(page.getByTestId('tool-call-history')).toHaveCount(0);
    await expect(page.getByText('继续检查其他文件。', { exact: true })).toBeVisible();
    await expect(page.getByText('公开结果仍显示在工具组外。', { exact: true })).toBeVisible();
    expect((await group.boundingBox())!.height).toBeLessThan(130);
    await group.screenshot({ path: `.amp/in/artifacts/tool-group-collapsed-${theme}-${info.project.name}.png` });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const history = group.getByTestId('tool-call-history');
    await expect(group.getByTestId('tool-call')).toHaveCount(20);
    expect(await group.getByTestId('tool-call').evaluateAll((els) => els.map((el) => el.getAttribute('data-call-id'))))
      .toEqual(Array.from({ length: 20 }, (_, index) => `call-${index}`));
    expect((await history.boundingBox())!.height).toBeLessThanOrEqual(320);
    expect(await history.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const first = group.getByTestId('tool-call').first();
    await first.getByRole('button').click();
    await expect(first.locator('pre')).toContainText('"path": "src/file-0.ts"');
    await expect(first.locator('pre')).toContainText('"limit": 7');
    await expect(first.getByText('参数', { exact: true })).toHaveCount(0);
    await expect(group.getByText('已返回', { exact: true })).toHaveCount(0);
    await group.screenshot({ path: `.amp/in/artifacts/tool-group-expanded-${theme}-${info.project.name}.png` });
    await history.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(group.getByTestId('tool-call').last().getByText('执行中', { exact: true })).toBeVisible();
    await toggle.click();
    await expect(group.getByTestId('tool-call-issues')).toBeVisible();
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toContainText('20 次调用');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await group.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`tool ticker advances on invocation IDs, not argument updates (${reducedMotion})`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion });
    const runId = await mockToolRun(page, `工具滚动 ${reducedMotion} ${info.project.name} ${info.repeatEachIndex}`, [
      { type: 'tool', id: 'first', name: 'ls', input: {}, status: 'done' },
      { type: 'tool', id: 'second', name: 'read', input: { path: 'src/index.ts' }, status: 'running' },
    ], true);
    const group = page.getByTestId('tool-call-group');
    const ticker = group.getByTestId('tool-call-ticker');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(ticker.locator('code')).toHaveText('read');
    const emit = (seq: number, data: RunEvent['data']) => page.evaluate((event) => {
      window.dispatchEvent(new CustomEvent('tool-test-event', { detail: event }));
    }, { runId, seq, data });
    await emit(1001, { type: 'tool', callId: 'second', name: 'read', phase: 'end' });
    await expect(group).toContainText('2 次成功');
    const frames = await ticker.evaluate(async (el, runId) => {
      const old = el.querySelector('code')!;
      const group = el.closest('[data-testid="tool-call-group"]')!;
      const height = group.getBoundingClientRect().height;
      window.dispatchEvent(new CustomEvent('tool-test-event', { detail: { runId, seq: 1002,
        data: { type: 'tool', callId: 'third', name: 'grep', phase: 'input', inputDelta: '{' } } }));
      const frames = [], start = performance.now();
      while (performance.now() - start < 350) {
        await new Promise(requestAnimationFrame);
        const current = el.querySelector<HTMLElement>('[data-call-id="third"]');
        frames.push({ oldY: old.isConnected ? old.getBoundingClientRect().y - el.getBoundingClientRect().y : null,
          newY: current ? current.getBoundingClientRect().y - el.getBoundingClientRect().y : null,
          height: group.getBoundingClientRect().height - height });
      }
      return frames;
    }, runId);
    expect(frames.every((frame) => Math.abs(frame.height) < 0.5)).toBe(true);
    if (reducedMotion === 'no-preference') {
      expect(frames.some((frame) => frame.oldY !== null && frame.oldY < -1 && frame.newY !== null && frame.newY > 1)).toBe(true);
    } else {
      expect(frames.every((frame) => frame.newY === null || Math.abs(frame.newY) < 0.5)).toBe(true);
    }
    await expect(ticker.locator('[data-call-id="second"]')).toHaveCount(0);
    const current = ticker.locator('[data-call-id="third"]');
    await expect(current).toHaveText('grep');
    await expect(group).toContainText('3 次调用');
    await current.evaluate((el) => el.setAttribute('data-retained', 'yes'));
    await emit(1003, { type: 'tool', callId: 'third', name: 'grep', phase: 'input', inputDelta: '"pattern":"export"}' });
    await emit(1004, { type: 'tool', callId: 'third', name: 'grep', phase: 'start', input: { pattern: 'export' } });
    await expect(group).toContainText('3 次调用');
    await expect(group).toContainText('2 次成功');
    await expect(current).toHaveAttribute('data-retained', 'yes');
    await expect(ticker.locator('[data-call-id="second"]')).toHaveCount(0);
    await group.getByRole('button', { name: '工具调用', exact: true }).click();
    await group.getByTestId('tool-call').first().getByRole('button').click();
    // A repeated tool name is still a new invocation. Open history must stay open.
    await emit(1005, { type: 'tool', callId: 'third', name: 'grep', phase: 'end' });
    await emit(1006, { type: 'tool', callId: 'fourth', name: 'grep', phase: 'start', input: { pattern: 'import' } });
    await expect(group.getByTestId('tool-call')).toHaveCount(4);
    await expect(group.getByTestId('tool-call').first().locator('pre')).toBeVisible();
    await expect(ticker.locator('[data-call-id="fourth"]')).toHaveText('grep');
    await expect(ticker.locator('[data-call-id="third"]')).toHaveCount(0);
    // Replay of an old sequence does not create a duplicate invocation.
    await emit(1006, { type: 'tool', callId: 'duplicate', name: 'read', phase: 'start' });
    await expect(group).toContainText('4 次调用');
    await expect(group.getByTestId('tool-call')).toHaveCount(4);
  });
}

test('formal intake uses streamed API output, editable drafts and explicit confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const opening = `我想做一个命令行工具，有 Python 自动化经验，每周 3 小时，计划 6 周完成。${info.project.name}`;
  await create(page, opening);
  await expect(page.getByText(opening, { exact: true })).toHaveCount(1);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await expect(page.locator('td, dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await expect(page.locator('td, dd').filter({ hasText: opening })).toHaveCount(0);
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
  await expect(page.locator('td, dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
  await expect(page.locator('td, dd').filter({ hasText: /^每周 3 小时，共 6 周$/ })).toBeVisible();
  await expect(page.getByLabel('回复 Agent', { exact: true })).toHaveValue('请求重试时的新草稿');
  await expect(page.getByText('我有 Python 自动化经验，每周 3 小时，6 周做一个命令行工具', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('每周 4 小时');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('td, dd').filter({ hasText: /^每周 4 小时$/ })).toBeVisible();
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
  await expect(page.locator('td, dd').filter({ hasText: /^每周 4 小时$/ })).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/teaching-route-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  const lesson = page.locator('.lesson-prose');
  await expect(lesson.getByRole('alert').filter({ hasText: '本示例尚未在本机执行。' })).toBeVisible();
  await expect(lesson.getByRole('region', { name: '动手试试', exact: true })).toContainText('比较传入零个参数与两个参数时的差异。');
  await expect(lesson.locator('details[open]')).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled();
  await page.getByLabel('你的回答', { exact: true }).fill('固定提交：由程序的调用者传入');
  await page.getByRole('button', { name: '载入起始代码', exact: true }).click();
  await expect(page.getByLabel('编辑 代码答案', { exact: true })).toHaveText('import sys\n', { useInnerText: true });
  await page.getByLabel('编辑 代码答案', { exact: true }).fill('print(2)');
  const submitted = page.waitForRequest((request) => request.method() === 'POST' && /\/units\/[^/]+\/tasks$/.test(request.url())
    && request.postDataJSON().kind === 'evaluation');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  expect((await submitted).postDataJSON().execute).toBe(true);
  await expect(page.getByText('正在运行并评估固定提交；你可以继续编辑新草稿。', { exact: true })).toBeVisible();
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
  await expect(page.getByText('这次还有需要修改的地方', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('有 1 项检查的输出与题目要求不一致。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('固定提交：由程序的调用者传入', { exact: true })).toBeVisible();
  await expect(page.getByText('本次做对的地方', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.screenshot({ path: `.amp/in/artifacts/teaching-code-mismatch-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '重新测评', exact: true }).click();
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue('评估期间的新草稿');
  await expect(page.getByRole('button', { name: '保存答案草稿', exact: true })).toBeDisabled();
  await expect(page.getByText('单元测评 · 第 2 次', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue('评估期间的新草稿');
});

test('long Markdown questions and omitted grading arrays remain usable after save and reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await create(page, `轻量测评验收 ${info.project.name}`);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始单元测评', exact: true }).click();
  await expect(page.getByRole('heading', { name: '长题干验收', exact: true })).toBeVisible();
  await expect(page.getByText('解释空输入的处理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '载入起始代码', exact: true })).toHaveCount(0);
  const readUnit = () => page.evaluate(async () => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const query = new URL(location.href).searchParams;
    return (await fetch(`/api/spaces/${query.get('space')}/units/${query.get('unit')}`, { headers: { 'X-TMC-Token': token } })).json();
  });
  const unit = await readUnit();
  expect(unit.assessment.q1.length).toBeGreaterThan(200);
  expect(unit.assessment.q1).toMatch(/^  ## 长题干验收\n/);
  expect(unit.assessment.starter).toBe(''); expect(unit.assessment.execution).toBeUndefined();
  await page.screenshot({ path: `.amp/in/artifacts/minor-assessment-long-${info.project.name}.png`, animations: 'disabled' });
  await page.getByLabel('你的回答', { exact: true }).fill('由调用者传入。');
  await page.getByLabel('分析题回答', { exact: true }).fill('零个输入和两个输入不同。');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('请补充不同输入下的解释。', { exact: true })).toBeVisible({ timeout: 15000 });
  const record = (await readUnit()).records[0];
  expect(record.result).toBe('needs_work'); expect(record.valid).toBe(true);
  expect(record.verification).toBe('non-execution');
  for (const key of ['mastered', 'concerns', 'evidence', 'toVerify']) expect(record[key]).toEqual([]);
  await page.reload();
  await expect(page.getByText('请补充不同输入下的解释。', { exact: true })).toBeVisible();
  await expect(page.getByText('补充反馈', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/minor-assessment-minimal-result-${info.project.name}.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
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
  await expect(page.locator('td, dd').filter({ hasText: /^Python 自动化经验$/ })).toBeVisible();
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
  await expect(page.getByText('本次测评通过', { exact: true })).toBeVisible({ timeout: 15000 });
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
      value: { rows: [...workspace.requirement.value.rows, { question: '补充计划？', answer: '改变后的计划' }] } }) })).status;
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
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
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

test('unit access follows published courseware and lesson generation reads earlier material on demand', async ({ page }, info) => {
  const goal = `顺序课件 ${info.project.name}`;
  await page.emulateMedia({ colorScheme: 'light' });
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  const initial = await workspace(page, goal), [first, second] = initial.route.content.stages[0].units;
  const row = (title: string) => page.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: title }) });
  const secondRow = row('错误与输出');
  await expect(secondRow.getByRole('button', { name: '未解锁', exact: true })).toBeDisabled();
  await expect(secondRow).toContainText('前序单元的课件全部保存后解锁，无需测评通过');
  const denied = await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const response = await fetch(`/api/spaces/${space}/units/${unit}/tasks`, { method: 'POST',
      headers: { 'X-TMC-Token': token, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ kind: 'lesson', revision: 0 }) });
    return { status: response.status, body: await response.json() };
  }, { space: initial.id, unit: second.id });
  expect(denied.status).toBe(422); expect(denied.body.error).toContain('尚未解锁');
  for (const tab of ['unit', 'assessment', 'result']) {
    await page.goto(`/?space=${initial.id}&unit=${second.id}&tab=${tab}`);
    await expect(page.getByRole('heading', { name: goal, exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '已返回学习路线' })).toBeVisible();
    await expect(secondRow.getByRole('button', { name: '未解锁', exact: true })).toBeDisabled();
  }
  expect((await workspace(page, goal)).tasks).toHaveLength(0);
  // Capture the normal route without the direct-link error banner.
  await page.goto(`/?space=${initial.id}&tab=route`);
  const stage = page.locator('section').filter({ has: page.getByRole('heading', { name: /工具基础/ }) });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await stage.screenshot({ path: `.amp/in/artifacts/unit-order-locked-${theme}-${info.project.name}.png`, animations: 'disabled' });
  }
  await row('参数与输入').getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '学习路线', exact: true }).click();
  await expect(secondRow.getByRole('button', { name: '进入', exact: true })).toBeEnabled();
  const afterFirst = await workspace(page, goal);
  expect(afterFirst.tasks.filter((task: { kind: string }) => task.kind === 'lesson')).toHaveLength(1);
  expect(afterFirst.tasks[0].state).toBe('succeeded');
  expect(afterFirst.sessions.filter((session: { unitId: string }) => session.unitId === second.id)).toHaveLength(0);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveClass(new RegExp(theme));
    await stage.screenshot({ path: `.amp/in/artifacts/unit-order-unlocked-${theme}-${info.project.name}.png`, animations: 'disabled' });
  }
  await secondRow.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.locator('.lesson-prose')).toContainText('承接前一单元介绍的命令行参数');
  const evidence = await page.evaluate(async ({ space, first, second }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token };
    const work = await (await fetch(`/api/spaces/${space}`, { headers })).json();
    const task = work.tasks.find((task: { unitId: string; kind: string }) => task.unitId === second && task.kind === 'lesson');
    return {
      first: await (await fetch(`/api/spaces/${space}/units/${first}`, { headers })).json(),
      events: await (await fetch(`/api/spaces/${space}/runs/${task.id}/events`, { headers })).json(),
    };
  }, { space: initial.id, first: first.id, second: second.id });
  expect(evidence.first.records).toHaveLength(0); expect(evidence.first.assessment).toBeNull();
  expect(evidence.events.run.state).toBe('succeeded');
  const reads = evidence.events.events.filter((event: RunEvent) => event.data.type === 'tool' && event.data.phase === 'end')
    .map((event: RunEvent) => event.data.type === 'tool' ? [event.data.name, event.data.failed] : []);
  expect(reads).toContainEqual(['read_learning_route', false]);
  expect(reads).toContainEqual(['read_reference_lesson', false]);
  await page.reload();
  await expect(page.locator('.lesson-prose')).toContainText('承接前一单元介绍的命令行参数');
});

test('empty requirements are editable and late intake cannot replace saved or unsaved manual edits', async ({ page }, info) => {
  test.setTimeout(45000);
  for (const saveEarly of [false, true]) {
    await create(page, `延迟摘要 ${saveEarly} ${info.project.name}`);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(page.getByText('还没有整理好的需求。可以继续对话，也可以直接添加问题和回答。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '确认，开始规划路线', exact: true })).toBeDisabled();
    if (!saveEarly) await page.screenshot({ path: `.amp/in/artifacts/intake-empty-${info.project.name}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '修改', exact: true }).click();
    await page.getByLabel('问题 1', { exact: true }).fill('想分析什么？');
    await page.getByLabel('回答 1', { exact: true }).fill('手动指定：分析日志文件');
    await page.getByRole('button', { name: '添加问题', exact: true }).click();
    await page.getByLabel('问题 2', { exact: true }).fill('已有经验？');
    await page.getByLabel('回答 2', { exact: true }).fill('只会 SQL');
    if (saveEarly) await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 15000 });
    if (!saveEarly) {
      // The tool's result has refreshed the server revision, but not this local edit.
      await expect(page.getByText('需求草稿已更新，请检查右侧摘要。', { exact: false })).toBeVisible();
      await expect(page.getByLabel('回答 1', { exact: true })).toHaveValue('手动指定：分析日志文件');
      await expect(page.getByLabel('回答 2', { exact: true })).toHaveValue('只会 SQL');
      await page.screenshot({ path: `.amp/in/artifacts/intake-manual-${info.project.name}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: '保存', exact: true }).click();
    } else await expect(page.getByText('回复失败，你的问题已保留', { exact: true })).toBeVisible();
    await expect(page.locator('td, dd').filter({ hasText: /^手动指定：分析日志文件$/ })).toBeVisible();
    await page.reload();
    await expect(page.locator('td, dd').filter({ hasText: /^只会 SQL$/ })).toBeVisible();
  }
});

test('standalone planning survives reload and leaving; only later route adjustments need confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `规划恢复 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('PLAN-SLOW 每周 4 小时');
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
  const toolGroup = page.getByTestId('tool-call-group');
  await expect(toolGroup).toContainText('1 次成功', { timeout: 10000 });
  await expect(toolGroup.getByRole('button', { name: '工具调用', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await toolGroup.getByRole('button', { name: '工具调用', exact: true }).click();
  const routeTool = page.getByTestId('tool-call');
  await expect(routeTool.getByText('成功', { exact: true })).toBeVisible();
  await expect(page.getByText('保存完整路线', { exact: true }).locator('../..')).toHaveClass(/text-foreground/);
  await expect(page.getByText('校验路线结构', { exact: true }).locator('../..')).toHaveClass(/text-muted-foreground(?!\/50)/);
  await routeTool.getByRole('button').click();
  await expect(routeTool.getByText('submit_route', { exact: true })).toBeVisible();
  await expect(routeTool.locator('pre')).toContainText('"stages"');
  await expect(routeTool.locator('pre')).toContainText('"title": "工具基础"');
  await expect(routeTool.locator('pre')).toContainText('"title": "错误与输出"');
  await expect(routeTool.locator('pre')).not.toContainText('"stageId"');
  await expect(toolGroup).toHaveCount(1);
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

test('blank rejection ends a round; feedback rejection survives response loss and preserves the applied baseline and unsent input', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `路线拒绝验收 ${info.project.name}`;
  await page.emulateMedia({ colorScheme: 'light' });
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始学习', exact: true })).toBeVisible();
  const original = await workspace(page, goal);
  const decision = page.getByTestId('route-decision'), preview = page.getByTestId('route-proposal');
  const input = page.getByLabel('向 Agent 提问', { exact: true });
  await page.getByLabel('路线调整想法', { exact: true }).fill('提出补充提案 A');
  await page.getByLabel('路线调整想法', { exact: true }).press('Enter');
  await input.fill('选择后继续写的草稿');
  await expect(preview).toContainText('未接受的补充 A');
  await expect(input).toHaveCount(0);
  await decision.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(decision).toContainText('不会自动生成另一份提案');
  await decision.getByRole('button', { name: '确认拒绝', exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(input).toHaveValue('选择后继续写的草稿');
  const rejected = await workspace(page, goal);
  expect(rejected.route).toEqual(original.route);
  expect(rejected.runs.filter((run: { kind: string }) => run.kind === 'roadmap')).toHaveLength(2);
  expect(rejected.proposals.at(-1).state).toBe('rejected');
  await input.fill('再提出一份补充提案 A');
  await input.press('Enter');
  await input.fill('独立未发送输入');
  await expect(preview).toContainText('未接受的补充 A');
  const aId = await preview.getAttribute('data-proposal-id');
  const feedback = '从原路线细化输入边界，不要增加补充 A';
  await decision.getByRole('button', { name: '拒绝', exact: true }).click();
  await decision.getByLabel('修改意见（选填）').fill(feedback);
  await expect(decision).toContainText('从当前已应用路线重新提出调整');
  await page.screenshot({ path: `.amp/in/artifacts/route-feedback-rejection-${info.project.name}.png`, animations: 'disabled' });
  let dropped = false;
  const keys: string[] = [];
  await page.route(`**/proposals/${aId}/reject`, async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (!dropped) { dropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await decision.getByRole('button', { name: '确认拒绝', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(preview).not.toHaveAttribute('data-proposal-id', aId!);
  await expect(preview).toContainText('参数输入与边界检查');
  await expect(preview).not.toContainText('未接受的补充 A');
  await expect(input).toHaveCount(0);
  const pending = await workspace(page, goal), bId = await preview.getAttribute('data-proposal-id');
  expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1);
  expect(pending.route).toEqual(original.route);
  expect(pending.runs.filter((run: { kind: string }) => run.kind === 'roadmap')).toHaveLength(4);
  expect(pending.proposals.filter((proposal: { state: string }) => proposal.state === 'pending')).toHaveLength(1);
  expect(pending.proposals.find((proposal: { id: string }) => proposal.id === aId).feedback).toBe(feedback);
  expect(pending.proposals.at(-1).content.stages[0].units.map((unit: { id: string }) => unit.id)).toEqual(original.route.content.stages[0].units.map((unit: { id: string }) => unit.id));
  await page.screenshot({ path: `.amp/in/artifacts/route-feedback-revised-${info.project.name}.png`, animations: 'disabled' });

  let release!: () => void, received!: () => void, heldOnce = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const captured = new Promise<void>((resolve) => { received = resolve; });
  await page.route(`**/api/spaces/${original.id}`, async (route) => {
    if (!heldOnce) {
      heldOnce = true; const response = await route.fetch(); received(); await held; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    // Capture pending B, apply it, then deliver that older read last.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await captured;
    await decision.getByRole('button', { name: '确认调整路线', exact: true }).click();
    await expect(decision).toHaveCount(0);
    await expect(input).toHaveValue('独立未发送输入');
    const staleDelivered = page.waitForResponse((response) => response.url().endsWith(`/api/spaces/${original.id}`) && response.ok());
    release(); await staleDelivered;
    // The old snapshot includes the same units, so dependent reads can finish
    // normally. Observe its completed render, not just the successful decision.
    await page.waitForTimeout(500);
    await expect(decision).toHaveCount(0);
    await expect(page.getByRole('main').getByText('参数输入与边界检查', { exact: true }).first()).toBeVisible();
    await expect(input).toHaveValue('独立未发送输入');
    const applied = await workspace(page, goal);
    expect(applied.route.revision).toBe(original.route.revision + 1);
    expect(applied.proposals.find((proposal: { id: string }) => proposal.id === bId).state).toBe('applied');
    expect(applied.tasks).toHaveLength(0);
    await page.screenshot({ path: `.amp/in/artifacts/route-feedback-applied-${info.project.name}.png`, animations: 'disabled' });
  } finally { release(); }
});

test('planning response loss, provider failure and cancellation remain recoverable without repeating confirmation', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `规划错误恢复 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('PLAN-FAIL-ONCE PLAN-SLOW');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认，开始规划路线', exact: true })).toBeEnabled();
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
  // A lost receipt leaves intake visible until the confirmation is known.
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toHaveCount(0);
  await expect(page.getByText('学习需求摘要', { exact: true })).toBeVisible();
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
  expect(sequence).toEqual(['reasoning', 'text', 'tool-call-group', 'reasoning', 'text']);
  await reasoning.first().getByRole('button').click();
  await expect(reasoning.first()).toContainText('先核对已有基础。再区分目标与时间。最后整理需求。');
  await reasoning.last().getByRole('button').click();
  await expect(reasoning.last()).toContainText('工具已返回。核对学习时间与目标。');
  await expect(page.getByTestId('run-content').getByRole('table')).toContainText('每周两次');
  await expect(page.getByText('我会先整理目标。', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '带入 IDE', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '工具调用', exact: true }).click();
  await page.getByRole('button', { name: /submit_requirement_draft.*成功/ }).click();
  await expect(page.getByTestId('tool-call').locator('pre')).toContainText('已有变量基础');
  await expect(page.getByTestId('tool-call').locator('pre')).toContainText('"question": "时间安排？"');
  await expect(page.getByTestId('tool-call').locator('pre')).toContainText('"answer": "每周两次"');
  await expect(page.getByTestId('tool-call').getByText('参数', { exact: true })).toHaveCount(0);
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
  await send(page, '再核对一次学习需求');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const groups = page.getByTestId('tool-call-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByTestId('tool-call-count')).toHaveText('1 次调用');
  await expect(groups.last().getByTestId('tool-call-count')).toHaveText('1 次调用');
  await expect(groups.last().getByRole('button', { name: '工具调用', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '带入 IDE', exact: true }).click();
  await expect(page.getByLabel('编辑 agent_example.py', { exact: true })).toHaveText('print("hello")', { useInnerText: true });
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
  await agent.getByRole('button', { name: '工具调用', exact: true }).click();
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
  await agent.getByRole('button', { name: '查看上下文用量', exact: true }).click();
  const context = page.locator('[data-slot="context-content"]');
  await expect(context).toHaveClass(/dark/);
  await expect(context).toContainText('本次运行消耗 · 含压缩请求');
  await contextShot(page, 'dark', info.project.name);
});

test('planning shows real phases without counters, idle warnings or skeletons; failure survives reload', async ({ page }, info) => {
  test.setTimeout(45000);
  await page.clock.install();
  const goal = `学习路线 ${info.project.name}`;
  await create(page, goal);
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('PLAN-STREAM-ERROR');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  const group = page.getByTestId('tool-call-group');
  await expect(group).toContainText('1 次调用');
  await expect(group).toContainText('0 次成功');
  await group.getByRole('button', { name: '工具调用', exact: true }).click();
  const tool = page.getByTestId('tool-call');
  await expect(tool.getByText('准备中', { exact: true })).toBeVisible();
  await tool.getByRole('button').click();
  await expect(tool.getByText('submit_route', { exact: true })).toBeVisible();
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
  await expect(group).toContainText('1 次调用');
  await group.getByRole('button', { name: '工具调用', exact: true }).click();
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
  await expect(group.getByTestId('tool-call-issues')).toContainText('1 次中断');
  await group.getByRole('button', { name: '工具调用', exact: true }).click();
  await expect(tool.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByTestId('run-inactivity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试规划', exact: true })).toBeEnabled();
  const failed = await workspace(page, goal);
  expect(failed.route.content).toBeNull();
  expect(failed.requirement.confirmed).toBe(true);
  expect(failed.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '路线规划未完成', exact: true })).toBeVisible();
  await expect(group.getByTestId('tool-call-issues')).toContainText('1 次中断');
  await group.getByRole('button', { name: '工具调用', exact: true }).click();
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
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('PLAN-STREAM-ERROR');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  // Keep the client polling timer frozen while the real server finishes the run.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
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
  await expect(page.getByTestId('tool-call-issues')).toContainText('1 次中断');
  await page.getByRole('button', { name: '工具调用', exact: true }).click();
  await expect(page.getByTestId('tool-call').getByText('已中断', { exact: true })).toBeVisible();
  await page.getByTestId('reasoning').getByRole('button').click();
  await expect(page.getByTestId('reasoning')).toContainText('核对需求。'.repeat(121));
  const saved = await workspace(page, goal);
  expect(saved.route.content).toBeNull();
  expect(saved.runs.filter((r: { kind: string }) => r.kind === 'roadmap')).toHaveLength(1);
});

test('lesson review gates all sessions, rejects from the applied baseline and accepts exactly once despite lost and stale responses', async ({ page }, info) => {
  test.setTimeout(60000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const goal = `课件审阅 ${info.project.name}`;
  await page.emulateMedia({ colorScheme: 'light' });
  await create(page, goal);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  const original = await workspace(page, goal), unitId = original.route.content.stages[0].units[0].id;
  const originalUnit = await readUnit(page, original.id, unitId);
  expect(originalUnit.lesson?.revision).toBe(1); expect(original.lessonProposals).toEqual([]);
  await expect(page.getByRole('region', { name: '动手试试', exact: true }).getByText('先观察', { exact: false })).toBeHidden();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const input = page.getByLabel('向 Agent 提问', { exact: true }), decision = page.getByTestId('lesson-decision');
  const preview = page.getByTestId('lesson-proposal-preview');
  await input.fill('课件提案 A：补充说明'); await input.press('Enter');
  await input.fill('独立未发送输入');
  await page.getByRole('region', { name: '动手试试', exact: true }).getByRole('button', { name: '就此提问', exact: true }).click();
  await expect(preview).toContainText('只在课件提案 A 中存在');
  await expect(decision.getByTestId('lesson-review')).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(preview.locator('[data-change="removed"]').filter({ hasText: '命令行参数是启动程序时由调用者提供的字符串。' })).toHaveCount(1);
  await expect(preview.locator('[data-change="added"]').first()).toContainText('读取、验证和错误提示需要分开处理。');
  await expect(preview.getByRole('region', { name: '动手试试', exact: true })).toHaveCount(1);
  await expect(preview.getByText('先观察', { exact: false })).toBeVisible();
  await expect(preview.getByText('零个参数得到空列表，两个参数得到包含两个字符串的列表。', { exact: true })).toBeVisible();
  expect(await preview.getByRole('button', { name: '带入 IDE', exact: true }).evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
  await expect(preview.getByRole('button', { name: /^(正文变化|原课件|提议课件|源码差异|显示空白|复制原源码|复制提议源码)$/ })).toHaveCount(0);
  await expect(preview.getByRole('heading', { name: '参数从哪里来', exact: true })).toHaveCount(1);
  await page.screenshot({ path: `.amp/in/artifacts/lesson-diff-${info.project.name}.png`, animations: 'disabled' });
  const toc = preview.getByTestId('lesson-preview-toc');
  await toc.locator('summary').click();
  await toc.getByRole('link', { name: '+ 补充讲解 A', exact: true }).click();
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(preview.getByRole('heading', { name: '补充讲解 A', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '缺失参数', exact: true })).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(1);
  const diagram = preview.locator('svg').filter({ hasText: 'Validate' });
  await expect(diagram).toBeVisible();
  await diagram.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-rich-${info.project.name}.png`, animations: 'disabled' });
  await preview.getByRole('region', { name: '动手试试', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-exercise-${info.project.name}.png`, animations: 'disabled' });
  await preview.evaluate((element) => { element.scrollTop = 0; });
  await toc.locator('summary').click();
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect(decision.getByTestId('lesson-accept')).toBeInViewport();
  await expect(decision.getByTestId('lesson-reject')).toBeInViewport();
  await preview.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBe(0);
  await page.screenshot({ path: `.amp/in/artifacts/lesson-diff-compact-${info.project.name}.png`, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await decision.getByTestId('lesson-reject').click();
  await expect(decision).toContainText('不会自动生成另一份提案');
  await decision.getByTestId('lesson-reject-confirm').click();
  await expect(decision).toHaveCount(0); await expect(input).toHaveValue('独立未发送输入');
  await expect(page.getByRole('button', { name: '移除引用', exact: true })).toBeVisible();
  expect((await readUnit(page, original.id, unitId)).lesson).toEqual(originalUnit.lesson);
  await page.getByRole('button', { name: '移除引用', exact: true }).click();
  await input.fill('再做课件提案 A'); await input.press('Enter'); await input.fill('第二份独立草稿');
  await expect(preview).toContainText('只在课件提案 A 中存在');
  const aId = await preview.getAttribute('data-proposal-id');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(input).toHaveCount(0); await expect(decision).toHaveAttribute('data-proposal-id', aId!);
  const blocked = await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const headers = { 'X-TMC-Token': token, 'Content-Type': 'application/json' };
    const work = await (await fetch(`/api/spaces/${space}`, { headers })).json();
    const attempts = [
      [`/spaces/${space}/sessions/${work.sessions.find((session: { scope: string }) => session.scope === 'route').id}/runs`, { text: '连续做第二轮提案', quote: null, draftRevision: 0 }],
      [`/spaces/${space}/units/${unit}/tasks`, { kind: 'lesson', revision: 1 }],
    ] as const;
    return Promise.all(attempts.map(async ([path, body]) => {
      const response = await fetch(`/api${path}`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }));
  }, { space: original.id, unit: unitId });
  for (const response of blocked) { expect(response.status).toBe(409); expect(response.body.error).toContain('先接受或拒绝'); }
  await decision.getByTestId('lesson-reject').click();
  const feedback = '从生效课件细化：保留说明，补充三步练习';
  await decision.getByTestId('lesson-rejection-feedback').fill(feedback);
  await page.screenshot({ path: `.amp/in/artifacts/lesson-feedback-${info.project.name}.png`, animations: 'disabled' });
  let rejectionDropped = false;
  await page.route(`**/lesson-proposals/${aId}/reject`, async (route) => {
    if (!rejectionDropped) { rejectionDropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await decision.getByTestId('lesson-reject-confirm').click();
  await expect(page.getByRole('alert')).toBeVisible(); await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(preview).toContainText('分步练习'); await expect(preview).not.toContainText('只在课件提案 A 中存在');
  const bId = await preview.getAttribute('data-proposal-id'), pending = await workspace(page, goal);
  expect(pending.route).toEqual(original.route);
  expect(pending.lessonProposals.filter((proposal: { state: string }) => proposal.state === 'pending')).toHaveLength(1);
  expect(pending.lessonProposals.find((proposal: { id: string }) => proposal.id === aId).feedback).toBe(feedback);
  expect((await readUnit(page, original.id, unitId)).lesson).toEqual(originalUnit.lesson);
  // Rehydrate review in a second tab; do not confuse proposal recovery with
  // persistence of the original tab's deliberately unsaved composer text.
  const restored = await page.context().newPage();
  try {
    await restored.goto(page.url()); await restored.reload();
    await expect(restored.getByTestId('lesson-decision')).toHaveAttribute('data-proposal-id', bId!);
    await expect(restored.getByLabel('向 Agent 提问', { exact: true })).toHaveCount(0);
  } finally { await restored.close(); }
  await expect(decision.getByTestId('lesson-review')).toHaveCount(0);
  await page.getByRole('button', { name: '学习路线', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(decision.getByTestId('lesson-review')).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-review-away-${info.project.name}.png`, animations: 'disabled' });
  const otherUnit = original.route.content.stages[0].units[1];
  await page.locator('li').filter({ has: page.locator('[data-slot="card-title"]').filter({ hasText: otherUnit.title }) })
    .getByRole('button', { name: '进入', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(decision.getByTestId('lesson-review')).toBeVisible();
  await decision.getByTestId('lesson-review').click();
  await expect(preview).toContainText('分步练习');
  await expect(decision.getByTestId('lesson-review')).toHaveCount(0);
  let applyDropped = false;
  const keys: string[] = [];
  await page.route(`**/lesson-proposals/${bId}/apply`, async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (!applyDropped) { applyDropped = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  let release!: () => void, captured!: () => void, heldOnce = false;
  const held = new Promise<void>((resolve) => { release = resolve; }), received = new Promise<void>((resolve) => { captured = resolve; });
  await page.route(`**/api/spaces/${original.id}/units/${unitId}`, async (route) => {
    if (!heldOnce) { heldOnce = true; const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); }
    else await route.continue();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await received;
    await decision.getByTestId('lesson-accept').click();
    await expect(page.getByRole('alert')).toBeVisible();
    // Another read can learn that the lost apply response already committed.
    // Recovering its receipt must not reject this known terminal decision.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(decision).toHaveCount(0); await expect(page.getByRole('heading', { name: '参数与输入：分步练习', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    release(); await page.waitForTimeout(500);
    await expect(decision).toHaveCount(0); await expect(input).toHaveValue('第二份独立草稿');
    const applied = await readUnit(page, original.id, unitId), work = await workspace(page, goal);
    expect(applied.lesson?.revision).toBe(2); expect(applied.lesson?.content).toContain('3. 为缺失参数显示错误提示。');
    expect(applied.lesson?.content).not.toContain('只在课件提案 A 中存在');
    expect(work.route).toEqual(original.route); expect(work.lessonProposals.find((proposal: { id: string }) => proposal.id === bId).state).toBe('applied');
    expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1); expect(errors).toEqual([]);
    await page.screenshot({ path: `.amp/in/artifacts/lesson-applied-${info.project.name}.png`, animations: 'disabled' });
  } finally { release(); }
});

test('lesson review preserves historical passes and answers, permits continuation and reloads voluntary assessment with current sources', async ({ page }, info) => {
  test.setTimeout(60000);
  const goal = `纯推理 课件历史 ${info.project.name}`;
  await create(page, goal);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  const original = await workspace(page, goal), unit = original.route.content.stages[0].units[0].id;
  await page.getByRole('button', { name: '开始单元测评', exact: true }).click();
  await page.getByLabel('你的回答', { exact: true }).fill('参数由调用者在启动时传入。');
  await page.getByLabel('分析题回答', { exact: true }).fill('零个参数得到空列表，两个参数得到两个字符串。');
  await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存答案草稿', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('本次测评通过', { exact: true })).toBeVisible({ timeout: 15000 });
  const passed = await readUnit(page, original.id, unit);
  await page.getByRole('button', { name: '返回单元', exact: true }).click();
  if (!await page.getByLabel('向 Agent 提问', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('从生效课件细化：增加三步练习');
  await page.getByLabel('向 Agent 提问', { exact: true }).press('Enter');
  await page.getByTestId('lesson-accept').click();
  await expect(page.getByTestId('lesson-historical-pass')).toContainText('旧版已通过 / 新版尚未测评');
  const changed = await readUnit(page, original.id, unit);
  expect(changed.lesson?.revision).toBe(2); expect(changed.draft).toEqual(passed.draft);
  expect(changed.records[0]?.valid).toBe(false); expect(changed.historicalPass?.recordId).toBe(passed.records[0]?.id);
  await page.locator('summary').filter({ hasText: /^测评记录/ }).click();
  await page.getByRole('complementary', { name: '单元材料', exact: true }).getByRole('button', { name: /第 1 次/ }).click();
  await expect(page.getByText('旧版已通过 / 新版尚未测评', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^进入下一单元/ })).toBeEnabled();
  await expect(page.getByTestId('assessment-record-source')).toContainText('课件第 1 版 · 测评题第 1 版');
  await page.screenshot({ path: `.amp/in/artifacts/lesson-historical-pass-${info.project.name}.png`, animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('button', { name: /^进入下一单元/ })).toBeEnabled();
  await page.getByRole('button', { name: '自愿测评新版', exact: true }).click();
  await expect(page.getByLabel('你的回答', { exact: true })).toHaveValue(passed.draft.q1);
  await expect(page.getByRole('button', { name: '提交测评', exact: true })).toBeEnabled();
  expect((await readUnit(page, original.id, unit)).assessmentSources).toEqual({ requirement: original.requirement.revision, lesson: 2 });
  await page.reload(); await expect(page.getByRole('button', { name: '提交测评', exact: true })).toBeEnabled();
  await expect(page.getByLabel('分析题回答', { exact: true })).toHaveValue(passed.draft.q2);
  await page.screenshot({ path: `.amp/in/artifacts/lesson-new-assessment-${info.project.name}.png`, animations: 'disabled' });
});

test('lesson review of independent regeneration keeps the applied document readable until explicit acceptance', async ({ page }, info) => {
  const goal = `课件重新生成 ${info.project.name}`;
  await create(page, goal);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  const work = await workspace(page, goal), unit = work.route.content.stages[0].units[0].id;
  const applied = await readUnit(page, work.id, unit);
  const generated = await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    const response = await fetch(`/api/spaces/${space}/units/${unit}/tasks`, { method: 'POST',
      headers: { 'X-TMC-Token': token, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ kind: 'lesson', revision: 1 }) });
    return { status: response.status, task: await response.json() };
  }, { space: work.id, unit });
  expect(generated.status).toBe(200);
  expect(generated.task.unitId).toBe(unit);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const preview = page.getByTestId('lesson-proposal-preview');
  await expect(preview).toContainText('重新整理');
  const proposal = (await workspace(page, goal)).lessonProposals.at(-1);
  expect(proposal.source).toEqual({ kind: 'task', id: generated.task.id });
  expect((await readUnit(page, work.id, unit)).lesson).toEqual(applied.lesson);
  await expect(preview.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await expect(preview.locator('[data-change="unchanged"]').filter({ hasText: '命令行参数是启动程序时由调用者提供的字符串。' })).toHaveCount(1);
  await expect(preview.locator('[data-change="added"]').filter({ hasText: '本次重新生成将作为课件提案' })).toHaveCount(1);
  await page.getByTestId('lesson-accept').click();
  await expect(page.getByTestId('lesson-decision')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `${applied.lesson!.title}（重新生成）`, exact: true })).toBeVisible();
  expect((await readUnit(page, work.id, unit)).lesson?.revision).toBe(2);
  expect((await workspace(page, goal)).route).toEqual(work.route);
});

test('lesson review exposes link and whitespace changes inline without a source view and applies exact candidate bytes', async ({ page }, info) => {
  const goal = `课件隐性变化 ${info.project.name}`;
  await create(page, goal);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const input = page.getByLabel('向 Agent 提问', { exact: true }), preview = page.getByTestId('lesson-proposal-preview');
  await input.fill('课件引用基线'); await input.press('Enter');
  await expect(preview).toContainText('末段保持不变。');
  await page.getByTestId('lesson-accept').click();
  await expect(page.getByTestId('lesson-decision')).toHaveCount(0);
  const original = await workspace(page, goal), unit = original.route.content.stages[0].units[0].id;
  const before = await readUnit(page, original.id, unit);
  expect(before.lesson?.revision).toBe(2);
  await input.fill('课件隐性改动'); await input.press('Enter');
  const notes = preview.getByTestId('lesson-change-note');
  await expect(notes.filter({ hasText: 'https://docs.example.org/args/v1' })).toHaveCount(1);
  await expect(notes.filter({ hasText: 'https://docs.example.org/args/v2' })).toHaveCount(1);
  await expect(notes.filter({ hasText: 'Markdown / 空白调整' }).filter({ hasText: '**保留正文**' })).toHaveCount(1);
  await expect(notes.filter({ hasText: 'Markdown / 空白调整' }).filter({ hasText: '__保留正文__' })).toHaveCount(1);
  const spacing = notes.filter({ hasText: '段后空白' });
  await expect(spacing).toHaveCount(2);
  const finalLine = spacing.filter({ hasText: '␍↵' });
  await expect(finalLine).toHaveCount(1);
  await expect(preview.getByRole('heading', { name: '资料与格式', exact: true })).toHaveCount(1);
  await expect(preview.getByRole('button', { name: /^(正文变化|原课件|提议课件|源码差异)$/ })).toHaveCount(0);
  const proposal = (await workspace(page, goal)).lessonProposals.at(-1);
  expect(proposal.content.content).toContain('末段保持不变。\r\n');
  expect((await readUnit(page, original.id, unit)).lesson).toEqual(before.lesson);
  await notes.filter({ hasText: 'https://docs.example.org/args/v1' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-inline-details-${info.project.name}.png`, animations: 'disabled' });
  await finalLine.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-inline-format-${info.project.name}.png`, animations: 'disabled' });
  await expect(page.getByTestId('lesson-accept')).toBeInViewport();
  await page.getByTestId('lesson-accept').click();
  await expect(page.getByTestId('lesson-decision')).toHaveCount(0);
  const applied = await readUnit(page, original.id, unit);
  expect(applied.lesson?.content).toBe(proposal.content.content);
  expect(applied.lesson?.revision).toBe(3);
});

test('lesson review of title-only edits remains actionable in a readonly fullscreen IDE drawer', async ({ page }, info) => {
  const goal = `课件标题审阅 ${info.project.name}`;
  await page.emulateMedia({ colorScheme: 'dark' });
  await create(page, goal);
  await page.getByRole('button', { name: '确认，开始规划路线', exact: true }).click();
  await page.getByRole('button', { name: '开始学习', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参数从哪里来', exact: true })).toBeVisible();
  const original = await workspace(page, goal), unit = original.route.content.stages[0].units[0].id;
  const before = await readUnit(page, original.id, unit);
  await page.getByRole('button', { name: '带入 IDE', exact: true }).click();
  const editor = page.getByLabel('编辑 args.py', { exact: true }).filter({ visible: true });
  await editor.fill('UNSAVED_BUFFER = 17\n');
  await page.getByRole('button', { name: '全屏 IDE', exact: true }).click();
  if (!await page.getByLabel('向 Agent 提问', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('只改课件标题');
  await page.getByLabel('向 Agent 提问', { exact: true }).press('Enter');
  await expect(page.getByTestId('lesson-review')).toBeVisible();
  await expect(page.getByTestId('lesson-proposal-preview').filter({ visible: true })).toHaveCount(0);
  await page.screenshot({ path: `.amp/in/artifacts/lesson-review-ide-closed-${info.project.name}.png`, animations: 'disabled' });
  await page.getByTestId('lesson-review').click();
  const preview = page.getByTestId('lesson-proposal-preview').filter({ visible: true });
  await expect(preview).toHaveAttribute('data-location', 'drawer');
  await expect(page.getByTestId('lesson-review')).toHaveCount(0);
  await expect(preview.getByTestId('lesson-title-before')).toHaveText(before.lesson!.title);
  await expect(preview.getByTestId('lesson-title-after')).toHaveText('参数与输入：边界详解');
  expect((await workspace(page, goal)).lessonProposals.at(-1).content.content).toBe(before.lesson!.content);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId('lesson-review')).toBeVisible();
  await expect(editor).toHaveText('UNSAVED_BUFFER = 17\n', { useInnerText: true });
  await page.getByTestId('lesson-review').click();
  await expect(preview).toHaveAttribute('data-location', 'drawer');
  await expect(page.getByTestId('lesson-review')).toHaveCount(0);
  await expect(page.getByTestId('lesson-accept')).toBeVisible();
  await page.screenshot({ path: `.amp/in/artifacts/lesson-ide-title-${info.project.name}.png`, animations: 'disabled' });
  await page.getByTestId('lesson-accept').click();
  await expect(page.getByTestId('lesson-decision')).toHaveCount(0);
  await expect(editor).toHaveText('UNSAVED_BUFFER = 17\n', { useInnerText: true });
  expect((await readUnit(page, original.id, unit)).lesson?.title).toBe('参数与输入：边界详解');
});

async function readUnit(page: Page, space: string, unit: string): Promise<UnitDetail> {
  return page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await fetch(`/api/spaces/${space}/units/${unit}`, { headers: { 'X-TMC-Token': token } })).json();
  }, { space, unit });
}

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
  await expect(page.locator('td, dd').filter({ hasText: /^制作命令行工具$/ })).toBeVisible();
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
  await expect(page.getByLabel('编辑 proposal.sh', { exact: true }).filter({ visible: true })).toHaveText('printf "CONFIRMED_47\\n"\n', { useInnerText: true });
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
  await expect(page.getByLabel('编辑 confirmations', { exact: true }).filter({ visible: true })).toHaveText('once\n', { useInnerText: true });
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
  await expect(page.locator('td, dd').filter({ hasText: /^真实代码测评$/ })).toBeVisible();
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
  await expect(result).toContainText('程序报错，尚未完成这道题的运行检查。');
  await expect(result.locator('pre:visible')).toHaveCount(0);
  await result.getByText('运行详情（命令与完整输出）', { exact: true }).click();
  await expect(result.getByLabel('本次运行的固定代码', { exact: true })).toHaveText('syntax error !');
  const stderr = result.locator('pre').filter({ hasText: 'SyntaxError' }).first();
  await expect(stderr).toContainText('SyntaxError');
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
  await expect(result).toContainText('正在检查代码');
  await expect(result.locator('details')).not.toHaveAttribute('open');
  await page.getByRole('button', { name: '停止代码运行', exact: true }).click();
  await expect(result).toContainText('本次运行已停止，代码检查未完成。');
  await expect(result).toContainText('不会自动重跑');
  await result.screenshot({ path: `.amp/in/artifacts/feedback-cancel-${info.project.name}.png` });
  const correct = 'console.log(process.argv.slice(2).length)';
  await code.fill('process.stdout.write("2 ")');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(result.locator('li').first()).toContainText('题目要求输出：2');
  await expect(result.locator('li').first()).toContainText('实际输出："2 "');
  await expect(result.locator('pre').first()).toBeHidden();
  await code.fill('console.log(2)');
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('正在运行并评估固定提交；你可以继续编辑新草稿。', { exact: true })).toBeVisible();
  await code.fill(correct);
  await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
  await expect(page.getByText('这次还有需要修改的地方', { exact: true })).toBeVisible({ timeout: 15000 });
  const noArgs = result.locator('li').filter({ hasText: '不传入参数' });
  await expect(noArgs).toContainText('题目要求输出：0');
  await expect(noArgs).toContainText('实际输出：2');
  await expect(result.locator('pre').first()).toBeHidden();
  await expect(page.getByText('本次做对的地方', { exact: true })).toHaveCount(0);
  await expect(page.getByText('本次提交符合题目要求。', { exact: true })).toHaveCount(0);
  expect(await page.getByRole('main').innerText()).not.toMatch(/SHA-256|执行 ID|succeeded|退出码/);
  await page.getByRole('button', { name: '查看我的回答', exact: true }).click();
  await expect(page.getByText('console.log(2)', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: '重新测评', exact: true }).click();
  await expect(code).toHaveText(correct, { useInnerText: true });
  await page.getByRole('button', { name: '提交测评', exact: true }).click();
  await expect(page.getByText('正在运行并评估固定提交；你可以继续编辑新草稿。', { exact: true })).toBeVisible();
  await code.fill('// 第三份新草稿，不属于已提交代码');
  await page.getByRole('button', { name: '保存答案草稿', exact: true }).click();
  await expect(page.getByText('本次测评通过', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(result).toContainText('2 项运行检查');
  await expect(result.locator('li').first()).toContainText('输出：2，符合题目要求。');
  await expect(result.locator('li').last()).toContainText('输出：0，符合题目要求。');
  await expect(page.getByText('下一步怎么改', { exact: true })).toHaveCount(0);
  await expect(page.getByText('本次未覆盖', { exact: true })).toHaveCount(0);
  expect(await page.getByRole('main').innerText()).not.toMatch(/SHA-256|执行 ID|succeeded|退出码|还需验证边界输入/);
  await result.getByText('运行详情（命令与完整输出）', { exact: true }).click();
  await expect(result.getByLabel('本次运行的固定代码', { exact: true })).toHaveText(correct);
  await expect(result.locator('pre').filter({ hasText: "$ node answer.js 'red' 'blue'" })).toContainText('标准输出：\n2\n');
  await result.getByText('运行详情（命令与完整输出）', { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.getByText('本次测评通过', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.amp/in/artifacts/code-verified-${info.project.name}.png` });
  const saved = await workspace(page, name), unit = saved.route.content.stages[0].units[0].id;
  const evidence = await page.evaluate(async ({ space, unit }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await fetch(`/api/spaces/${space}/units/${unit}/executions`, { headers: { 'X-TMC-Token': token } })).json();
  }, { space: saved.id, unit });
  expect(evidence).toHaveLength(5); // Lost-response retry did not rerun the first program.
  expect(evidence.at(-1).code).toBe(correct);
  expect(evidence.at(-1).results.map((r: { result: { stdout: string } }) => r.result.stdout)).toEqual(['2\n', '0\n']);
  await page.getByRole('button', { name: '返回单元', exact: true }).click();
  await page.getByRole('button', { name: '继续测评', exact: true }).click();
  await expect(code).toHaveText('// 第三份新草稿，不属于已提交代码', { useInnerText: true });
  await expect(page.getByText('以下输出属于较早的固定代码；当前新草稿尚未运行。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(code).toHaveText('// 第三份新草稿，不属于已提交代码', { useInnerText: true });
  await expect(page.getByText(/不是沙箱，拥有服务账号权限/)).toBeVisible();
});

test('context usage hydrates, updates through SSE and resists stale refreshes without treating unknown as zero', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const context: AgentContext = { modelId: 'context-fixture', provider: 'synthetic', contextWindow: 65_536, tokens: 32_768, phase: 'ready',
    usage: { input: 12_345, output: 567, cacheRead: 89, cacheWrite: 10, cost: 0.0234 } };
  const runId = await mockToolRun(page, `上下文显示验收 ${info.project.name}`,
    [{ type: 'tool', id: 'context-tool', name: 'read', status: 'done' }], true, context);
  const trigger = page.getByRole('button', { name: '查看上下文用量', exact: true });
  const popup = page.locator('[data-slot="context-content"]');
  const emit = (seq: number, next: AgentContext) => page.evaluate((event) => {
    window.dispatchEvent(new CustomEvent('tool-test-event', { detail: event }));
  }, { runId, seq, data: { type: 'context', context: next } });
  await expect(trigger).toContainText('50%');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(popup).toContainText('32.8K / 65.5K');
  await expect(popup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await expect(popup.getByText('输入（不含缓存）', { exact: true }).locator('..')).toContainText('12.3K');
  await expect(popup.getByText('输出', { exact: true }).locator('..')).toContainText('567');
  await expect(popup.getByText('缓存读取', { exact: true }).locator('..')).toContainText('89');
  await expect(popup.getByText('缓存写入', { exact: true }).locator('..')).toContainText('10');
  await expect(popup).not.toContainText(/费用|\$/);
  await contextShot(page, 'default', info.project.name);
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.hover(); await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(popup).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await contextShot(page, 'narrow', info.project.name);
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await trigger.click();
  await emit(1001, { ...context, phase: 'compacting' });
  await expect(trigger).toContainText('压缩中');
  await expect(popup).toContainText('正在压缩上下文…');
  await emit(1002, { ...context, tokens: null, phase: 'compacted' });
  await expect(trigger).toContainText('上下文 —');
  await expect(popup).toContainText('待估算');
  await expect(popup.getByRole('progressbar')).toHaveCount(0);
  // Saving requirements triggers a full refresh with the older snapshot at 1000.
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await page.getByLabel('回答 4', { exact: true }).fill('刷新不应覆盖新的上下文事件');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改', exact: true })).toBeEnabled();
  await expect(trigger).toContainText('上下文 —');
  await trigger.click();
  await expect(popup).toContainText('已自动压缩，下一次模型响应后更新占用。');
  await emit(1001, { ...context, phase: 'failed' });
  await expect(popup).not.toContainText('本次压缩未完成');
  await emit(1003, { ...context, tokens: 78_644 });
  await expect(trigger).toContainText('120%');
  await expect(popup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await emit(1004, { ...context, phase: 'failed' });
  await expect(popup).toContainText('本次压缩未完成；原始上下文仍保留。');
  await contextShot(page, 'failed', info.project.name);
  await emit(1005, { ...context, phase: 'interrupted' });
  await expect(popup).toContainText('压缩已中断；原始上下文仍保留。');
  await contextShot(page, 'interrupted', info.project.name);
});

test('native automatic compaction streams its status, hydrates after reload and continues from the saved summary', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const goal = `自动压缩验收 ${info.project.name}`;
  await create(page, goal);
  const trigger = page.getByRole('button', { name: '查看上下文用量', exact: true });
  const popup = page.locator('[data-slot="context-content"]');
  await expect(trigger).toContainText('压缩中');
  await trigger.click();
  await expect(popup).toContainText('正在压缩上下文…');
  await contextShot(page, 'compacting', info.project.name);
  await expect(popup).toContainText('已自动压缩，下一次模型响应后更新占用。', { timeout: 10000 });
  await expect(popup).toContainText('待估算');
  await expect(popup.getByRole('progressbar')).toHaveCount(0);
  await contextShot(page, 'compacted', info.project.name);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  const before = await workspace(page, goal), runId = before.runs[0].id;
  const snapshot = await page.evaluate(async ({ space, run }) => {
    const { token } = await (await fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } })).json();
    return (await fetch(`/api/spaces/${space}/runs/${run}`, { headers: { 'X-TMC-Token': token } })).json();
  }, { space: before.id, run: runId });
  expect(snapshot.state).toBe('succeeded'); expect(snapshot.context.tokens).toBeNull();
  expect(snapshot.context.compaction.reason).toBe('threshold');
  expect(snapshot.context.usage.input).toBeGreaterThan(snapshot.context.contextWindow - 16_384);
  expect(snapshot.context.usage.cost).toBeGreaterThan(0.0123);
  await page.reload();
  await expect(trigger).toContainText('上下文 —');
  await trigger.click();
  await expect(popup).toContainText('已自动压缩，下一次模型响应后更新占用。');
  expect(await page.locator('body').innerText()).not.toContain('BROWSER-COMPACTION-CHECKPOINT');
  await page.keyboard.press('Escape');
  await send(page, '压缩后继续核对练习');
  await expect(page.getByText('压缩后的对话已继续。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await trigger.click();
  await expect(popup).not.toContainText('待估算');
  await expect(popup.getByRole('progressbar')).toHaveCount(1);
  const after = await workspace(page, goal);
  expect(after.runs).toHaveLength(2); expect(after.runs.every((run: { state: string }) => run.state === 'succeeded')).toBe(true);
});

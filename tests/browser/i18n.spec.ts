import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { TeachingRuntime } from '../../apps/server/src/agents/runtime';
import { reply, response, syntheticSource } from '../../apps/server/src/agents/test-support';
import { Actions } from '../../apps/server/src/modules/actions';
import { Assessments } from '../../apps/server/src/modules/assessments';
import { Executions } from '../../apps/server/src/modules/executions';
import { Learning } from '../../apps/server/src/modules/learning';
import { Projects } from '../../apps/server/src/modules/projects';
import { openDatabase } from '../../apps/server/src/storage/database';
import { seedWorkspaces } from '../seed-workspaces';

test.use({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });
const seed = (info: TestInfo) => JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: `.amp/in/artifacts/i18n-${name}-${info.project.name}.png`, animations: 'disabled' });
async function chooseLanguage(page: Page, name: string) {
  await page.getByLabel(/^(Language|语言)$/).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function settings(page: Page) {
  await page.getByRole('button', { name: /^(Application settings|应用设置)$/, exact: true }).click();
}

test('first render follows supported browser locales and tolerates inaccessible local storage', async ({ browser, baseURL }) => {
  for (const [locale, expected] of [['en-GB', 'en'], ['zh-SG', 'zh-CN'], ['zh-TW', 'en'], ['fr-FR', 'en']]) {
    const context = await browser.newContext({ baseURL, locale });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', expected!);
      await expect(page.getByRole('heading', { name: expected === 'en' ? 'What would you like to learn today?' : '今天你想学习什么?' })).toBeVisible();
    } finally { await context.close(); }
  }
  const context = await browser.newContext({ baseURL, locale: 'en-US' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    await page.goto('/');
    await settings(page);
    await chooseLanguage(page, '简体中文');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('heading', { name: '今天你想学习什么?' })).toBeVisible();
  } finally { await context.close(); }
});

test('language preference persists, synchronizes tabs, follows browser changes only in system mode and keeps home drafts', async ({ page, context }, info) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'What would you like to learn?', exact: true });
  await input.fill('原始学习目标 · keep my draft');
  await shot(page, info, 'home-en');
  const other = await context.newPage();
  await other.goto('/');
  await settings(page);
  await chooseLanguage(page, '简体中文');
  await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page).toHaveTitle('TeachMeCoding · Agent 伴学编程');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '你想学什么', exact: true })).toHaveValue('原始学习目标 · keep my draft');
  await shot(page, info, 'home-zh');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await settings(page);
  await chooseLanguage(page, '跟随浏览器');
  await expect(other.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.evaluate(() => localStorage.getItem('tmc-language'))).toBeNull();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['de', 'zh-Hans'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await chooseLanguage(page, 'English');
  await expect(other.locator('html')).toHaveAttribute('lang', 'en');
  await other.close();
});

test('switching translates a current error without remounting editor, drafts or PTY and preserves saved learning content', async ({ page }, info) => {
  const data = seedWorkspaces(seed(info).root, { learning: '多语言验收 Rust', other: '多语言验收 Python' });
  const sockets: string[] = [], errors: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?space=${data.spaceId}&tab=unit&unit=${data.unitIds[0]}`);
  await expect(page.getByRole('heading', { name: '所有权与借用', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'IDE and terminal', exact: true }).click();
  await page.getByRole('treeitem', { name: 'src', exact: true }).press('ArrowRight');
  await page.getByRole('treeitem', { name: 'main.rs', exact: true }).click();
  const terminal = page.getByRole('textbox', { name: 'Local terminal input', exact: true });
  const restart = page.getByRole('button', { name: 'New terminal', exact: true });
  if (await restart.isVisible()) { await restart.click(); await expect(restart).toHaveCount(0); }
  await terminal.pressSequentially('export TMC_I18N=kept; printf "I18N_READY\\n"');
  await terminal.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('I18N_READY');
  const originalTerminal = await terminal.elementHandle();
  const editor = page.getByRole('textbox', { name: 'Edit main.rs', exact: true });
  const originalEditor = await editor.elementHandle();
  const draft = page.getByRole('textbox', { name: 'Ask Agent', exact: true });
  await draft.fill('保留的提问草稿 · unsent');
  await page.route('**/project/save', (route) => route.fulfill({ status: 422, json: { error: '原始安全错误', code: 'PROJECT_TEXT_REQUIRED' } }));
  await editor.fill('// 原始代码 · unsaved after failure');
  await expect(page.getByRole('alert').filter({ hasText: 'The file must be UTF-8 text no larger than 1 MB.' })).toBeVisible();
  const connectionCount = sockets.length;
  await settings(page);
  await chooseLanguage(page, '简体中文');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '向 Agent 提问', exact: true })).toHaveValue('保留的提问草稿 · unsent');
  await expect(page.getByRole('textbox', { name: '编辑 main.rs', exact: true })).toHaveText('// 原始代码 · unsaved after failure', { useInnerText: true });
  const saveError = page.getByRole('alert').filter({ hasText: '自动保存 src/main.rs 失败：文件必须为不超过 1 MB 的 UTF-8 文本。' });
  await expect(saveError).toBeVisible();
  expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await originalTerminal!.evaluate((element) => element.isConnected)).toBe(true);
  expect(sockets.length).toBe(connectionCount);
  await shot(page, info, 'workbench-error-zh');
  await page.unroute('**/project/save');
  await page.getByRole('button', { name: '重试', exact: true }).first().click();
  await expect(saveError).toHaveCount(0);
  await settings(page);
  await chooseLanguage(page, 'English');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Application settings', exact: true })).toBeFocused();
  await terminal.pressSequentially('printf "I18N_%s\\n" "$TMC_I18N"'); await terminal.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('I18N_kept');
  await shot(page, info, 'workbench-en');
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await page.goto(`/?space=${data.spaceId}&tab=result&unit=${data.unitIds[0]}&record=${data.recordId}`);
  await expect(page.getByText('验收记录：需要更多证据', { exact: true })).toBeVisible();
  await expect(page.getByText('历史解释', { exact: true })).toBeHidden();
  await page.getByText('View my answers', { exact: true }).click();
  await expect(page.getByText('历史解释', { exact: true })).toBeVisible();
  await shot(page, info, 'result-en');
  expect(errors).toEqual([]);
});

test('English settings and library fit a narrow screen with an accessible language picker', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await settings(page);
  const panel = page.getByRole('region', { name: 'Application settings', exact: true });
  await expect(page.getByLabel('Language', { exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await shot(page, info, 'settings-mobile-en');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await chooseLanguage(page, 'English');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  expect(await page.getByRole('region', { name: 'Library', exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await shot(page, info, 'library-mobile-en');
});

test('MCP connection failures follow the current language, including reload', async ({ page }, info) => {
  await page.goto('/');
  await settings(page);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'Add MCP Server', exact: true }).click();
  await page.getByLabel('Server name', { exact: true }).fill(`missing-${info.project.name}`);
  await page.getByLabel('Launch command', { exact: true }).fill('/tmc-i18n-no-such-executable');
  await page.getByRole('button', { name: 'Add server', exact: true }).click();
  const server = page.getByRole('listitem', { name: `missing-${info.project.name}`, exact: true });
  await expect(server).toContainText('Connection failed');
  await shot(page, info, 'mcp-error-en');
  await expect(server.getByRole('alert')).toHaveText('Unable to connect. Check the command, address, and authentication settings.');
  await chooseLanguage(page, '简体中文');
  await expect(server.getByRole('alert')).toHaveText('无法连接，请检查命令、地址和认证配置。');
  await shot(page, info, 'mcp-error-zh');
  await chooseLanguage(page, 'English');
  await page.reload();
  await settings(page);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(server.getByRole('alert')).toHaveText('Unable to connect. Check the command, address, and authentication settings.');
  await server.getByRole('button', { name: `Configure missing-${info.project.name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete server', exact: true }).click();
  await expect(server).toHaveCount(0);
});

test('preview terminal diagnostics and existing quotes retranslate without changing source text', async ({ page, context }, info) => {
  await page.goto('/preview?scene=unit');
  await page.getByRole('button', { name: 'IDE and terminal', exact: true }).click();
  const command = page.getByRole('textbox', { name: 'Terminal command', exact: true });
  await command.fill('cd /missing-i18n'); await command.press('Enter');
  const terminal = page.getByRole('log', { name: /^(Terminal output|终端输出)$/, exact: true });
  await shot(page, info, 'preview-error-en');
  await expect(terminal).toContainText('Directory not found: /missing-i18n');
  await command.fill('help'); await command.press('Enter');
  await expect(terminal).toContainText('Simulated terminal:');
  await page.getByRole('button', { name: 'Quote terminal output', exact: true }).click();
  const composer = page.getByRole('complementary', { name: 'Agent', exact: true }).locator('form');
  await expect(composer).toContainText('Terminal output');
  const quoted = await composer.locator('p').innerText();
  // The isolated preview has no settings capability. A real settings tab updates
  // the shared preference without reloading its in-memory terminal or quote.
  const preferences = await context.newPage();
  await preferences.goto('/'); await settings(preferences);
  await chooseLanguage(preferences, '简体中文');
  await expect(terminal).toContainText('目录不存在：/missing-i18n');
  await expect(composer).toContainText('终端输出');
  expect(await composer.locator('p').innerText()).toBe(quoted);
  await chooseLanguage(preferences, 'English');
  await expect(terminal).toContainText('Directory not found: /missing-i18n');
  await expect(composer).toContainText('Terminal output');
  await shot(page, info, 'preview-notices-en');
  await preferences.close();
});

test('persisted run failures, action receipts and default titles retranslate without changing content or rerunning commands', async ({ page }, info) => {
  const data = seedWorkspaces(seed(info).root, { learning: '持久提示验收', other: '原文对照' });
  const db = openDatabase(join(data.root, 'app.db')), learning = new Learning(db), projects = new Projects(data.root);
  const actions = new Actions(learning, projects);
  let truncated = false;
  const runtime = new TeachingRuntime(learning, syntheticSource, { actions, projectDirectory: (space) => projects.root(space),
    stream: () => response(reply([{ type: 'text', text: '模型原文：中文内容保持不变。' }], truncated ? 'length' : 'stop')) });
  try {
    const session = learning.createSession(data.spaceId, { scope: 'unit', unitId: data.unitIds[0] });
    const first = runtime.submit(data.spaceId, session.id, randomUUID(), { text: '用户原文', quote: null, draftRevision: 0 });
    await runtime.idle(first.run.id);
    expect(runtime.get(data.spaceId, first.run.id).state).toBe('succeeded');
    for (const [kind, input] of [
      ['file', { path: 'src/i18n.txt', content: '文件原文', reason: '保存原文' }],
      ['command', { command: "printf '中文程序输出\\n'; printf 'once\\n' >> i18n-count.txt; exit 7", reason: '验证失败输出原样保留' }],
    ] as const) {
      const proposal = actions.prepare(data.spaceId, session.id, first.run.id, kind, input);
      actions.save(data.spaceId, proposal);
      actions.decide(data.spaceId, proposal.id, { digest: proposal.digest, decision: 'confirm' });
      await actions.idle(proposal.id);
    }
    truncated = true;
    const last = runtime.submit(data.spaceId, session.id, randomUUID(), { text: '检查截断', quote: null, draftRevision: learning.session(data.spaceId, session.id).draft.revision });
    await runtime.idle(last.run.id);
    expect(runtime.get(data.spaceId, last.run.id).error).toEqual({ code: 'MODEL_OUTPUT_TRUNCATED' });
    await runtime.close();
    const messages = learning.session(data.spaceId, session.id).messages;
    const proposals = actions.list(data.spaceId, session.id);

    await page.goto(`/?space=${data.spaceId}&tab=unit&unit=${data.unitIds[0]}`);
    await page.getByRole('button', { name: 'Switch conversation', exact: true }).click();
    await page.getByRole('menuitem').filter({ hasText: 'New conversation' }).first().click();
    const agent = page.getByRole('complementary', { name: 'Agent', exact: true });
    const failure = agent.getByRole('alert').filter({ hasText: /The model output was truncated|模型输出被截断/ });
    await expect(agent).toContainText('File change completed: src/i18n.txt.');
    await expect(agent).toContainText('Command execution failed. Exit code 7.');
    await expect(agent).toContainText('中文程序输出');
    await expect(agent).toContainText('模型原文：中文内容保持不变。');
    await expect(failure).toContainText('The model output was truncated. Generated artifacts were not saved.');
    await shot(page, info, 'persisted-notices-en');
    await settings(page); await chooseLanguage(page, '简体中文');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('button', { name: '切换会话', exact: true })).toContainText('新会话');
    await expect(agent).toContainText('文件修改已完成：src/i18n.txt。');
    await expect(failure).toContainText('模型输出被截断，未保存生成产物。');
    await shot(page, info, 'persisted-notices-zh');
    await settings(page); await chooseLanguage(page, 'English');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Switch conversation', exact: true })).toContainText('New conversation');
    await expect(agent).toContainText('Command execution failed. Exit code 7.');
    await expect(failure).toContainText('The model output was truncated. Generated artifacts were not saved.');
    expect(learning.session(data.spaceId, session.id).messages).toEqual(messages);
    expect(actions.list(data.spaceId, session.id)).toEqual(proposals);
    expect(projects.read(data.spaceId, 'i18n-count.txt').content).toBe('once\n');
    expect(projects.read(data.spaceId, 'src/i18n.txt').content).toBe('文件原文');
  } finally { await runtime.close(); await actions.close(); db.close(); }
});

test('assessment history localizes host summaries while preserving authored feedback and real execution output', async ({ page }, info) => {
  const data = seedWorkspaces(seed(info).root, { learning: '测评摘要验收', other: '记录对照' });
  const db = openDatabase(join(data.root, 'app.db')), learning = new Learning(db), assessments = new Assessments(learning), executions = new Executions(learning);
  try {
    const codeUnit = data.unitIds[0]!, reasoningUnit = data.unitIds[1]!;
    const records: { id: string; unit: string; english: string; chinese: string }[] = [];
    for (const [unit, q2Kind] of [[reasoningUnit, 'reasoning'], [codeUnit, 'code']] as const) {
      const spec = assessments.saveSpec(data.spaceId, unit, { public: { q1: '解释原文', q2: '练习原文', q2Kind,
        ...(q2Kind === 'code' ? { execution: { language: 'bash', cases: [{ args: [], expected: 'expected' }] } } : {}) },
      rubric: { q1: { answer: '解释', criteria: ['给出例子'] }, q2: { answer: '练习', criteria: ['符合要求'] } } },
      { requirement: learning.space(data.spaceId).requirement.revision, route: 1, lesson: 1 }, 1);
      const fixed = assessments.submit(data.spaceId, unit, { kind: 'evaluation', revision: learning.unit(data.spaceId, unit).draft.revision,
        specRevision: spec.revision, q1: '作答原文', q2: "printf '中文运行输出\\n'" });
      const record = assessments.grade(data.spaceId, unit, fixed, { result: 'pass', summary: '模型通过反馈' });
      records.push({ id: record.id, unit, english: q2Kind === 'code'
        ? 'No usable code execution result is available. It is not yet possible to determine whether the code meets the requirements.'
        : 'Your answers meet the requirements for this assessment.', chinese: q2Kind === 'code'
          ? '本次没有可用的代码运行结果，尚不能判断代码是否符合要求。' : '本次作答符合题目要求。' });
      expect(record.summary).toBe('');
      if (q2Kind === 'code') {
        const fixed = assessments.submit(data.spaceId, unit, { kind: 'evaluation', revision: learning.unit(data.spaceId, unit).draft.revision,
          specRevision: spec.revision, q1: '作答原文', q2: "printf '中文运行输出\\n'" });
        const execution = executions.create(data.spaceId, unit, { specRevision: spec.revision, code: fixed.submission.answers.q2 }, fixed.submission.id);
        fixed.submission.evidence = { kind: 'local', execution: await executions.run(data.spaceId, execution.id) };
        const mismatch = assessments.grade(data.spaceId, unit, fixed, { result: 'pass', summary: '模型不能覆盖执行事实' });
        expect(mismatch.summary).toBe('');
        records.push({ id: mismatch.id, unit, english: 'Output from 1 check did not match the question’s requirements.', chinese: '有 1 项检查的输出与题目要求不一致。' });
      }
    }
    for (const record of records) {
      await page.goto(`/?space=${data.spaceId}&tab=result&unit=${record.unit}&record=${record.id}`);
      await expect(page.getByText(record.english, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(record.chinese, { exact: true })).toHaveCount(0);
      await shot(page, info, `summary-${record.id === records.at(-1)!.id ? 'mismatch' : record.unit === codeUnit ? 'unverified' : 'pass'}-en`);
      await settings(page); await chooseLanguage(page, '简体中文');
      await page.getByRole('button', { name: '返回', exact: true }).click();
      await expect(page.getByText(record.chinese, { exact: true }).first()).toBeVisible();
      await settings(page); await chooseLanguage(page, 'English');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.reload();
      await expect(page.getByText(record.english, { exact: true }).first()).toBeVisible();
      expect(learning.record(data.spaceId, record.id).summary).toBe('');
    }
    await expect(page.getByTestId('code-execution').getByText('Actual output: 中文运行输出', { exact: true })).toBeVisible();
    await page.goto(`/?space=${data.spaceId}&tab=result&unit=${codeUnit}&record=${data.recordId}`);
    await expect(page.getByText('验收记录：需要更多证据', { exact: true })).toBeVisible();
  } finally { await executions.close(); db.close(); }
});

test('unknown, unstructured and native request failures never expose old Chinese UI fallbacks', async ({ page }) => {
  let failure: 'unknown' | 'unstructured' | 'network' = 'unknown';
  await page.route('**/api/library', (route) => failure === 'network' ? route.abort('failed') : route.fulfill({ status: 503,
    json: { ...(failure === 'unknown' ? { code: 'FUTURE_ERROR' } : {}), error: '旧中文错误不得作为界面回退' } }));
  for (const language of ['en', 'zh-CN']) {
    await page.goto('/');
    if (language === 'zh-CN') {
      await settings(page); await chooseLanguage(page, '简体中文');
      await page.getByRole('button', { name: '返回', exact: true }).click();
    }
    for (const value of ['unknown', 'unstructured', 'network'] as const) {
      failure = value;
      await page.goto('/library');
      await expect(page.getByRole('alert')).toContainText(language === 'en' ? 'Request failed. Please try again.' : '请求失败，请重试。');
      await expect(page.locator('body')).not.toContainText('旧中文错误不得作为界面回退');
    }
  }
  await page.unroute('**/api/library');
  await page.reload();
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('marker catalogs expose untranslated text and accessibility attributes across settings and dialogs', async ({ page }, info) => {
  test.skip(info.project.name !== 'development', 'Catalog injection uses Vite modules; production exercises the real bundled catalogs above.');
  await page.addInitScript(() => localStorage.setItem('tmc-language', 'zh-CN'));
  await page.goto('/');
  const opaque = await page.evaluate(async () => {
    const modulePath = '/src/lib/api.ts';
    const { api } = await import(modulePath);
    const [spaces, model, search] = await Promise.all([api('/spaces'), api('/settings/model'), api('/settings/search')]);
    return [...spaces.map((space: { name: string }) => space.name),
      ...model.providers.flatMap((provider: { id: string; name: string }) => [provider.id, provider.name]),
      ...search.providers.flatMap((provider: { id: string; name: string }) => [provider.id, provider.name])];
  });
  await page.evaluate(async () => {
    const modulePath = '/src/i18n/index.ts';
    const { default: i18n } = await import(modulePath);
    const mark = (value: unknown, path: string): unknown => typeof value === 'string'
      ? `⟦${path}⟧${(value.match(/{{[^}]+}}/g) ?? []).join(' ')}`
      : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, mark(entry, `${path}.${key}`)]));
    for (const namespace of i18n.options.ns) i18n.addResourceBundle('en', namespace, mark(i18n.getResourceBundle('en', namespace), namespace), true, true);
  });
  await settings(page); await chooseLanguage(page, 'English');
  const unmarked = () => page.evaluate((content) => {
    const allowed = new Set(['TeachMeCoding', 'Agent', 'English', '简体中文', 'YOLO', 'IDE', 'Enter', 'Shift', 'CRLF', 'UTF-8', 'npx', 'https://example.com/mcp', ...content]);
    const violations: string[] = [];
    const inspect = (value: string) => {
      const remainder = value.replace(/⟦[^⟧]*⟧/g, '').trim();
      if (/\p{L}/u.test(remainder) && !allowed.has(remainder)) violations.push(remainder);
    };
    const visible = (element: Element) => element.checkVisibility() && !element.closest('[aria-hidden="true"], [inert], [translate="no"]');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && !['SCRIPT', 'STYLE'].includes(parent.tagName) && visible(parent)) inspect(walker.currentNode.textContent ?? '');
    }
    for (const element of document.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) if (visible(element)) {
      for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) inspect(element.getAttribute(attribute) ?? '');
    }
    return [...new Set(violations)];
  }, opaque);
  const audit = async (state: string) => expect(await unmarked(), state).toEqual([]);
  await expect(page.getByRole('heading', { name: '⟦settings.title⟧', exact: true })).toBeVisible();
  await audit('model settings');
  await page.getByRole('tab', { name: '⟦settings.categories.mcp⟧', exact: true }).click();
  await page.getByRole('button', { name: '⟦settings.mcp.addServer⟧', exact: true }).click();
  await audit('stdio server dialog');
  await page.getByRole('tab', { name: '⟦settings.mcpEditor.http⟧', exact: true }).click();
  await audit('HTTP server dialog');
  await page.getByRole('dialog').getByRole('button', { name: '⟦common.actions.closeDialog⟧', exact: true }).click();
  await page.getByRole('tab', { name: '⟦settings.categories.skills⟧', exact: true }).click();
  await audit('skills settings');
  await page.getByRole('tab', { name: '⟦settings.categories.search⟧', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '⟦settings.categories.search⟧', exact: true })).toBeVisible();
  await audit('search settings');
  await page.getByRole('button', { name: '⟦settings.back⟧', exact: true }).click();
  await audit('home');
  await page.getByRole('button', { name: '⟦library.title⟧', exact: true }).click();
  await expect(page.getByRole('heading', { name: '⟦library.title⟧', exact: true })).toBeVisible();
  await audit('library');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'i18n-omission-probe'; button.textContent = 'Planted untranslated button'; document.body.append(button);
  });
  expect(await unmarked()).toContain('Planted untranslated button');
  await page.locator('#i18n-omission-probe').evaluate((button) => button.remove());
  await audit('probe removed');
});

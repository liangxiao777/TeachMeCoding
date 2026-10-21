import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { McpSettings } from '../../packages/contracts/src/settings';
import type { seedWorkspaces } from '../seed-workspaces';

test('MCP HTTP form, JSON, cancellation and credentials work in both themes and mobile', async ({ page }, info) => {
  const requests: { method: string; authorization?: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body);
    requests.push({ method: message.method, authorization: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer synthetic-form-secret') { res.writeHead(401).end(); return; }
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-form-fixture', version: '1' } }
      : { tools: [{ name: 'lookup', description: 'Look up synthetic documentation.', inputSchema: { type: 'object', properties: {} } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port.');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const seed = JSON.parse(readFileSync(`.amp/in/browser-${info.project.name}.json`, 'utf8')) as ReturnType<typeof seedWorkspaces>;
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '应用设置', exact: true }).click();
    const settings = page.getByRole('region', { name: '应用设置', exact: true });
    await settings.getByRole('tab', { name: 'MCP', exact: true }).click();
    const add = settings.getByRole('button', { name: '添加 MCP Server', exact: true });
    const dialog = page.getByRole('dialog');
    await add.click();
    // Merely inspecting the initial JSON must not trap an incomplete form in JSON mode.
    await dialog.getByRole('tab', { name: 'JSON', exact: true }).click();
    await dialog.getByRole('tab', { name: '表单', exact: true }).click();
    await expect(dialog.getByLabel('启动命令', { exact: true })).toBeVisible();
    await dialog.getByLabel('服务器名称', { exact: true }).fill('cancelled-draft');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(settings.getByRole('heading', { name: 'cancelled-draft', exact: true })).toHaveCount(0);

    await add.click();
    await dialog.getByLabel('服务器名称', { exact: true }).fill('remote-docs');
    await dialog.getByLabel('启动命令', { exact: true }).fill('node');
    await dialog.getByLabel('启动参数', { exact: true }).fill('one argument with spaces\n\nlast');
    await dialog.getByRole('tab', { name: '远程地址（HTTP）', exact: true }).click();
    await dialog.getByLabel('服务器地址', { exact: true }).fill(url);
    await dialog.getByRole('button', { name: '添加请求头', exact: true }).click();
    await dialog.getByLabel('请求头名称 1', { exact: true }).fill('Authorization');
    await dialog.getByLabel('请求头值 1', { exact: true }).fill('Bearer synthetic-form-secret');
    await dialog.getByRole('tab', { name: '本地进程（stdio）', exact: true }).click();
    await expect(dialog.getByLabel('启动参数', { exact: true })).toHaveValue('one argument with spaces\n\nlast');
    await dialog.getByRole('tab', { name: '远程地址（HTTP）', exact: true }).click();
    await dialog.getByRole('button', { name: /高级配置/ }).click();
    await dialog.getByLabel('请求超时（秒）', { exact: true }).fill('12.5');
    await page.screenshot({ path: `.amp/in/artifacts/mcp-add-http-light-${info.project.name}.png`, animations: 'disabled' });
    await dialog.getByRole('tab', { name: 'JSON', exact: true }).click();
    const json = dialog.getByLabel('服务器配置 JSON', { exact: true });
    expect(JSON.parse(await json.inputValue())).toEqual({ type: 'http', url, headers: { Authorization: 'Bearer synthetic-form-secret' }, timeout: 12.5, enabled: true });
    await dialog.getByRole('tab', { name: '表单', exact: true }).click();
    await dialog.getByLabel('请求头值 1', { exact: true }).fill('Bearer ${HTTP_TOKEN}');
    await dialog.getByRole('button', { name: '添加服务器', exact: true }).click();
    await expect(dialog.getByText('不再支持 ${VAR} 等环境引用，请编辑此服务器并填写实际值。', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('请求头值 1', { exact: true })).toHaveValue('Bearer ${HTTP_TOKEN}');
    expect(requests).toEqual([]);
    await page.screenshot({ path: `.amp/in/artifacts/mcp-environment-reference-error-${info.project.name}.png`, animations: 'disabled' });
    await dialog.getByLabel('请求头值 1', { exact: true }).fill('Bearer synthetic-form-secret');
    await dialog.getByRole('button', { name: '添加服务器', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(settings.getByText('已连接', { exact: true })).toBeVisible();
    await expect(settings.getByText('1 个工具', { exact: true })).toBeVisible();
    await expect(settings.getByText('lookup', { exact: true })).toHaveCount(0);
    expect(requests.map((request) => request.method)).toContain('tools/list');
    expect(requests.every((request) => request.authorization === 'Bearer synthetic-form-secret')).toBe(true);
    await page.screenshot({ path: `.amp/in/artifacts/mcp-list-light-${info.project.name}.png`, animations: 'disabled' });
    await settings.getByRole('button', { name: '切换到暗色主题', exact: true }).click();
    await page.screenshot({ path: `.amp/in/artifacts/mcp-list-dark-${info.project.name}.png`, animations: 'disabled' });

    const menu = settings.getByRole('button', { name: '配置 remote-docs', exact: true });
    await menu.click();
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await expect(dialog.getByLabel('请求头值 1', { exact: true })).toHaveValue('••••••••');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(menu).toBeFocused();
    await add.click();
    await dialog.getByRole('tab', { name: 'JSON', exact: true }).click();
    await json.fill(JSON.stringify({ mcpServers: { one: { command: 'node' }, two: { command: 'node' } } }));
    await dialog.getByRole('button', { name: '添加服务器', exact: true }).click();
    await expect(dialog.getByText(/配置中只能包含一个服务器/)).toBeVisible();
    await json.fill(JSON.stringify({ mcpServers: { 'remote-docs': { url, enabled: false } } }));
    await dialog.getByRole('button', { name: '添加服务器', exact: true }).click();
    await expect(dialog.getByText('已存在同名 MCP 服务器，请换一个名称。', { exact: true })).toBeVisible();
    expect(JSON.parse(await json.inputValue()).mcpServers['remote-docs'].url).toBe(url);
    await page.keyboard.press('Escape');
    expect(JSON.parse(readFileSync(join(seed.root, 'mcp.json'), 'utf8')).mcpServers['remote-docs'].headers.Authorization).toBe('Bearer synthetic-form-secret');

    await page.setViewportSize({ width: 390, height: 844 });
    await add.click();
    await dialog.getByLabel('服务器名称', { exact: true }).fill('local-files');
    await dialog.getByLabel('启动命令', { exact: true }).fill('npx');
    await dialog.getByRole('button', { name: /高级配置/ }).click();
    await dialog.getByRole('button', { name: '添加环境变量', exact: true }).click();
    await dialog.getByLabel('环境变量名称 1', { exact: true }).fill('TOKEN');
    await dialog.getByLabel('环境变量值 1', { exact: true }).fill('synthetic-mobile-value');
    await dialog.getByLabel('请求超时（秒）', { exact: true }).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const title = await dialog.getByRole('heading', { name: '添加 MCP Server', exact: true }).boundingBox();
    expect(title!.y).toBeGreaterThanOrEqual(16);
    const input = await dialog.getByLabel('请求超时（秒）', { exact: true }).boundingBox();
    const footerTop = await dialog.locator('[data-slot="dialog-footer"]').boundingBox();
    expect(input!.y + input!.height).toBeLessThanOrEqual(footerTop!.y);
    const footer = dialog.getByRole('button', { name: '添加服务器', exact: true });
    expect((await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: `.amp/in/artifacts/mcp-add-advanced-mobile-dark-${info.project.name}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await menu.click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.screenshot({ path: `.amp/in/artifacts/mcp-delete-mobile-dark-${info.project.name}.png`, animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(settings.getByRole('heading', { name: 'remote-docs', exact: true })).toBeVisible();
    await menu.click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await dialog.getByRole('button', { name: '删除服务器', exact: true }).click();
    await expect(settings.getByText('尚未配置 MCP 服务器。', { exact: true })).toBeVisible();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('MCP failed writes retain configuration and drafts, while late polling cannot undo a toggle', async ({ page }) => {
  const initial: McpSettings = { configuration: { mcpServers: { docs: { command: 'node', enabled: true } } },
    servers: [{ name: 'docs', state: 'connected', error: null, tools: [] }] };
  let settings = initial, gets = 0, failed = true, hold = false, held = false, delivered = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings/mcp**', async (route) => {
    if (route.request().method() === 'GET') {
      gets++;
      if (hold && !held) { held = true; await waiting; await route.fulfill({ json: initial }); delivered = true; return; }
      return route.fulfill({ json: settings });
    }
    if (failed) return route.fulfill({ status: 503, json: { code: 'SETTINGS_READ_FAILED' } });
    const input = route.request().postDataJSON();
    settings = { configuration: { mcpServers: { docs: input.configuration } }, servers: [{ ...initial.servers[0]!, state: 'disabled' }] };
    return route.fulfill({ json: settings });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const region = page.getByRole('region', { name: '应用设置', exact: true });
  await region.getByRole('tab', { name: 'MCP', exact: true }).click();
  await region.getByRole('button', { name: '配置 docs', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('服务器名称', { exact: true }).fill('unsaved-docs');
  await dialog.getByLabel('启动命令', { exact: true }).fill('unsaved-command');
  const before = gets;
  await expect.poll(() => gets).toBeGreaterThan(before);
  await expect(dialog.getByLabel('服务器名称', { exact: true })).toHaveValue('unsaved-docs');
  await expect(dialog.getByLabel('启动命令', { exact: true })).toHaveValue('unsaved-command');
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(dialog.getByText('无法保存或读取设置，请检查数据目录权限和配置文件。', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('启动命令', { exact: true })).toHaveValue('unsaved-command');
  await page.keyboard.press('Escape');
  const toggle = region.getByRole('switch', { name: '启用 docs', exact: true });
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(region.getByText('无法保存或读取设置，请检查数据目录权限和配置文件。', { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  hold = true;
  await expect.poll(() => held).toBe(true);
  failed = false;
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect(region.getByText('已停用', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => delivered).toBe(true);
  await page.waitForTimeout(200); // Allow the deliberately stale response to reach React.
  await expect(toggle).not.toBeChecked();
  await expect(region.getByText('已停用', { exact: true })).toBeVisible();
});

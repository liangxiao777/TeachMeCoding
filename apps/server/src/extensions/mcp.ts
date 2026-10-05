import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type McpTransport } from '@earendil-works/pi-mcp';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { mcpConfigurationSchema, mcpServerEntrySchema, type McpConfiguration, type McpSettings, type McpServerConfiguration } from '@teach-me-coding/contracts';
import type { EnvLookup } from '../config/model.js';
import { terminalEnvironment } from '../runtime/terminal-env.js';
import { BusinessError } from '../modules/learning.js';

const mask = '••••••••';
type Connection = { config: McpServerConfiguration; status: McpSettings['servers'][number]; client: McpClient;
  tools: AgentTool[]; ready: Promise<void> };

export function mcpToolName(server: string, tool: string) {
  const identity = JSON.stringify([server, tool]);
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 51) + `_${suffix}`;
}

/** Owns app-configured connections, not Pi's session/extension runtime. */
export class McpService {
  private configuration: McpConfiguration;
  private connections = new Map<string, Connection>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private path: string, private options: {
    env: EnvLookup; cwd: string; transport?: (config: McpServerConfiguration) => McpTransport;
  }) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('MCP config must be a regular file.');
    this.configuration = info ? mcpConfigurationSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : { mcpServers: {} };
  }
  private expand(value: string) {
    return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
      const found = this.options.env(name);
      if (found === undefined) throw new Error('Required MCP environment variable is missing.');
      return found;
    });
  }
  private transport(config: McpServerConfiguration): McpTransport {
    if (this.options.transport) return this.options.transport(config);
    const fields = (values?: Record<string, string>) => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, this.expand(value)]));
    if (config.url) return new StreamableHttpTransport({ url: config.url, headers: fields(config.headers) });
    const cwd = config.cwd?.startsWith('~/') ? resolve(homedir(), config.cwd.slice(2)) : resolve(this.options.cwd, config.cwd ?? '.');
    return new StdioTransport({ command: config.command!, args: config.args, cwd, inheritEnv: false,
      env: { ...terminalEnvironment(process.env), ...fields(config.env) }, stderr: 'pipe' });
  }
  start() {
    if (this.closed) return;
    for (const [name, config] of Object.entries(this.configuration.mcpServers)) {
      if (this.connections.has(name)) continue;
      const client = new McpClient({ name: 'teach-me-coding', version: '1.0.0', requestTimeoutMs: (config.timeout ?? 60) * 1000 });
      const connection: Connection = { config, client, tools: [], ready: Promise.resolve(),
        status: { name, state: config.enabled === false ? 'disabled' : 'connecting', error: null, tools: [] } };
      this.connections.set(name, connection);
      if (config.enabled === false) continue;
      client.onClose(() => {
        if (connection.status.state === 'connected') {
          connection.status.state = 'failed'; connection.status.error = '连接已断开，请重新连接。'; connection.tools = [];
        }
      });
      const discover = async () => {
        const discovered = client.serverCapabilities?.tools ? await client.listTools() : [];
        if (this.closed || this.connections.get(name) !== connection) return;
        connection.tools = discovered.map((tool): AgentTool => ({
          name: mcpToolName(name, tool.name), label: `${name} · ${tool.title ?? tool.name}`,
          description: `[MCP ${name}/${tool.name}] ${tool.description ?? ''}`,
          parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} }),
          ...(tool.outputSchema ? { outputSchema: Type.Unsafe(tool.outputSchema) } : {}),
          execute: async (_id, args, signal, onUpdate) => {
            try {
              const result = await client.callTool(tool.name, args as Record<string, unknown>, { signal, timeoutMs: (config.timeout ?? 60) * 1000,
                onProgress: (progress) => onUpdate?.({ content: [{ type: 'text', text: progress.message ?? 'MCP 工具正在执行。' }], details: {} }) });
              return { content: toLlmContent(result), ...(result.structuredContent ? { structuredContent: JSON.parse(JSON.stringify(result.structuredContent)) } : {}),
                isError: result.isError === true, details: { sources: [{ kind: 'mcp', server: name, tool: tool.name }] } };
            } catch {
              // Never copy transport error bodies, headers, env or stderr into a transcript.
              throw new Error(signal?.aborted ? 'MCP 调用已取消。' : `MCP ${name}/${tool.name} 调用失败，请检查服务器连接。`);
            }
          },
        }));
        connection.status.tools = discovered.map((tool) => ({ name: tool.name, agentName: mcpToolName(name, tool.name), description: tool.description ?? '' }));
      };
      client.onNotification('notifications/tools/list_changed', () => {
        void discover().catch(() => { connection.status.error = '工具列表更新失败，请重新连接。'; });
      });
      connection.ready = (async () => {
        try {
          await client.connect(this.transport(config));
          await discover();
          if (!this.closed && this.connections.get(name) === connection) connection.status.state = 'connected';
        } catch {
          connection.status.state = 'failed'; connection.status.error = '无法连接，请检查命令、地址和认证配置。';
          await client.close();
        }
      })();
    }
  }
  settings(): McpSettings {
    const configuration = structuredClone(this.configuration);
    for (const config of Object.values(configuration.mcpServers)) for (const key of ['env', 'headers'] as const) {
      if (config[key]) config[key] = Object.fromEntries(Object.entries(config[key]).map(([name, value]) => [name, /^(?:Bearer )?\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value) || !value ? value : mask]));
    }
    return { configuration, servers: Object.keys(configuration.mcpServers).flatMap((name) => {
      const entry = this.connections.get(name);
      return entry ? [structuredClone(entry.status)] : [];
    }) };
  }
  async tools(signal?: AbortSignal): Promise<AgentTool[]> {
    this.start();
    const selected = [...this.connections.values()];
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      void Promise.all(selected.map((entry) => entry.ready)).then(() => resolve(), reject)
        .finally(() => signal?.removeEventListener('abort', cancel));
    });
    return selected.filter((entry) => this.connections.get(entry.status.name) === entry && entry.status.state === 'connected').flatMap((entry) => entry.tools);
  }
  private restoreSecrets(config: McpServerConfiguration, previous?: McpServerConfiguration) {
    for (const field of ['env', 'headers'] as const) for (const [key, value] of Object.entries(config[field] ?? {})) if (value === mask) {
      const original = previous?.[field]?.[key];
      if (original === undefined) throw new BusinessError(400, '新的认证字段需要填写实际值。');
      config[field]![key] = original;
    }
  }
  private write(update: () => McpConfiguration): Promise<McpSettings> {
    const operation = this.writes.then(async () => {
      if (this.closed) throw new BusinessError(503, '服务正在关闭。');
      const parsed = mcpConfigurationSchema.parse(update());
      for (const [name, config] of Object.entries(parsed.mcpServers)) this.restoreSecrets(config, this.configuration.mcpServers[name]);
      const temporary = `${this.path}.tmp`;
      rmSync(temporary, { force: true });
      writeFileSync(temporary, JSON.stringify(parsed, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      this.configuration = parsed;
      await Promise.all([...this.connections].map(async ([name, entry]) => {
        if (JSON.stringify(entry.config) === JSON.stringify(parsed.mcpServers[name])) return;
        this.connections.delete(name); await entry.client.close();
      }));
      this.start();
      return this.settings();
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  save(raw: unknown): Promise<McpSettings> {
    const parsed = mcpConfigurationSchema.parse(raw);
    return this.write(() => parsed);
  }
  saveServer(raw: unknown, previousName?: string): Promise<McpSettings> {
    const entry = mcpServerEntrySchema.parse(raw);
    return this.write(() => {
      const servers = this.configuration.mcpServers;
      if (previousName !== undefined && !Object.hasOwn(servers, previousName)) throw new BusinessError(404, 'MCP 服务器不存在。');
      if (entry.name !== previousName && Object.hasOwn(servers, entry.name)) throw new BusinessError(409, '已存在同名 MCP 服务器，请换一个名称。');
      this.restoreSecrets(entry.configuration, previousName === undefined ? undefined : servers[previousName]);
      const next = { ...servers };
      if (previousName !== undefined && previousName !== entry.name) delete next[previousName];
      next[entry.name] = entry.configuration;
      return { mcpServers: next };
    });
  }
  removeServer(name: string): Promise<McpSettings> {
    return this.write(() => {
      if (!Object.hasOwn(this.configuration.mcpServers, name)) throw new BusinessError(404, 'MCP 服务器不存在。');
      const next = { ...this.configuration.mcpServers }; delete next[name];
      return { mcpServers: next };
    });
  }
  reconnect(name?: string): Promise<McpSettings> {
    const operation = this.writes.then(async () => {
      if (this.closed) throw new BusinessError(503, '服务正在关闭。');
      if (name !== undefined && !Object.hasOwn(this.configuration.mcpServers, name)) throw new BusinessError(404, 'MCP 服务器不存在。');
      const old = [...this.connections].filter(([server]) => name === undefined || server === name);
      await Promise.all(old.map(async ([server, entry]) => { this.connections.delete(server); await entry.client.close(); }));
      this.start(); return this.settings();
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  async close() {
    this.closed = true;
    await this.writes;
    await Promise.all([...this.connections.values()].map((entry) => entry.client.close()));
    this.connections.clear();
  }
}

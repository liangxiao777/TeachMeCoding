import { z } from 'zod';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const thinkingLevelSchema = z.enum(thinkingLevels);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelSelectionSchema = z.object({
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(500),
  thinkingLevel: thinkingLevelSchema,
}).strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export type AuthMethod = 'api_key' | 'oauth';
export interface ProviderSummary {
  id: string;
  name: string;
  /** Login methods offered by pi-ai. An api-key method without login is ambient-only (env/files). */
  auth: { apiKey?: { name: string; login: boolean }; oauth?: { name: string; label?: string; subscription: boolean } };
  /** Effective configuration from pi-ai auth resolution, never the secret itself. */
  configured: { type: AuthMethod; source?: string } | null;
  /** Credential saved by this app, if any. */
  stored: AuthMethod | null;
  models: number;
}
export interface ModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  contextWindow: number;
  maxTokens: number;
  input: string[];
}
export interface ModelSettings {
  selection: ModelSelection | null;
  /** True when the selected model exists, the level is supported and its provider is configured. */
  ready: boolean;
  issue: string | null;
  providers: ProviderSummary[];
}

export const loginStartSchema = z.object({ type: z.enum(['api_key', 'oauth']) }).strict();
export const loginAnswerSchema = z.object({ promptId: z.string().uuid(), value: z.string().max(20_000) }).strict();
export type LoginPrompt = { id: string } & (
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: { id: string; label: string; description?: string }[] });
export type LoginEvent =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string };
export interface LoginSession {
  id: string;
  providerId: string;
  type: AuthMethod;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  prompt: LoginPrompt | null;
  events: LoginEvent[];
  error: string | null;
}

const stringMap = z.record(z.string().min(1), z.string());
export const mcpServerSchema = z.object({
  type: z.enum(['stdio', 'http', 'streamable-http']).optional(),
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(), env: stringMap.optional(),
  url: z.url().refine((value) => /^https?:/.test(value), 'Use an HTTP or HTTPS URL.').optional(),
  headers: stringMap.optional(), enabled: z.boolean().optional(),
  timeout: z.number().positive().finite().optional(),
}).strict().superRefine((value, ctx) => {
  if (!!value.command === !!value.url || value.command && (value.type === 'http' || value.type === 'streamable-http' || value.headers)
    || value.url && (value.type === 'stdio' || value.args || value.cwd || value.env)) {
    ctx.addIssue({ code: 'custom', message: 'Configure either stdio command/args/env/cwd or HTTP url/headers.' });
  }
});
const mcpServerNameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, '服务器名称只能包含字母、数字、下划线和连字符。');
export const mcpServerEntrySchema = z.object({ name: mcpServerNameSchema, configuration: mcpServerSchema }).strict();
export const mcpConfigurationSchema = z.object({
  mcpServers: z.record(mcpServerNameSchema, mcpServerSchema),
}).strict();
export type McpConfiguration = z.infer<typeof mcpConfigurationSchema>;
export type McpServerConfiguration = z.infer<typeof mcpServerSchema>;
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
export interface McpSettings {
  /** Environment/header values are masked; unchanged masks preserve their stored values on save. */
  configuration: McpConfiguration;
  servers: { name: string; state: 'disabled' | 'connecting' | 'connected' | 'failed'; error: string | null;
    tools: { name: string; agentName: string; description: string }[] }[];
}
export const skillConfigurationSchema = z.object({
  paths: z.array(z.string().min(1)), disabled: z.array(z.string()), excluded: z.array(z.string()).default([]),
}).strict();
export type SkillConfiguration = z.infer<typeof skillConfigurationSchema>;
export const skillInstallSchema = z.object({ source: z.string().trim().min(1),
  skill: z.string().trim().min(1).refine((name) => !name.startsWith('-'), '技能名称不能是命令选项。').optional(),
}).strict();
export const skillPathSchema = z.object({ filePath: z.string().min(1) }).strict();
export const skillLocalSchema = z.object({ path: z.string().trim().min(1) }).strict();
export interface SkillInstallation {
  source: string;
  skill: string;
  ref: string | null;
  upstreamHash: string | null;
  contentHash: string;
  cliVersion: string;
  sourceUrl?: string;
  skillPath?: string;
}
export interface CatalogSkill { id: string; source: string; skillId: string; name: string; installs: number }
export interface SkillSearch { skills: CatalogSkill[] }
export interface SkillDetails {
  name: string; filePath: string; installation: SkillInstallation | null;
  files: string[]; content: string;
}
export interface SkillUpdate { filePath: string; available: boolean; modified: boolean }
export interface SkillSettings {
  configuration: SkillConfiguration;
  directory: string;
  skills: { name: string; description: string; filePath: string; enabled: boolean; automatic: boolean; installation: SkillInstallation | null }[];
  diagnostics: { type: string; message: string; path?: string }[];
}

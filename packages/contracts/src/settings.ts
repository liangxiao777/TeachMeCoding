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

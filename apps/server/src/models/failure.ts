import { z } from 'zod';

const oauthErrorSchema = z.object({ error: z.union([z.string(), z.object({ code: z.string().optional(), type: z.string().optional() })]) });
const reauthCodes = new Set(['invalid_grant', 'invalid_client', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);

export interface ModelFailure {
  category: 'oauth_reauth_required' | 'oauth_refresh_failed';
  status: number | null;
  code: string | null;
  message: string;
}

/** Classify Pi's auth boundary, never arbitrary provider prose or response bodies. */
export function classifyModelFailure(provider: string, reason?: string): ModelFailure | undefined {
  const prefix = `OAuth refresh failed for ${provider}: `;
  if (!reason?.startsWith(prefix)) return;
  const detail = reason.slice(prefix.length);
  const response = detail.match(/^[^\n]*token request failed \((\d{3})\):\s*([\s\S]*)$/);
  const status = response ? Number(response[1]) : null;
  let code: string | null = null;
  if (response && status !== null && status >= 400 && status < 500) {
    try {
      const body = oauthErrorSchema.safeParse(JSON.parse(response[2]!));
      if (body.success) {
        const candidate = typeof body.data.error === 'string' ? body.data.error : body.data.error.code ?? body.data.error.type;
        if (candidate && reauthCodes.has(candidate)) code = candidate;
      }
    } catch { /* Malformed/unknown responses remain retryable, with no body retained. */ }
  }
  const reconnect = code !== null || detail === 'Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT';
  const name = provider === 'openai' || provider === 'openai-codex' ? 'ChatGPT' : provider;
  return { category: reconnect ? 'oauth_reauth_required' : 'oauth_refresh_failed', status, code,
    message: reconnect ? `${name} 登录已失效，请在应用设置中重新登录。` : `${name} 登录暂时无法续期，请稍后重试。` };
}

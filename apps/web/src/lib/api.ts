import type { RunEvent } from '@teach-me-coding/contracts';

let token: Promise<string> | undefined;
const pending = new Map<string, string>();

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // LAN HTTP is not a secure context; getRandomValues still provides secure randomness.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function access() {
  token ??= fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, '无法连接本地服务，请重试。');
    return (await response.json() as { token: string }).token;
  }).catch((error: unknown) => { token = undefined; throw error; });
  return token;
}
export async function api<T>(path: string, input?: unknown): Promise<T> {
  const body = input === undefined ? undefined : JSON.stringify(input);
  const fingerprint = `${path}:${body}`;
  // Failed/unknown outcomes retain their key. A retry cannot create another resource.
  if (body !== undefined && !pending.has(fingerprint)) pending.set(fingerprint, requestId());
  const send = async () => fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', body,
    headers: { 'X-TMC-Token': await access(), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': pending.get(fingerprint)! }) },
  });
  let response = await send();
  if (response.status === 401) { token = undefined; response = await send(); }
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, result.error ?? '请求失败，请重试。');
  pending.delete(fingerprint);
  return result;
}

/** A subscription only reads durable events. Aborting it never stops the server run. */
export async function streamRun(path: string, after: number, signal: AbortSignal, receive: (event: RunEvent) => void) {
  const send = async () => fetch(`/api${path}/stream?after=${after}`, { signal, headers: { 'X-TMC-Token': await access() } });
  let response = await send();
  if (response.status === 401) { token = undefined; response = await send(); }
  if (!response.ok || !response.body) throw new ApiError(response.status, '事件连接中断，请重新连接。');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) receive(JSON.parse(data.slice(6)) as RunEvent);
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

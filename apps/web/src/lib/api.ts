let token: Promise<string> | undefined;
const pending = new Map<string, string>();

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
  if (body !== undefined && !pending.has(fingerprint)) pending.set(fingerprint, crypto.randomUUID());
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

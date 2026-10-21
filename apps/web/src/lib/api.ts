import type { BusinessErrorResponse, LibraryDocument, RunEvent } from '@teach-me-coding/contracts';
import { NoticeError, notice } from '@/i18n/notice';

let token: Promise<string> | undefined;
const pending = new Map<string, string>();
const uploads = new WeakMap<File, string>();

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // LAN HTTP is not a secure context; getRandomValues still provides secure randomness.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends NoticeError {
  constructor(public status: number, detail?: Partial<BusinessErrorResponse>, fallback = notice('common', 'errors.requestFailed')) {
    super(typeof detail?.code === 'string' ? { code: detail.code, params: detail.params } : fallback);
  }
}
export async function access(refresh = false) {
  if (refresh) token = undefined;
  token ??= fetch('/api/access', { headers: { 'X-TMC-Client': 'browser' } }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, undefined, notice('common', 'errors.connection'));
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
  const result = await response.json() as T & Partial<BusinessErrorResponse>;
  if (!response.ok) throw new ApiError(response.status, result);
  pending.delete(fingerprint);
  return result;
}

async function fileRequest(path: string, init?: RequestInit) {
  const send = async () => fetch(`/api${path}`, { ...init, headers: { ...init?.headers, 'X-TMC-Token': await access() } });
  let response = await send();
  if (response.status === 401) { token = undefined; response = await send(); }
  if (!response.ok) {
    const result = await response.json() as Partial<BusinessErrorResponse>;
    throw new ApiError(response.status, result, notice('common', 'errors.transfer'));
  }
  return response;
}
export async function uploadLibraryFile(file: File): Promise<LibraryDocument> {
  if (!uploads.has(file)) uploads.set(file, requestId());
  const response = await fileRequest(`/library/files?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': uploads.get(file)! },
  });
  const result = await response.json() as LibraryDocument;
  uploads.delete(file);
  return result;
}
export async function downloadLibraryFile(file: LibraryDocument) {
  const response = await fileRequest(`/library/files/${file.id}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A subscription only reads durable events. Aborting it never stops the server run. */
export async function streamRun(path: string, after: number, signal: AbortSignal, receive: (event: RunEvent) => void) {
  const idle = new AbortController()
  let timer = setTimeout(() => idle.abort(), 20_000)
  let reader: ReadableStreamDefaultReader<string> | undefined;
  try {
    const send = async () => fetch(`/api${path}/stream?after=${after}`, { signal: AbortSignal.any([signal, idle.signal]), headers: { 'X-TMC-Token': await access() } });
    let response = await send();
    if (response.status === 401) { token = undefined; response = await send(); }
    if (!response.ok || !response.body) throw new ApiError(response.status, undefined, notice('common', 'errors.stream'));
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      clearTimeout(timer); timer = setTimeout(() => idle.abort(), 20_000);
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) receive(JSON.parse(data.slice(6)) as RunEvent);
      }
    }
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}

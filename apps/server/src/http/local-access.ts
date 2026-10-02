import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export function createLocalAccess({ port, development = false, webPort = 5173 }: { port: number; development?: boolean; webPort?: number }) {
  const ports = development ? [port, webPort] : [port];
  const hosts = new Set(ports.flatMap((value) => [`127.0.0.1:${value}`, `localhost:${value}`]));
  return {
    token: randomBytes(32).toString('hex'),
    hosts,
    origins: new Set([...hosts].map((host) => `http://${host}`)),
  };
}
export type LocalAccess = ReturnType<typeof createLocalAccess>;

export function localAccessError(
  headers: Headers,
  access: LocalAccess,
  { requireToken = false, websocket = false } = {},
): 401 | 403 | undefined {
  // Do not trust X-Forwarded-Host/Origin: the Vite proxy preserves actual headers.
  if (!access.hosts.has(headers.get('host') ?? '')) return 403;
  const origin = headers.get('origin');
  if (origin !== null && !access.origins.has(origin)) return 403;
  if (websocket && origin === null) return 403;
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return 403;
  if (!requireToken && !websocket) return;

  const protocols = (headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim());
  const tokens = protocols.filter((value) => value.startsWith('tmc-token.'));
  const token = websocket
    ? (protocols.includes('tmc-terminal') && tokens.length === 1 ? tokens[0]!.slice('tmc-token.'.length) : null)
    : headers.get('x-tmc-token');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return 401;
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(access.token))) return 401;
}

// This is only the upgrade gate. No PTY or WebSocket session is created yet.
export function terminalUpgradeGate(access: LocalAccess) {
  return (request: IncomingMessage, socket: Duplex) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    const denied = localAccessError(headers, access, { websocket: true });
    const status = denied ?? (request.url === '/api/terminal/socket' ? 501 : 404);
    const reason = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 501: 'Not Implemented' }[status];
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
}

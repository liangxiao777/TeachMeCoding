import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import type { Terminals } from '../runtime/terminals.js';

export function createLocalAccess({ port, hostname = '127.0.0.1', development = false, webPort = 5173 }: { port: number; hostname?: string; development?: boolean; webPort?: number }) {
  const ports = development ? [port, webPort] : [port];
  const addresses = ['127.0.0.1', 'localhost'];
  if (hostname === '0.0.0.0') {
    addresses.push(...Object.values(os.networkInterfaces()).flatMap((entries) =>
      (entries ?? []).filter((entry) => entry.family === 'IPv4').map((entry) => entry.address)));
  }
  const hosts = new Set(ports.flatMap((value) => addresses.map((address) => `${address}:${value}`)));
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

export function terminalUpgradeGate(access: LocalAccess, terminals?: Terminals, validateSpace?: (space: string) => unknown) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    const denied = localAccessError(headers, access, { websocket: true });
    const url = new URL(request.url ?? '/', 'http://localhost');
    let status: number = denied ?? (url.pathname === '/api/terminal/socket' ? terminals ? 400 : 501 : 404);
    if (!denied && terminals && url.pathname === '/api/terminal/socket') {
      const space = url.searchParams.get('space') ?? '';
      try {
        if (!validateSpace) throw new Error();
        validateSpace(space);
        terminals.sockets.handleUpgrade(request, socket, head, (client) => terminals.attach(space, client));
        return;
      } catch { status = 400; }
    }
    const reason = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 501: 'Not Implemented' } as Record<number, string>)[status];
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
}

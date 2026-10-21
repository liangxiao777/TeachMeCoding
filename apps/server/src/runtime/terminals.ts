import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { TerminalEvent } from '@teach-me-coding/contracts';
import { terminalEnvironment } from './terminal-env.js';
import { descendants, stopProcesses } from './processes.js';

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), id: z.string(), data: z.string().max(65536) }).strict(),
  z.object({ type: z.literal('resize'), id: z.string(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }).strict(),
  z.object({ type: z.literal('stop'), id: z.string() }).strict(),
  z.object({ type: z.literal('restart'), id: z.string() }).strict(),
]);
type Session = { id: string; pty: IPty; output: string; exit: { exitCode: number; signal?: number } | null; done: Promise<void>; stopping: boolean };
const outputLimit = 256 * 1024;

export class Terminals {
  readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 70_000, handleProtocols: () => 'tmc-terminal' });
  private sessions = new Map<string, Session>();
  private clients = new Map<string, Set<WebSocket>>();
  private closing = false;
  private cleanups = new Set<Promise<void>>();
  constructor(private directory: (space: string) => string) {}
  private send(socket: WebSocket, event: TerminalEvent) {
    // A disconnected/slow reader must not hold unbounded output in server memory.
    if (socket.bufferedAmount > outputLimit * 2) return socket.terminate();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }
  private broadcast(space: string, event: TerminalEvent) { for (const client of this.clients.get(space) ?? []) this.send(client, event); }
  private start(space: string): Session {
    if (this.closing) throw new Error('SERVICE_CLOSING');
    // Do not source user shell startup files, which can reintroduce credentials.
    const pty = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
      name: 'xterm-256color', cwd: this.directory(space), cols: 80, rows: 24,
      env: { ...terminalEnvironment(process.env), PS1: '$ ', HISTFILE: '/dev/null', BASH_SILENCE_DEPRECATION_WARNING: '1',
        PROMPT_COMMAND: `trap 'for job in $(jobs -pr); do kill -KILL -- -"$job" 2>/dev/null; done' EXIT; unset PROMPT_COMMAND` },
    });
    let resolve!: () => void;
    const session: Session = { id: randomUUID(), pty, output: '', exit: null, stopping: false, done: new Promise((r) => { resolve = r; }) };
    this.sessions.set(space, session);
    // The initial prompt installs an EXIT trap for background process groups.
    // Deliberately detached daemons are not isolated by a local shell.
    pty.onData((data) => {
      session.output = (session.output + data).slice(-outputLimit);
      this.broadcast(space, { type: 'data', id: session.id, data });
    });
    pty.onExit((event) => {
      session.exit = event;
      this.broadcast(space, { type: 'exit', id: session.id, exitCode: event.exitCode, signal: event.signal || null });
      resolve();
    });
    return session;
  }
  private snapshot(socket: WebSocket, session: Session) {
    this.send(socket, { type: 'snapshot', id: session.id, output: session.output, state: session.exit ? 'exited' : 'running',
      exitCode: session.exit?.exitCode ?? null, signal: session.exit?.signal || null });
  }
  attach(space: string, socket: WebSocket) {
    if (this.closing) return socket.close(1012);
    const clients = this.clients.get(space) ?? new Set<WebSocket>();
    this.clients.set(space, clients); clients.add(socket);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clients.delete(socket); }); // Disconnect is not process termination.
    try { this.snapshot(socket, this.sessions.get(space) ?? this.start(space)); }
    catch { this.send(socket, { type: 'error', error: { code: 'TERMINAL_START_FAILED' } }); socket.close(1011); return; }
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error();
        const message = messageSchema.parse(JSON.parse(raw.toString()));
        const session = this.sessions.get(space)!;
        if (message.id !== session.id) throw new Error();
        if (message.type === 'restart') {
          if (!session.exit) throw new Error();
          const next = this.start(space);
          for (const client of clients) this.snapshot(client, next);
        } else if (message.type === 'stop') this.stop(session);
        else if (!session.exit && !session.stopping) {
          if (message.type === 'input') session.pty.write(message.data);
          else session.pty.resize(message.cols, message.rows);
        }
      } catch { this.send(socket, { type: 'error', error: { code: 'TERMINAL_REQUEST_OUTDATED' } }); }
    });
  }
  private stop(session: Session) {
    if (session.exit || session.stopping) return;
    session.stopping = true;
    const done = stopProcesses(descendants(session.pty.pid)).then(() => session.done);
    this.cleanups.add(done); void done.finally(() => this.cleanups.delete(done));
  }
  async close() {
    this.closing = true;
    for (const session of this.sessions.values()) this.stop(session);
    for (const clients of this.clients.values()) for (const socket of clients) socket.terminate();
    await Promise.all(this.cleanups);
    this.sockets.close();
  }
}

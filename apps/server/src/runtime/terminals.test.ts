import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { WebSocket } from 'ws';
import type { TerminalEvent } from '@teach-me-coding/contracts';
import { Terminals } from './terminals.js';
import { createLocalAccess, terminalUpgradeGate } from '../http/local-access.js';

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('Expected terminal event did not arrive');
}
test('protected PTY restores one process, resizes, exits, rejects stale input and cleans foreground/background children', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-terminals-'));
  const terminals = new Terminals(() => root), server = createServer();
  const clients: WebSocket[] = [];
  t.after(async () => { clients.forEach((c) => c.terminate()); await terminals.close(); await new Promise<void>((r) => server.close(() => r())); rmSync(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const access = createLocalAccess({ port });
  server.on('upgrade', terminalUpgradeGate(access, terminals, (space) => { assert.equal(space, 'test-space'); }));
  const connect = () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/socket?space=test-space`, ['tmc-terminal', `tmc-token.${access.token}`], { origin: `http://127.0.0.1:${port}` });
    const events: TerminalEvent[] = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString()))); clients.push(socket);
    return { socket, events, output: () => stripVTControlCharacters(events.map((e) => e.type === 'data' ? e.data : e.type === 'snapshot' ? e.output : '').join('')) };
  };
  const denied = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/socket?space=test-space`, ['tmc-terminal'], { origin: `http://127.0.0.1:${port}` });
  denied.on('error', () => {});
  const [request, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.resume(); request.destroy(); denied.terminate();
  assert.equal((terminals as unknown as { sessions: Map<string, unknown> }).sessions.size, 0);
  process.env.TMC_SYNTHETIC_SECRET = 'must-not-reach-pty';
  const first = connect();
  await until(() => first.events.some((e) => e.type === 'snapshot'));
  delete process.env.TMC_SYNTHETIC_SECRET;
  const snapshot = first.events.find((e) => e.type === 'snapshot')!;
  assert.equal(snapshot.type, 'snapshot');
  const id = snapshot.id;
  const send = (socket: WebSocket, type: string, rest = {}) => socket.send(JSON.stringify({ type, id, ...rest }));
  send(first.socket, 'resize', { cols: 103, rows: 37 });
  // Git Bash's $$ is an MSYS PID, not a native PID usable by process.kill.
  send(first.socket, 'input', { data: `node -e 'console.log("PID="+process.ppid); console.log(process.stdout.rows+" "+process.stdout.columns)'; printenv TMC_SYNTHETIC_SECRET; printf 'SECRET_STATUS=%s\\n' $?; pwd\r` });
  await until(() => /SECRET_STATUS=1\r?\n/.test(first.output()));
  assert.match(first.output(), /37 103/);
  assert.ok(!first.output().includes('must-not-reach-pty'));
  const pid = Number(first.output().match(/PID=(\d+)/)![1]);
  first.socket.close(); await once(first.socket, 'close');
  process.kill(pid, 0);
  const restored = connect(); await until(() => restored.events.some((e) => e.type === 'snapshot'));
  const replay = restored.events[0]!;
  assert.equal(replay.type, 'snapshot'); if (replay.type !== 'snapshot') return;
  assert.equal(replay.id, id); assert.match(replay.output, /37 103/);
  send(restored.socket, 'input', { data: 'exit 7\r' });
  await until(() => restored.events.some((e) => e.type === 'exit'));
  assert.equal(restored.events.find((e) => e.type === 'exit')!.exitCode, 7);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const exited = connect(); await until(() => exited.events.some((e) => e.type === 'snapshot'));
  assert.equal((exited.events[0] as typeof replay).state, 'exited');
  send(restored.socket, 'restart'); await until(() => restored.events.some((e) => e.type === 'snapshot' && e.id !== id));
  send(restored.socket, 'input', { data: 'touch must-not-exist\r' });
  await until(() => restored.events.some((e) => e.type === 'error'));
  const current = restored.events.find((e) => e.type === 'snapshot' && e.id !== id)!;
  if (current.type !== 'snapshot') return;
  restored.socket.send(JSON.stringify({ type: 'input', id: current.id,
    data: `node -e 'require("node:fs").writeFileSync("background.pid", String(process.pid)); setInterval(()=>{},1000)' & node -e 'require("node:fs").writeFileSync("foreground.pid", String(process.pid)); setInterval(()=>{},1000)'\r` }));
  let pids: number[] = [];
  await until(() => { try { pids = ['background.pid', 'foreground.pid'].map((p) => Number(readFileSync(join(root, p), 'utf8'))); return pids.every(Boolean); } catch { return false; } });
  await terminals.close();
  for (const child of pids) await until(() => { try { process.kill(child, 0); return false; } catch { return true; } });
  assert.throws(() => readFileSync(join(root, 'must-not-exist')), { code: 'ENOENT' });
});

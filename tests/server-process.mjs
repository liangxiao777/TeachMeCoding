import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { terminalEnvironment } from '../apps/server/dist/runtime/terminal-env.js';

export function spawnServer(entry, options, args = []) {
  return spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/server-signals.mjs', import.meta.url)), entry, ...args], {
    ...options,
    env: { ...terminalEnvironment(process.env), ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'], ...options.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

export function stopServer(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (signal === 'SIGKILL') child.kill(signal);
  else child.send('shutdown');
}

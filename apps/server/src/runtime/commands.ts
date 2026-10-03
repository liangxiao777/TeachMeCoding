import { spawn } from 'node:child_process';
import type { CommandResult } from '@teach-me-coding/contracts';
import { terminalEnvironment } from './terminal-env.js';
import { descendants, groupMembers, stopProcesses } from './processes.js';

export const executionLimits = { milliseconds: 30_000, outputBytes: 256 * 1024 };

/** Finite local commands, distinct from an interactive PTY. No startup scripts. */
export async function runCommand(command: string, cwd: string, signal: AbortSignal, limits = executionLimits): Promise<CommandResult> {
  if (signal.aborted) return { status: 'cancelled', output: '', exitCode: null, signal: null };
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, env: terminalEnvironment(process.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), status: CommandResult['status'] | undefined, cleanup: Promise<void> | undefined;
    const stop = (reason: CommandResult['status']) => {
      if (status) return;
      status = reason;
      if (child.pid) {
        cleanup = stopProcesses([...new Set([...descendants(child.pid), ...groupMembers(child.pid)])]);
      }
    };
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('timed-out'), limits.milliseconds);
    const data = (value: Buffer) => {
      const remaining = limits.outputBytes - output.length;
      output = Buffer.concat([output, value.subarray(0, remaining)]);
      if (value.length > remaining) stop('output-limit');
    };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.on('error', () => { status = signal.aborted ? 'cancelled' : 'unavailable'; });
    // Kill remaining members of the detached process group even on normal
    // shell exit, so a background writer cannot outlive the operation.
    child.on('exit', () => { if (child.pid && !cleanup) cleanup = stopProcesses(groupMembers(child.pid)); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      void (async () => {
        await cleanup;
        resolve({ status: status ?? (code === 0 ? 'succeeded' : code === 127 ? 'unavailable' : 'failed'), output: output.toString('utf8'), exitCode: code, signal: exitSignal });
      })();
    });
  });
}

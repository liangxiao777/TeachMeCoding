import { spawn } from 'node:child_process';
import type { CommandResult } from '@teach-me-coding/contracts';
import { bashShell } from './shell.js';
import { stopProcessTree } from './processes.js';

export const executionLimits = { milliseconds: 30_000, outputBytes: 256 * 1024 };

/** Finite local commands, distinct from an interactive PTY. No startup scripts. */
export async function runCommand(command: string, cwd: string, signal: AbortSignal, limits = executionLimits): Promise<CommandResult> {
  if (signal.aborted) return { status: 'cancelled', output: '', exitCode: null, signal: null };
  let shell: ReturnType<typeof bashShell>;
  try { shell = bashShell(); }
  catch { return { status: 'unavailable', output: '', exitCode: null, signal: null, error: { code: 'LOCAL_EXECUTION_UNAVAILABLE' } }; }
  return new Promise((resolve, reject) => {
    const child = spawn(shell.file, [...shell.args, '-c', command], { cwd, env: shell.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), status: CommandResult['status'] | undefined, cleanup: Promise<void> | undefined;
    let error: CommandResult['error'];
    const stop = (reason: CommandResult['status']) => {
      if (status) return;
      status = reason;
      if (child.pid) {
        cleanup = stopProcessTree(child.pid);
        void cleanup.catch(() => {}); // Await and report it when stdio closes.
      }
    };
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('timed-out'), limits.milliseconds);
    const data = (value: Buffer, channel: 'stdout' | 'stderr') => {
      const remaining = limits.outputBytes - output.length;
      const chunk = value.subarray(0, remaining);
      output = Buffer.concat([output, chunk]);
      if (channel === 'stdout') stdout = Buffer.concat([stdout, chunk]); else stderr = Buffer.concat([stderr, chunk]);
      if (value.length > remaining) stop('output-limit');
    };
    child.stdout.on('data', (v: Buffer) => data(v, 'stdout')); child.stderr.on('data', (v: Buffer) => data(v, 'stderr'));
    child.on('error', () => { status = signal.aborted ? 'cancelled' : 'unavailable'; if (!signal.aborted) error = { code: 'LOCAL_EXECUTION_UNAVAILABLE' }; });
    // Kill remaining members of the detached process group even on normal
    // shell exit, so a background writer cannot outlive the operation.
    child.on('exit', () => {
      clearTimeout(timer);
      if (child.pid && !cleanup) { cleanup = stopProcessTree(child.pid, true); void cleanup.catch(() => {}); }
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      void (async () => {
        await cleanup;
        return { status: status ?? (code === 0 ? 'succeeded' : code === 127 ? 'unavailable' : 'failed'), output: output.toString('utf8'), stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: code, signal: exitSignal, ...(error ? { error } : {}) } satisfies CommandResult;
      })().then(resolve, reject);
    });
  });
}

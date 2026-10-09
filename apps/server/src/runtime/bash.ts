import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { descendants, groupMembers, stopProcesses } from './processes.js';
import { terminalEnvironment } from './terminal-env.js';

// A disk-safety ceiling, distinct from Pi's 50 KiB model-facing display limit.
export const bashOutputLimit = 32 * 1024 * 1024;

/** Pi owns schemas, snapshots and output continuation; the host owns processes. */
export const bashOperations: BashOperations = {
  async exec(command, cwd, { onData, signal, timeout }) {
    if (signal?.aborted) throw new Error('aborted');
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
      throw new Error('Invalid timeout: use positive seconds, at most 2147483.647.');
    }
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
        cwd, env: terminalEnvironment(process.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bytes = 0, reason: 'aborted' | 'timeout' | 'output-limit' | undefined;
      let cleanup: Promise<void> | undefined, spawnError: Error | undefined;
      const stop = () => {
        if (child.pid && !cleanup) cleanup = stopProcesses([...new Set([...descendants(child.pid), ...groupMembers(child.pid)])]);
      };
      const abort = () => { reason ??= 'aborted'; stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = timeout === undefined ? undefined : setTimeout(() => { reason ??= 'timeout'; stop(); }, timeout * 1000);
      const data = (chunk: Buffer) => {
        if (reason) return;
        const remaining = bashOutputLimit - bytes;
        bytes += Math.min(remaining, chunk.length);
        onData(chunk.subarray(0, remaining));
        if (chunk.length > remaining) { reason = 'output-limit'; stop(); }
      };
      child.stdout.on('data', data); child.stderr.on('data', data);
      child.on('error', (error) => { spawnError = error; });
      // Reap background jobs on success as well as on stop. No detached jobs
      // are intentionally left running by an Agent tool invocation.
      child.on('exit', () => {
        if (timer) clearTimeout(timer);
        if (child.pid && !cleanup) cleanup = stopProcesses(groupMembers(child.pid));
      });
      child.on('close', (code, exitSignal) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void (async () => {
          await cleanup;
          if (signal?.aborted || reason === 'aborted') throw new Error('aborted');
          if (reason === 'timeout') throw new Error(`timeout:${timeout}`);
          if (spawnError) throw spawnError;
          if (reason === 'output-limit') {
            onData(Buffer.from('\n[Command stopped: raw output exceeded the 32 MiB disk-safety limit.]\n'));
            return { exitCode: 1 };
          }
          return { exitCode: code ?? (exitSignal ? 128 + (constants.signals[exitSignal] ?? 0) : 1) };
        })().then(resolve, reject);
      });
    });
  },
};

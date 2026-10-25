import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const system32 = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

function processTable() {
  const output = process.platform === 'win32'
    ? execFileSync(join(system32(), 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    : execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  return output.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
}

// Local execution is not a sandbox. Reap the process trees we start, including
// shell jobs with their own process groups. No machine-wide process matching.
export function descendants(root: number): number[] {
  const rows = processTable();
  const found = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (pid && parent && found.has(parent) && !found.has(pid)) { found.add(pid); changed = true; }
  }
  return [...found].reverse();
}
export function groupMembers(group: number): number[] {
  // Windows retains ParentProcessId after the parent exits. This also finds
  // children that keep stdio open after a wrapper's normal exit.
  if (process.platform === 'win32') return descendants(group);
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .flatMap(([pid, pgid]) => pid && pgid === group ? [pid] : []);
}
export function signalProcess(pid: number, signal: NodeJS.Signals) {
  try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export async function stopProcessTree(root: number, exited = false) {
  try {
    const pids = exited ? groupMembers(root)
      : [...new Set([...descendants(root), ...(process.platform === 'win32' ? [] : groupMembers(root))])];
    await stopProcesses(pids);
  } catch (error) {
    // Discovery failures must reject the operation, not escape an abort/exit
    // event handler or leave its direct child running indefinitely.
    signalProcess(root, 'SIGKILL');
    throw error;
  }
}
export async function stopProcesses(pids: number[]) {
  if (!pids.length) return;
  if (process.platform === 'win32') {
    // Node signals kill only one Windows process. taskkill /T includes native
    // children and .cmd wrappers; explicit descendants cover an exited parent.
    await new Promise<void>((resolve, reject) => {
      execFile(join(system32(), 'taskkill.exe'), ['/F', '/T', ...pids.flatMap((pid) => ['/PID', String(pid)])],
        { windowsHide: true, timeout: 10_000 }, (error) => {
          const alive = pids.some((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } });
          if (error && alive) reject(error); else resolve();
        });
    });
    return;
  }
  for (const pid of pids) signalProcess(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of pids) signalProcess(pid, 'SIGKILL');
}

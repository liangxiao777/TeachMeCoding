import { execFileSync } from 'node:child_process';

// Local execution is not a sandbox. Reap the process trees we start, including
// shell jobs with their own process groups. No machine-wide process matching.
export function descendants(root: number): number[] {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (pid && parent && found.has(parent) && !found.has(pid)) { found.add(pid); changed = true; }
  }
  return [...found].reverse();
}
export function groupMembers(group: number): number[] {
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
      : [...new Set([...descendants(root), ...groupMembers(root)])];
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
  for (const pid of pids) signalProcess(pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of pids) signalProcess(pid, 'SIGKILL');
}

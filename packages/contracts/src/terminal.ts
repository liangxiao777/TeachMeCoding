export type TerminalEvent =
  | { type: 'snapshot'; id: string; output: string; state: 'running' | 'exited'; exitCode: number | null; signal: number | null }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal: number | null }
  | { type: 'error'; message: string };

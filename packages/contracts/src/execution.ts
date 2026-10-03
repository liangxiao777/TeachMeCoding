import { z } from 'zod';

export interface CommandResult {
  status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'output-limit' | 'unavailable';
  output: string; exitCode: number | null; signal: string | null;
}
export const fileProposalSchema = z.object({ path: z.string().min(1).max(1000), content: z.string().max(1_000_000), reason: z.string().min(1).max(2000) }).strict();
export const commandProposalSchema = z.object({ command: z.string().min(1).max(20_000), reason: z.string().min(1).max(2000) }).strict();
export interface ActionProposal {
  id: string; sessionId: string; runId: string; digest: string; createdAt: number; expiresAt: number;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'expired' | 'cancelled' | 'interrupted';
  action: ({ kind: 'file'; path: string; before: string | null; version: string | null; content: string }
    | { kind: 'command'; command: string; projectVersion: string }) & { reason: string; cwd: string };
  result: CommandResult | null;
}
export const actionDecisionSchema = z.object({ decision: z.enum(['confirm', 'reject', 'cancel']), digest: z.string().min(1) }).strict();

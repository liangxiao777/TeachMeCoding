import { z } from 'zod';

export interface CommandResult {
  status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'output-limit' | 'unavailable';
  output: string; exitCode: number | null; signal: string | null;
  stdout?: string; stderr?: string;
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

export const codePlanSchema = z.object({
  language: z.enum(['python', 'javascript', 'typescript', 'rust', 'bash']),
  cases: z.array(z.object({ args: z.array(z.string().max(1000)).max(30), expected: z.string().max(20_000) }).strict()).min(1).max(20),
}).strict();
export type CodePlan = z.infer<typeof codePlanSchema>;
export const codeRunInputSchema = z.object({ specRevision: z.number().int().positive(), code: z.string().max(100_000) }).strict();
const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const codeFile = (plan: CodePlan) => `answer.${({ python: 'py', javascript: 'js', typescript: 'ts', rust: 'rs', bash: 'sh' })[plan.language]}`;
export function codeCommands(plan: CodePlan): string[] {
  const file = codeFile(plan);
  const command = ({ python: `python3 -I ${file}`, javascript: `node ${file}`, typescript: `node ${file}`, rust: `rustc --edition=2021 ${file} -o answer && ./answer`, bash: `/bin/bash --noprofile --norc ${file}` })[plan.language];
  return plan.cases.map((c) => `${command}${c.args.length ? ' ' + c.args.map(shellArg).join(' ') : ''}`);
}
export interface CodeExecution {
  id: string; unitId: string; submissionId: string | null; specRevision: number; createdAt: number;
  code: string; codeHash: string; plan: CodePlan; commands: string[];
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  error?: string;
  results: { command: string; expected: string; matches: boolean; result: CommandResult }[];
}

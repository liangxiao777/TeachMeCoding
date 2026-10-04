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

/** Learner-facing observations, not a judgment of understanding or a replacement for the evidence. */
export function executionFeedback(execution: CodeExecution): { summary: string; nextStep?: string } {
  if (execution.state === 'pending') return { summary: '正在准备运行本次提交的代码。' };
  if (execution.state === 'running') return { summary: '正在检查代码，完成后会显示结果。' };
  if (execution.state === 'interrupted') return { summary: '本次运行已停止，代码检查未完成。', nextStep: '准备好后重新运行或提交测评。停止不会撤销程序已做的操作，也不会自动重跑。' };
  const failure = execution.results.find((r) => r.result.status !== 'succeeded')?.result.status;
  if (failure === 'unavailable') return { summary: '本机缺少运行这段代码所需的环境，尚不能判断代码是否符合要求。', nextStep: '检查本机工具是否已安装、能否在命令行使用，再重新运行。系统不会自动安装。' };
  if (failure === 'timed-out') return { summary: '程序超过运行时限，代码检查未完成。', nextStep: '检查是否存在无法结束的循环或等待，再重新运行。' };
  if (failure === 'output-limit') return { summary: '程序输出过多，已停止检查。', nextStep: '检查是否反复打印了不必要的内容，修改后重新运行。' };
  if (failure === 'cancelled') return { summary: '本次运行已停止，代码检查未完成。', nextStep: '准备好后重新运行或提交测评。停止不会撤销程序已做的操作，也不会自动重跑。' };
  if (failure === 'failed') return { summary: '程序报错，尚未完成这道题的运行检查。', nextStep: '打开运行详情查看报错位置，修改后先试运行，再提交测评。' };
  if (execution.state !== 'succeeded' || execution.results.length !== execution.plan.cases.length) return { summary: '本次运行未能完成，暂时不能判断代码是否符合要求。', nextStep: '打开运行详情检查原因，处理后重新运行。' };
  const wrong = execution.results.filter((r) => !r.matches).length;
  return wrong
    ? { summary: `有 ${wrong} 项检查的输出与题目要求不一致。`, nextStep: '对照下面的输入、题目要求和实际输出修改代码，试运行确认后重新提交测评。' }
    : { summary: `代码通过了本题的 ${execution.results.length} 项运行检查，只代表列出的输入得到了预期输出。` };
}

import { executionFeedback, type CodeExecution } from '@teach-me-coding/contracts'

const statusLabels = { succeeded: '正常结束', failed: '程序报错', 'timed-out': '超过运行时限', cancelled: '已停止', 'output-limit': '输出过多', unavailable: '运行环境缺失' }
const output = (text: string) => {
  const value = text.replaceAll('\r\n', '\n').replace(/\n$/, '')
  // Make significant whitespace visible instead of making different outputs look identical.
  return !value ? '（无输出）' : value.trim() !== value || /[\n\t]/.test(value) ? JSON.stringify(value) : value
}

export function ExecutionResult({ execution: e, showSummary = true }: { execution: CodeExecution; showSummary?: boolean }) {
  const feedback = executionFeedback(e)
  return <div className="space-y-3 rounded-xl border bg-card p-4 text-sm leading-relaxed" data-testid="code-execution">
    <p className="font-medium">代码运行情况</p>
    {showSummary && <p>{feedback.summary}</p>}
    {!e.submissionId && <p className="text-muted-foreground">这是一次试运行，不会产生测评结论或改变学习进度。</p>}
    {e.results.length > 0 && <ul className="space-y-3">
      {e.results.map((r, i) => <li key={i} className="border-l-2 pl-3">
        <p className="line-clamp-3 break-words">检查 {i + 1} · {e.plan.cases[i]!.args.length ? `传入参数：${e.plan.cases[i]!.args.map((arg) => JSON.stringify(arg)).join('、')}` : '不传入参数'}</p>
        {r.result.status === 'succeeded' ? r.matches
          ? <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground">输出：{output(r.result.stdout ?? '')}，符合题目要求。</p>
          : <><p className="line-clamp-3 whitespace-pre-wrap break-words">题目要求输出：{output(r.expected)}</p><p className="line-clamp-3 whitespace-pre-wrap break-words">实际输出：{output(r.result.stdout ?? '')}</p></>
          : <p className="text-muted-foreground">{statusLabels[r.result.status]}，未完成此项检查。</p>}
      </li>)}
    </ul>}
    {!e.submissionId && feedback.nextStep && <p>{feedback.nextStep}</p>}
    <details key={e.id}>
      <summary className="cursor-pointer text-muted-foreground">运行详情（命令与完整输出）</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p>在本机运行，不是沙箱；以下结果只对应{e.submissionId ? '本次提交的代码，不包含之后的新草稿' : '点击运行时的代码'}。</p>
        {e.error && <p role="alert">{e.error}</p>}
        {e.results.map((r, i) => <div key={i}>
          <p>检查 {i + 1} · {statusLabels[r.result.status]} · 退出码 {r.result.exitCode ?? '无'}</p>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{`$ ${r.command}\n标准输出：\n${r.result.stdout ?? ''}\n错误输出：\n${r.result.stderr ?? ''}\n题目要求输出：\n${r.expected}`}</pre>
        </div>)}
      </div>
    </details>
  </div>
}

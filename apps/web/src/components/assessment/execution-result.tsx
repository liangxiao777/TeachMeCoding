import type { CodeExecution } from '@teach-me-coding/contracts'

export function ExecutionResult({ execution: e }: { execution: CodeExecution }) {
  return <div className="space-y-2 rounded-lg border p-3 text-xs" data-testid="code-execution">
    <p>本机执行 · {{ pending: '等待执行', running: '执行中', succeeded: '执行完成', failed: '执行失败', interrupted: '已取消或中断' }[e.state]}</p>
    <p className="break-all font-mono">代码 SHA-256：{e.codeHash}</p>
    <p className="text-muted-foreground">执行 ID：{e.id} · 题目版本 {e.specRevision} · {e.submissionId ? '固定测评提交' : '练习运行，不是测评结论'}</p>
    {e.error && <p role="alert">{e.error}</p>}
    {e.results.map((r, i) => <details key={i} open>
      <summary>用例 {i + 1} · {r.result.status} · 退出码 {r.result.exitCode ?? '无'} · {r.matches ? '输出匹配' : '未匹配'}</summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{`$ ${r.command}\n标准输出：\n${r.result.stdout ?? ''}\n错误输出：\n${r.result.stderr ?? ''}\n期望：\n${r.expected}`}</pre>
    </details>)}
    {e.state === 'failed' && <p>缺少工具链请自行检查安装/PATH；程序未正常完成不代表能力不合格。</p>}
    {e.state === 'interrupted' && <p>没有自动重放。取消不能撤销已有副作用；重新运行需要再次点击。</p>}
  </div>
}

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { MessageSquareQuote, Square, TerminalSquare, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/app/context'
import '@xterm/xterm/css/xterm.css'

/** Real transport in the original IDE panel; preview keeps its isolated runner. */
export function LocalTerminalView() {
  const { localTerminal: client, setQuote } = useApp()
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [exit, setExit] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!client || !host.current) return
    const term = new Terminal({ fontFamily: 'Geist Mono Variable, monospace', fontSize: 13, cursorBlink: true,
      scrollback: 3000, theme: { background: '#171923', foreground: '#d4d4dc', cursor: '#d4d4dc' } })
    const fit = new FitAddon()
    term.loadAddon(fit); term.open(host.current); terminal.current = term
    term.textarea?.setAttribute('aria-label', '本机终端输入')
    const resize = () => {
      if (host.current?.clientWidth && host.current.clientHeight) {
        fit.fit(); client.send('resize', { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) })
      }
    }
    const observer = new ResizeObserver(resize); observer.observe(host.current)
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'snapshot') { term.reset(); term.write(event.output); setExit(event.state === 'exited' ? `终端已退出：${event.exitCode}（信号 ${event.signal ?? '无'}）` : null); resize() }
      if (event.type === 'data') term.write(event.data)
      if (event.type === 'exit') setExit(`终端已退出：${event.exitCode}（信号 ${event.signal ?? '无'}）`)
      if (event.type === 'error') setError(event.message)
    })
    const input = term.onData((data) => { if (!client.send('input', { data })) setError('连接中断，输入未发送；请重连后重新输入。') })
    void client.connect()
    return () => { unsubscribe(); input.dispose(); observer.disconnect(); term.dispose(); terminal.current = null }
  }, [client])
  return <>
    <div className="flex h-9 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TerminalSquare className="size-3.5" />终端 · 本机</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-xs" aria-label="引用终端输出" onClick={() => {
          const term = terminal.current
          const text = term?.getSelection() || (term ? Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n').trim() : '')
          if (text) setQuote({ source: 'terminal', label: '本机终端输出', text })
        }}><MessageSquareQuote /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="清空终端" onClick={() => terminal.current?.clear()}><Trash2 /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="停止终端" disabled={!!exit} onClick={() => client?.send('stop')}><Square /></Button>
      </div>
    </div>
    <p className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">使用本机账号权限，非沙箱；不会自动安装工具链。收起/断线不停止进程，停止不撤销已有修改。</p>
    {error && <p role="alert" className="px-3 py-1 text-xs text-destructive">{error}</p>}
    {exit && <div role="status" className="flex items-center gap-2 px-3 py-1 text-xs"><span>{exit}</span><Button size="xs" variant="outline" onClick={() => { setError(''); client?.send('restart') }}>新建终端</Button></div>}
    <div ref={host} aria-label="本机终端" className="min-h-0 flex-1 overflow-hidden p-2" />
  </>
}

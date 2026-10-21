import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { formatNotice, type NoticeValue } from '@/i18n/notice'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { MessageSquareQuote, Square, TerminalSquare, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/app/context'
import '@xterm/xterm/css/xterm.css'

/** Real transport in the original IDE panel; preview keeps its isolated runner. */
export function LocalTerminalView() {
  const { t } = useTranslation('workbench')
  const { localTerminal: client, setQuote } = useApp()
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const [exit, setExit] = useState<{ exitCode: number | null; signal: number | null } | null>(null)
  const [error, setError] = useState<NoticeValue>(null)
  useEffect(() => {
    if (!client || !host.current) return
    const term = new Terminal({ fontFamily: 'Geist Mono Variable, monospace', fontSize: 13, cursorBlink: true,
      scrollback: 3000, theme: { background: '#171923', foreground: '#d4d4dc', cursor: '#d4d4dc' } })
    const fit = new FitAddon()
    term.loadAddon(fit); term.open(host.current); terminal.current = term
    term.textarea?.setAttribute('aria-label', i18n.t('terminal.input', { ns: 'workbench' }))
    const resize = () => {
      if (host.current?.clientWidth && host.current.clientHeight) {
        fit.fit(); client.send('resize', { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) })
      }
    }
    const observer = new ResizeObserver(resize); observer.observe(host.current)
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'snapshot') { term.reset(); term.write(event.output); setExit(event.state === 'exited' ? { exitCode: event.exitCode, signal: event.signal } : null); resize() }
      if (event.type === 'data') term.write(event.data)
      if (event.type === 'exit') setExit({ exitCode: event.exitCode, signal: event.signal })
      if (event.type === 'error') setError(event.error)
      if (event.type === 'notice') setError(event.notice)
    })
    const input = term.onData((data) => { void client.input(data).then((sent) => { if (sent) setError(null) }) })
    void client.connect()
    return () => { unsubscribe(); input.dispose(); observer.disconnect(); term.dispose(); terminal.current = null }
  }, [client])
  // Changing UI language must not reconnect or reset the terminal transport.
  useEffect(() => { terminal.current?.textarea?.setAttribute('aria-label', t('terminal.input')) }, [client, t])
  return <>
    <div className="flex h-9 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TerminalSquare className="size-3.5" />{t('terminal.title')}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-xs" aria-label={t('ide.quoteTerminal')} onClick={() => {
          const term = terminal.current
          const text = term?.getSelection() || (term ? Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n').trim() : '')
          if (text) setQuote({ source: 'terminal', label: t('ide.terminalOutput'), caption: { kind: 'terminal' }, text })
        }}><MessageSquareQuote /></Button>
        <Button variant="ghost" size="icon-xs" aria-label={t('ide.clearTerminal')} onClick={() => terminal.current?.clear()}><Trash2 /></Button>
        <Button variant="ghost" size="icon-xs" aria-label={t('terminal.stop')} disabled={!!exit} onClick={() => client?.send('stop')}><Square /></Button>
      </div>
    </div>
    {error && <p role="alert" className="px-3 py-1 text-xs text-destructive">{formatNotice(error)}</p>}
    {exit && <div role="status" className="flex items-center gap-2 px-3 py-1 text-xs"><span>{t('terminal.exited', { code: String(exit.exitCode), signal: exit.signal ?? t('terminal.none') })}</span><Button size="xs" variant="outline" onClick={() => { setError(null); client?.send('restart') }}>{t('terminal.new')}</Button></div>}
    <div ref={host} aria-label={t('terminal.region')} className="min-h-0 flex-1 overflow-hidden p-2" />
  </>
}

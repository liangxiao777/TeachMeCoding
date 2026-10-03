import type { TerminalEvent } from '@teach-me-coding/contracts'
import { access } from './api'

export class LocalTerminal {
  private socket?: WebSocket
  private listeners = new Set<(event: TerminalEvent) => void>()
  private reconnect?: ReturnType<typeof setTimeout>
  private disposed = false
  private connecting = false
  private attached = false
  private generation = 0
  snapshot: Extract<TerminalEvent, { type: 'snapshot' }> | null = null
  constructor(private space: string, private status: (connected: boolean) => void, private inputAllowed: () => boolean) {}
  subscribe(receive: (event: TerminalEvent) => void) {
    this.listeners.add(receive)
    if (this.snapshot) receive(this.snapshot)
    return () => { this.listeners.delete(receive) }
  }
  private emit(event: TerminalEvent) { for (const receive of this.listeners) receive(event) }
  async connect() {
    if (this.disposed || this.connecting || this.socket?.readyState === WebSocket.OPEN) return
    this.connecting = true; this.attached = false
    const generation = ++this.generation
    clearTimeout(this.reconnect)
    try {
      const token = await access(true)
      if (this.disposed || generation !== this.generation) return
      const url = new URL(`/api/terminal/socket?space=${this.space}`, location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url, ['tmc-terminal', `tmc-token.${token}`])
      const timeout = setTimeout(() => socket.close(), 8000)
      this.socket = socket
      socket.onmessage = ({ data }) => {
        if (generation !== this.generation) return
        const event = JSON.parse(data as string) as TerminalEvent
        if (event.type === 'snapshot') { clearTimeout(timeout); this.attached = true; this.snapshot = event; this.status(true) }
        else if (event.type === 'data' && this.snapshot?.id === event.id) this.snapshot = { ...this.snapshot, output: (this.snapshot.output + event.data).slice(-256 * 1024) }
        else if (event.type === 'exit' && this.snapshot?.id === event.id) this.snapshot = { ...this.snapshot, state: 'exited', exitCode: event.exitCode, signal: event.signal }
        this.emit(event)
      }
      socket.onclose = () => {
        clearTimeout(timeout)
        if (generation !== this.generation || this.disposed) return
        this.connecting = false; this.attached = false; this.status(false)
        this.reconnect = setTimeout(() => { void this.connect() }, 1500)
      }
      socket.onerror = () => socket.close()
      socket.onopen = () => { this.connecting = false }
    } catch {
      this.connecting = false; this.status(false)
      if (!this.disposed) this.reconnect = setTimeout(() => { void this.connect() }, 1500)
    }
  }
  send(type: 'input' | 'resize' | 'stop' | 'restart', values: { data?: string; cols?: number; rows?: number } = {}) {
    if (type === 'input' && values.data !== '\x03' && !this.inputAllowed()) {
      this.emit({ type: 'error', message: '有未保存文件；输入未发送。请先保存全部文件，Ctrl+C 和停止仍可使用。' })
      return false
    }
    // Never queue/replay input across a reconnect or a new shell instance.
    if (this.socket?.readyState !== WebSocket.OPEN || !this.snapshot || !this.attached) {
      if (type === 'input') this.emit({ type: 'error', message: '连接中断，输入未发送；请重连后重新输入。' })
      return false
    }
    this.socket.send(JSON.stringify({ type, id: this.snapshot.id, ...values }))
    return true
  }
  dispose() { this.disposed = true; this.generation++; clearTimeout(this.reconnect); this.socket?.close(); this.listeners.clear() }
}

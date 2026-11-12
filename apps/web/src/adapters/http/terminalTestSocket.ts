import type { TerminalSocket } from './terminalWsAdapter'
/** 协议测试的最小 WS 接缝，不模拟终端渲染。 */
export class TestTerminalSocket implements TerminalSocket {
  readyState = 0
  binaryType = ''
  bufferedAmount = 0
  sent: Array<string | Uint8Array<ArrayBuffer>> = []
  closed?: { code: number; reason: string }
  private listeners = new Map<string, Array<(event: never) => void>>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: ((event: never) => void) | (() => void)): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  emit(type: string, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event as never) }
  open() { this.readyState = 1; this.emit('open') }
  ready(id = 'session-1') { this.open(); this.emit('message', { data: JSON.stringify({ type: 'ready', protocol: 2, session: { id, user: 'root', hostLabel: 'host' } }) }) }
  send(data: string | Uint8Array<ArrayBuffer>) { this.sent.push(data) }
  close(code = 1000, reason = '') { this.readyState = 3; this.closed = { code, reason }; this.emit('close', { code, reason }) }
}

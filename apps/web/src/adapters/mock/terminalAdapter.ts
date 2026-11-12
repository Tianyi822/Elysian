import type { HostTerminalHandlers, HostTerminalSessionInfo, TerminalAdapter } from '../../contracts/adapters'
import { execHostCommand, hostTerminalCompletions, HOST_LABEL, HOST_PROMPT, HOST_USER } from './hostTerminal'

/** 演示只提供确定性命令求值；不模拟字节协议或终端编辑器。 */
export class MockTerminalAdapter implements TerminalAdapter {
  readonly mode = 'repl' as const
  private nextId = 1
  private readonly sessions = new Set<string>()
  reset(): void { this.nextId = 1; this.sessions.clear() }
  async connect(_handlers: HostTerminalHandlers): Promise<HostTerminalSessionInfo> {
    const id = `term-${this.nextId++}`
    this.sessions.add(id)
    return { id, user: HOST_USER, hostLabel: HOST_LABEL, prompt: HOST_PROMPT }
  }
  async sendInput(id: string, _data: Uint8Array): Promise<void> { this.requireSession(id); throw new Error('演示终端不提供真实 PTY') }
  async resize(id: string, _cols: number, _rows: number): Promise<void> { this.requireSession(id) }
  acknowledge(_id: string, _bytes: number): void {}
  async executeCommand(id: string, command: string) { this.requireSession(id); return execHostCommand(command) }
  completions(id: string, input: string): readonly string[] { this.requireSession(id); return hostTerminalCompletions(input) }
  async disconnect(id: string): Promise<void> { this.requireSession(id); this.sessions.delete(id) }
  private requireSession(id: string): void { if (!this.sessions.has(id)) throw new Error(`终端会话不存在 ${id}`) }
}

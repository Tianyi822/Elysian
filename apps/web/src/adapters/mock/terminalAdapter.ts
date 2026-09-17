import type { HostTerminalSessionInfo, MockCommandResult, TerminalAdapter } from '../../contracts/adapters'
import { execHostCommand, HOST_LABEL, HOST_PROMPT, HOST_USER } from './hostTerminal'

/**
 * 本机演示终端适配器：会话只存在内存，刷新或 reset 后作废。
 * 不执行真实 Shell，命令由 hostTerminal 引擎确定性求值。
 */
export class MockTerminalAdapter implements TerminalAdapter {
  private nextId = 1
  private readonly sessions = new Set<string>()

  reset(): void {
    this.nextId = 1
    this.sessions.clear()
  }

  async connect(): Promise<HostTerminalSessionInfo> {
    const id = `term-${this.nextId}`
    this.nextId += 1
    this.sessions.add(id)
    return { id, user: HOST_USER, hostLabel: HOST_LABEL, prompt: HOST_PROMPT }
  }

  async execMockCommand(sessionId: string, command: string): Promise<MockCommandResult> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
    return execHostCommand(command)
  }

  async disconnect(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
    this.sessions.delete(sessionId)
  }
}

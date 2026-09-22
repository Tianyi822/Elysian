import type { TerminalCompletion } from '../../components/terminal/terminalSession'
import type {
  HostTerminalHandlers,
  HostTerminalSessionInfo,
  TerminalAdapter,
} from '../../contracts/adapters'
import {
  completeHostTerminalCommand,
  execHostCommand,
  HOST_LABEL,
  HOST_PROMPT,
  HOST_USER,
} from './hostTerminal'

/**
 * 本机演示终端适配器（流式）：会话只存在内存，刷新或 reset 后作废。
 * 不执行真实 Shell，命令由 hostTerminal 引擎确定性求值并经 output/prompt 帧
 * 流回——帧的形状与真实 WS 适配器一致，store 不区分两者。
 */
export class MockTerminalAdapter implements TerminalAdapter {
  private nextId = 1
  private readonly sessions = new Map<string, HostTerminalHandlers>()

  reset(): void {
    this.nextId = 1
    this.sessions.clear()
  }

  async connect(handlers: HostTerminalHandlers): Promise<HostTerminalSessionInfo> {
    const id = `term-${this.nextId}`
    this.nextId += 1
    this.sessions.set(id, handlers)
    return { id, user: HOST_USER, hostLabel: HOST_LABEL, prompt: HOST_PROMPT }
  }

  async sendInput(sessionId: string, line: string): Promise<void> {
    const handlers = this.requireSession(sessionId)
    // 演示引擎确定性求值；clear 的清屏由 store 在提交前拦截（引擎分支保留但不再表达清屏语义）。
    const { lines } = execHostCommand(line)
    if (lines.length > 0) {
      handlers.onFrame(sessionId, { type: 'output', lines })
    }
    // 每个命令结束发 prompt 帧：与真实端点「PROMPT_COMMAND 哨兵 → prompt 帧」同形。
    handlers.onFrame(sessionId, { type: 'prompt', prompt: HOST_PROMPT })
  }

  async interrupt(sessionId: string): Promise<void> {
    // mock 没有 PTY 可打断：会话存在性校验之外是本地 no-op。
    this.requireSession(sessionId)
  }

  complete(sessionId: string, draft: string, cursor: number): TerminalCompletion {
    if (!this.sessions.has(sessionId)) return { draft, cursor }
    return completeHostTerminalCommand(draft, cursor)
  }

  async disconnect(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
    this.sessions.delete(sessionId)
  }

  private requireSession(sessionId: string): HostTerminalHandlers {
    const handlers = this.sessions.get(sessionId)
    if (!handlers) throw new Error(`终端会话不存在 ${sessionId}`)
    return handlers
  }
}

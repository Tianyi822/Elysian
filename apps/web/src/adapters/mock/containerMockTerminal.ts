import type { HostTerminalHandlers, HostTerminalSessionInfo } from '../../contracts/adapters'
import { containerTerminalCompletions, execContainerCommand } from './containerTerminal'
import type { MockDataset } from './dataset'

type MockContainerTerminalSession = {
  containerId: string
  handlers: HostTerminalHandlers
}

export class MockContainerTerminal {
  private nextTerminalId = 1
  private readonly terminalSessions = new Map<string, MockContainerTerminalSession>()

  constructor(private readonly dataset: () => MockDataset) {}

  async connectTerminal(
    containerId: string,
    handlers: HostTerminalHandlers,
  ): Promise<HostTerminalSessionInfo> {
    const container = this.dataset().containers.find((candidate) => candidate.id === containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const id = `ctr-term-${this.nextTerminalId}`
    this.nextTerminalId += 1
    this.terminalSessions.set(id, { containerId, handlers })
    return { id, user: 'demo', hostLabel: container.name, prompt: '$ ' }
  }

  async executeTerminalCommand(sessionId: string, command: string) {
    const session = this.requireTerminalSession(sessionId)
    const container = this.dataset().containers.find((candidate) => candidate.id === session.containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const image = this.dataset().images.find((candidate) => candidate.id === container.imageId)
    if (!image) throw new Error('容器所用镜像不存在，无法执行演示终端命令')
    return execContainerCommand(container, image, command)
  }

  async sendTerminalInput(sessionId: string, _data: Uint8Array): Promise<void> {
    this.requireTerminalSession(sessionId)
    throw new Error('演示终端不提供真实 PTY')
  }

  async resizeTerminal(sessionId: string, _cols: number, _rows: number): Promise<void> {
    this.requireTerminalSession(sessionId)
  }

  acknowledgeTerminal(_sessionId: string, _bytes: number): void {}

  terminalCompletions(sessionId: string, input: string): readonly string[] {
    this.requireTerminalSession(sessionId)
    return containerTerminalCompletions(input)
  }

  async disconnectTerminal(sessionId: string): Promise<void> {
    if (!this.terminalSessions.delete(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
  }

  cancelTerminalConnect(): void {}

  private requireTerminalSession(sessionId: string): MockContainerTerminalSession {
    const session = this.terminalSessions.get(sessionId)
    if (!session) throw new Error(`终端会话不存在 ${sessionId}`)
    return session
  }
}

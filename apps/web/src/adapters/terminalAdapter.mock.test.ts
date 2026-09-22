import { describe, expect, it } from 'vitest'
import type { HostTerminalFrame } from '../contracts/adapters'
import { createMockGateway } from './mock/gateway'
import { HOST_PROMPT } from './mock/hostTerminal'
import { MockTerminalAdapter } from './mock/terminalAdapter'
import { collectFrames, runTerminalAdapterContract } from './terminalAdapterContract'

runTerminalAdapterContract(() => new MockTerminalAdapter())

describe('MockTerminalAdapter', () => {
  it('sendInput 流式产出 output 与 prompt 帧；会话不存在抛中文错误', async () => {
    const adapter = new MockTerminalAdapter()
    const frames: HostTerminalFrame[] = []
    const session = await adapter.connect(collectFrames(frames))
    await adapter.sendInput(session.id, 'whoami')
    expect(frames).toEqual([
      { type: 'output', lines: ['ops'] },
      { type: 'prompt', prompt: HOST_PROMPT },
    ])
    await expect(adapter.sendInput('term-不存在', 'help')).rejects.toThrow('终端会话不存在')
  })

  it('空输出的命令只发 prompt 帧（命令结束信号）', async () => {
    const adapter = new MockTerminalAdapter()
    const frames: HostTerminalFrame[] = []
    const session = await adapter.connect(collectFrames(frames))
    // 引擎的 clear 分支返回空行：流式下只剩命令结束信号（清屏语义由 store 在提交前拦截）。
    await adapter.sendInput(session.id, 'clear')
    expect(frames).toEqual([{ type: 'prompt', prompt: HOST_PROMPT }])
  })

  it('complete 委托演示词表：who 唯一补齐为 whoami', async () => {
    const adapter = new MockTerminalAdapter()
    const session = await adapter.connect(collectFrames([]))
    expect(adapter.complete(session.id, 'who', 3)).toEqual({ draft: 'whoami ', cursor: 7 })
  })

  it('createMockGateway 暴露 terminals 接缝，reset 后旧会话失效', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const session = await gateway.terminals.connect(collectFrames([]))
    await gateway.reset()
    await expect(gateway.terminals.sendInput(session.id, 'whoami')).rejects.toThrow(
      '终端会话不存在',
    )
  })
})

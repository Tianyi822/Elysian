import { describe, expect, it } from 'vitest'
import { createMockGateway } from './mock/gateway'
import { MockTerminalAdapter } from './mock/terminalAdapter'
import { runTerminalAdapterContract } from './terminalAdapterContract'

runTerminalAdapterContract(() => new MockTerminalAdapter())

describe('MockTerminalAdapter', () => {
  it('whoami 输出本机用户；会话不存在抛中文错误', async () => {
    const adapter = new MockTerminalAdapter()
    const session = await adapter.connect()
    expect((await adapter.execMockCommand(session.id, 'whoami')).lines).toEqual(['ops'])
    await expect(adapter.execMockCommand('term-不存在', 'help')).rejects.toThrow('终端会话不存在')
  })

  it('createMockGateway 暴露 terminals 接缝，reset 后旧会话失效', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const session = await gateway.terminals.connect()
    await gateway.reset()
    await expect(gateway.terminals.execMockCommand(session.id, 'whoami')).rejects.toThrow(
      '终端会话不存在',
    )
  })
})

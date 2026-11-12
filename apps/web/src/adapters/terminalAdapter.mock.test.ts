import { describe, expect, it } from 'vitest'
import { MockTerminalAdapter } from './mock/terminalAdapter'
import { runTerminalAdapterContract, collectFrames } from './terminalAdapterContract'
runTerminalAdapterContract(() => new MockTerminalAdapter())
describe('演示终端', () => {
  it('clear 由第三方 REPL 清屏，reset 使旧身份作废', async () => {
    const adapter = new MockTerminalAdapter()
    const session = await adapter.connect(collectFrames([]))
    expect(await adapter.executeCommand(session.id, 'clear')).toEqual({ lines: [], clear: true })
    adapter.reset()
    await expect(adapter.executeCommand(session.id, 'help')).rejects.toThrow('终端会话不存在')
  })
})

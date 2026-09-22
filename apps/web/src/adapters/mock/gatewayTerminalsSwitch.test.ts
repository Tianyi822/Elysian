import { describe, expect, it } from 'vitest'
import { MockFilesAdapter, MockFirewallAdapter } from './mockAdapters'
import { createMockGateway } from './gateway'
import { MockTerminalAdapter } from './terminalAdapter'

/*
 * gateway 的终端片分流断言（照 gatewayFilesSwitch.test.ts 先例）：
 * 缺省与 'mock' 走内存演示实现，'ws' 只把终端片换成 WebSocket 适配器，
 * 其余片不受影响。事件流固定 'memory'，不创建指向不存在端点的 EventSource。
 */

describe('createMockGateway 终端片分流', () => {
  it('缺省装配：终端是内存演示实现', () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })

  it("显式 terminals: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', terminals: 'mock' })
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })

  it("terminals: 'ws' 只把终端换成 WS 适配器，其余片仍是内存演示", () => {
    const gateway = createMockGateway({ eventStream: 'memory', terminals: 'ws' })
    expect(gateway.terminals).not.toBeInstanceOf(MockTerminalAdapter)
    expect(gateway.firewall).toBeInstanceOf(MockFirewallAdapter)
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
  })

  it("既有片的 'http' 选项不动终端片：files: 'http' 时终端仍是内存演示", () => {
    const gateway = createMockGateway({ eventStream: 'memory', files: 'http' })
    expect(gateway.files).not.toBeInstanceOf(MockFilesAdapter)
    expect(gateway.terminals).toBeInstanceOf(MockTerminalAdapter)
  })
})

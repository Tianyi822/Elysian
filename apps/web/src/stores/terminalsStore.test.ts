import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway } from '../contracts/adapters'
import { tabLabel, useTerminalsStore } from './terminalsStore'

function gatewayWith(overrides: Partial<ElysianGateway['terminals']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const terminals: ElysianGateway['terminals'] = {
    connect: () => base.terminals.connect(),
    execMockCommand: (id, command) => base.terminals.execMockCommand(id, command),
    disconnect: (id) => base.terminals.disconnect(id),
  }
  return { ...base, terminals: Object.assign(terminals, overrides) }
}

beforeEach(() => {
  useTerminalsStore.getState().resetLocal()
})

describe('terminalsStore', () => {
  it('openSession 连上本机后成为活动会话，带演示横幅', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const state = useTerminalsStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.activeId).toBe(state.sessions[0]!.id)
    expect(state.sessions[0]!.status).toBe('connected')
    expect(state.sessions[0]!.user).toBe('ops')
    expect(state.sessions[0]!.lines).toEqual([])
  })

  it('第二次 openSession 保留两条且切到新会话', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const firstId = useTerminalsStore.getState().activeId
    await useTerminalsStore.getState().openSession(gateway)
    const state = useTerminalsStore.getState()
    expect(state.sessions).toHaveLength(2)
    expect(state.activeId).not.toBe(firstId)
    expect(new Set(state.sessions.map((session) => session.id)).size).toBe(2)
  })

  it('submitCommand 回显 whoami、追加输出并记历史；空命令不动作', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().submitCommand(gateway, '   ')
    expect(useTerminalsStore.getState().sessions[0]!.lines).toHaveLength(0)

    await useTerminalsStore.getState().submitCommand(gateway, 'whoami')
    const session = useTerminalsStore.getState().sessions[0]!
    expect(session.lines.map((line) => line.text)).toEqual(['whoami', 'ops'])
    expect(session.history).toEqual(['whoami'])
  })

  it('submitCommand 对 clear 清屏并记历史', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().submitCommand(gateway, 'whoami')
    await useTerminalsStore.getState().submitCommand(gateway, 'clear')
    const session = useTerminalsStore.getState().sessions[0]!
    expect(session.lines).toEqual([])
    expect(session.history).toEqual(['whoami', 'clear'])
  })

  it('关闭最后一条后 sessions 为空且 hasUserDismissed，resetLocal 后可再开', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    await useTerminalsStore.getState().closeSession(gateway, id)
    expect(useTerminalsStore.getState().sessions).toEqual([])
    expect(useTerminalsStore.getState().hasUserDismissed).toBe(true)

    useTerminalsStore.getState().resetLocal()
    expect(useTerminalsStore.getState().hasUserDismissed).toBe(false)
    await useTerminalsStore.getState().openSession(gateway)
    expect(useTerminalsStore.getState().sessions).toHaveLength(1)
  })

  it('connect 失败时会话进入 error，reconnect 能连上', async () => {
    let fail = true
    const gateway = gatewayWith({
      connect: async () => {
        if (fail) throw new Error('本机终端暂不可用')
        return {
          id: 'term-recovered',
          user: 'ops',
          hostLabel: 'elysian-demo',
          prompt: 'ops@elysian-demo:~$ ',
        }
      },
    })
    await useTerminalsStore.getState().openSession(gateway)
    const failed = useTerminalsStore.getState().sessions[0]!
    expect(failed.status).toBe('error')
    expect(failed.errorMessage).toBe('本机终端暂不可用')

    fail = false
    await useTerminalsStore.getState().reconnect(gateway, failed.id)
    const recovered = useTerminalsStore.getState().sessions[0]!
    expect(recovered.status).toBe('connected')
    expect(recovered.id).toBe('term-recovered')
  })
})

describe('tabLabel', () => {
  const base = {
    status: 'connected' as const,
    user: 'ops',
    hostLabel: 'elysian-demo',
    prompt: 'ops@elysian-demo:~$ ',
    lines: [],
    history: [],
  }

  it('单会话不加序号，多会话按出现顺序编号', () => {
    const one = [{ ...base, id: 'a' }]
    expect(tabLabel(one[0]!, one)).toBe('ops@elysian-demo')
    const two = [
      { ...base, id: 'a' },
      { ...base, id: 'b' },
    ]
    expect(tabLabel(two[0]!, two)).toBe('ops@elysian-demo 1')
    expect(tabLabel(two[1]!, two)).toBe('ops@elysian-demo 2')
  })
})

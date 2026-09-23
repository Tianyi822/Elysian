import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway } from '../contracts/adapters'
import {
  hostTerminalBanner,
  hostTerminalEmptyDescription,
  tabLabel,
  useTerminalsStore,
} from './terminalsStore'

function gatewayWith(overrides: Partial<ElysianGateway['terminals']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const terminals: ElysianGateway['terminals'] = {
    connect: (handlers) => base.terminals.connect(handlers),
    sendInput: (id, line) => base.terminals.sendInput(id, line),
    interrupt: (id) => base.terminals.interrupt(id),
    complete: (id, draft, cursor) => base.terminals.complete(id, draft, cursor),
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

  it('sendInput 抛错时错误消息落为输出行', async () => {
    const gateway = gatewayWith({
      sendInput: async () => {
        throw new Error('终端会话不存在 term-x')
      },
    })
    await useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().submitCommand(gateway, 'whoami')
    const session = useTerminalsStore.getState().sessions[0]!
    expect(session.lines.map((line) => line.text)).toEqual(['whoami', '终端会话不存在 term-x'])
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

describe('terminalsStore 流式帧与关闭映射', () => {
  it('后台会话的 output 帧落到自己的标签，不动活动会话', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const firstId = useTerminalsStore.getState().activeId!
    await useTerminalsStore.getState().openSession(gateway)
    const secondId = useTerminalsStore.getState().activeId!

    useTerminalsStore.getState().applyFrame(firstId, { type: 'output', lines: ['后台输出'] })
    const first = useTerminalsStore.getState().sessions.find((session) => session.id === firstId)!
    const second = useTerminalsStore.getState().sessions.find((session) => session.id === secondId)!
    expect(first.lines.map((line) => line.text)).toEqual(['后台输出'])
    expect(second.lines).toEqual([])
  })

  it('submitCommand 把提交时的提示符冻在输入行上，随后的 prompt 帧不改写它', async () => {
    const gateway = gatewayWith({
      sendInput: async () => {
        const id = useTerminalsStore.getState().activeId!
        useTerminalsStore.getState().applyFrame(id, { type: 'prompt', prompt: 'ops@elysian-demo:/$ ' })
      },
    })
    await useTerminalsStore.getState().openSession(gateway)
    await useTerminalsStore.getState().submitCommand(gateway, 'cd /')
    const session = useTerminalsStore.getState().sessions[0]!
    expect(session.prompt).toBe('ops@elysian-demo:/$ ')
    expect(session.lines[0]).toEqual({ kind: 'input', text: 'cd /', prompt: 'ops@elysian-demo:~$ ' })
  })

  it('prompt 帧更新该会话提示符', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    useTerminalsStore.getState().applyFrame(id, { type: 'prompt', prompt: 'ops@elysian-demo:/tmp$ ' })
    expect(useTerminalsStore.getState().sessions[0]!.prompt).toBe('ops@elysian-demo:/tmp$ ')
  })

  it('truncated 帧渲染成可见截断标记行', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    useTerminalsStore.getState().applyFrame(id, { type: 'truncated', droppedBytes: 262144 })
    expect(useTerminalsStore.getState().sessions[0]!.lines).toEqual([
      { kind: 'output', text: '输出超出单轮上限，已丢弃 262144 字节' },
    ])
  })

  it('exit 帧把会话置为错误态并带退出码', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    useTerminalsStore.getState().applyFrame(id, { type: 'exit', exitCode: 0 })
    const session = useTerminalsStore.getState().sessions[0]!
    expect(session.status).toBe('error')
    expect(session.errorMessage).toBe('会话已退出（退出码 0）')
  })

  it('handleClose 按 4000/1008/1006 映射中文消息', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)

    const currentId = () => useTerminalsStore.getState().sessions[0]!.id
    const errorMessage = () => useTerminalsStore.getState().sessions[0]!.errorMessage

    useTerminalsStore.getState().handleClose(currentId(), { code: 4000, reason: '终端会话空闲超时' })
    expect(errorMessage()).toBe('终端会话空闲超时，已断开')

    await useTerminalsStore.getState().reconnect(gateway, currentId())
    useTerminalsStore.getState().handleClose(currentId(), { code: 1008, reason: '并发终端会话已达上限（5）' })
    expect(errorMessage()).toBe('并发终端会话已达上限（5）')

    await useTerminalsStore.getState().reconnect(gateway, currentId())
    useTerminalsStore.getState().handleClose(currentId(), { code: 1006, reason: '' })
    expect(errorMessage()).toBe('本机终端连接中断')
  })

  it('exit 置错误态后随后的 1000 关闭不覆盖错误消息', async () => {
    const gateway = gatewayWith()
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    useTerminalsStore.getState().applyFrame(id, { type: 'exit', exitCode: 1 })
    useTerminalsStore.getState().handleClose(id, { code: 1000, reason: '' })
    expect(useTerminalsStore.getState().sessions[0]!.errorMessage).toBe('会话已退出（退出码 1）')
  })

  it('interruptCommand 调适配层的 interrupt；会话已关闭时不动作', async () => {
    const interrupt = vi.fn(async () => {})
    const gateway = gatewayWith({ interrupt })
    await useTerminalsStore.getState().openSession(gateway)
    const id = useTerminalsStore.getState().activeId!
    await useTerminalsStore.getState().interruptCommand(gateway)
    expect(interrupt).toHaveBeenCalledWith(id)

    await useTerminalsStore.getState().closeSession(gateway, id)
    interrupt.mockClear()
    await useTerminalsStore.getState().interruptCommand(gateway)
    expect(interrupt).not.toHaveBeenCalled()
  })
})

describe('按运行时口径的文案', () => {
  it('mock 运行时保留演示标注与演示空态说明', () => {
    // vitest 环境未注入 ELSYIAN_DOCKER，isDockerRuntime() 为 false。
    expect(hostTerminalBanner()).toBe('演示终端 · 待接入真实执行')
    expect(hostTerminalEmptyDescription()).toContain('待接入真实执行')
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

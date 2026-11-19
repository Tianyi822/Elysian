import { describe, expect, it } from 'vitest'
import type { AgentRuntimeInfo } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { demoAgentRuntimeInfo } from '../adapters/mock/agent/agentRuntimeMock'
import { useAgentRuntimeStore } from './agentRuntimeStore'
import { useSessionStore } from './sessionStore'

function gatewayWith(info: AgentRuntimeInfo, error?: Error): ElysianGateway {
  return {
    agentRuntime: {
      runtime: () => error === undefined ? Promise.resolve(info) : Promise.reject(error),
    },
  } as unknown as ElysianGateway
}

describe('agentRuntimeStore', () => {
  it('加载成功进入 ready，携带完整能力报告', async () => {
    useAgentRuntimeStore.getState().reset()
    const info = demoAgentRuntimeInfo()
    await useAgentRuntimeStore.getState().load(gatewayWith(info))
    const state = useAgentRuntimeStore.getState()
    expect(state.status).toBe('ready')
    expect(state.info).toEqual(info)
  })

  it('闭包 sequence 丢弃过期响应：先发的慢请求不得覆盖后发的快请求', async () => {
    useAgentRuntimeStore.getState().reset()
    let releaseSlow: ((value: AgentRuntimeInfo) => void) | undefined
    const slowInfo = demoAgentRuntimeInfo()
    const fastInfo = { ...demoAgentRuntimeInfo(), queueDepth: 7 }
    const gateway = {
      agentRuntime: {
        runtime: () => new Promise<AgentRuntimeInfo>((resolve) => {
          if (releaseSlow === undefined) {
            releaseSlow = resolve
          } else {
            resolve(fastInfo)
          }
        }),
      },
    } as unknown as ElysianGateway
    const first = useAgentRuntimeStore.getState().load(gateway)
    const second = useAgentRuntimeStore.getState().load(gateway)
    await second
    expect(useAgentRuntimeStore.getState().info).toEqual(fastInfo)
    releaseSlow?.(slowInfo)
    await first
    // 慢响应到达时已被作废：info 仍是后发的快请求结果。
    expect(useAgentRuntimeStore.getState().info).toEqual(fastInfo)
  })

  it('刷新失败保留旧报告，静默失败反馈给轮询且恢复后清除错误', async () => {
    useAgentRuntimeStore.getState().reset()
    const info = demoAgentRuntimeInfo()
    await useAgentRuntimeStore.getState().load(gatewayWith(info))
    await useAgentRuntimeStore.getState().load(gatewayWith(demoAgentRuntimeInfo(), new Error('Agent 请求网络失败')))
    const failed = useAgentRuntimeStore.getState()
    expect(failed.status).toBe('ready')
    expect(failed.info).toEqual(info)
    expect(failed.errorMessage).toBe('Agent 请求网络失败')
    await expect(useAgentRuntimeStore.getState().load(gatewayWith(info, new Error('静默回读失败')), { silent: true }))
      .resolves.toBeUndefined()
    expect(useAgentRuntimeStore.getState().errorMessage).toBe('静默回读失败')
    const pollingError = new Error('断网')
    await expect(useAgentRuntimeStore.getState().load(gatewayWith(info, pollingError), { silent: true, throwOnError: true }))
      .rejects.toBe(pollingError)
    expect(useAgentRuntimeStore.getState().info).toEqual(info)
    expect(useAgentRuntimeStore.getState().status).toBe('ready')
    await useAgentRuntimeStore.getState().load(gatewayWith(info), { silent: true })
    expect(useAgentRuntimeStore.getState().status).toBe('ready')
    expect(useAgentRuntimeStore.getState().errorMessage).toBeUndefined()
  })

  it('内核级 503 遮挡可写操作；成功回读运行时后解除，保留旧报告供诊断', async () => {
    useAgentRuntimeStore.getState().reset()
    const info = demoAgentRuntimeInfo()
    await useAgentRuntimeStore.getState().load(gatewayWith(info))
    useAgentRuntimeStore.getState().reportUnavailable('记录副本不可用')
    expect(useAgentRuntimeStore.getState().unavailableReason).toBe('记录副本不可用')
    expect(useAgentRuntimeStore.getState().info).toEqual(info)
    await useAgentRuntimeStore.getState().load(gatewayWith(info), { silent: true })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBeUndefined()
  })

  it('503 之后才结束的旧运行时请求不得提前解除遮挡', async () => {
    useAgentRuntimeStore.getState().reset()
    let resolveRuntime: ((value: AgentRuntimeInfo) => void) | undefined
    const info = demoAgentRuntimeInfo()
    const gateway = {
      agentRuntime: { runtime: () => new Promise<AgentRuntimeInfo>((resolve) => { resolveRuntime = resolve }) },
    } as unknown as ElysianGateway
    const pending = useAgentRuntimeStore.getState().load(gateway)
    useAgentRuntimeStore.getState().reportUnavailable('存储故障')
    resolveRuntime?.(info)
    await pending
    expect(useAgentRuntimeStore.getState().unavailableReason).toBe('存储故障')
    await useAgentRuntimeStore.getState().load(gatewayWith(info), { silent: true })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBeUndefined()
  })

  it('会话失效清空运行时报告，迟到的读取不能恢复旧状态', async () => {
    const store = useAgentRuntimeStore.getState()
    store.reset()
    const info = demoAgentRuntimeInfo()
    await store.load(gatewayWith(info))
    store.reportUnavailable('旧会话的存储故障')
    let finish!: (value: AgentRuntimeInfo) => void
    const result = new Promise<AgentRuntimeInfo>(resolve => { finish = resolve })
    const gateway = { agentRuntime: { runtime: () => result } } as unknown as ElysianGateway
    const pending = store.load(gateway)

    useSessionStore.getState().expire()
    finish(info)
    await pending

    expect(useAgentRuntimeStore.getState()).toMatchObject({ status: 'idle', info: undefined, unavailableReason: undefined })
  })
})

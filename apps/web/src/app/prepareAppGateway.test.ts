import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGateway } from '../adapters/GatewayProvider'
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore'
import { useSessionStore } from '../stores/sessionStore'
import { prepareAppGateway } from './prepareAppGateway'

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState(useSessionStore.getInitialState())
  useAgentRuntimeStore.getState().reset()
})

describe('Agent 不可用接线', () => {
  it('应用装配把不同请求出口的内核级 503 上报到同一个状态出口', async () => {
    const reason = '记录副本尚未恢复'
    const code = 'record-storage-unavailable'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: reason, code }, { status: 503 })))
    const gateway = await prepareAppGateway(true)
    const requests = [
      () => gateway.modelSettings.listModelServices(),
      () => gateway.agentRuntime.runtime(),
      () => gateway.agentMemory.listSpaces(),
      () => gateway.agentExtensions.listSkills(),
      () => gateway.agentConversation.deleteSession('session-1'),
      () => gateway.agentConversation.uploadAttachments([new File(['示例'], 'sample.txt')]),
      () => gateway.agentConversation.stream('run-1', vi.fn(), new AbortController().signal),
      () => gateway.agentConversation.governance!.approvals('run-1'),
      () => gateway.agentExtensions.createSkillImport(
        { requestId: 'req-zip-1', source: { kind: 'zip' }, enabled: false },
        new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/zip' }),
      ),
    ]
    for (const request of requests) {
      useAgentRuntimeStore.getState().reset()
      await expect(request()).rejects.toMatchObject({ status: 503, code, message: reason })
      expect(useAgentRuntimeStore.getState().unavailableReason).toBe(reason)
    }
  })

  it('分项 503 仍返回原错误，不改变全局状态', async () => {
    const reason = 'MCP 通道不可用'
    const code = 'mcp-unavailable'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: reason, code }, { status: 503 })))
    const gateway = await prepareAppGateway(true)
    await expect(gateway.agentExtensions.listMcpServers()).rejects.toMatchObject({ status: 503, code, message: reason })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBeUndefined()
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('应用会话初始化', () => {
  it('构造演示 Gateway 不写会话，启动入口在渲染前经 adapter 读取演示身份', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    createDefaultGateway(false)
    expect(useSessionStore.getState().phase).toBe('unknown')
    await prepareAppGateway(false)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'authed', mode: 'demo', username: 'admin' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('正式模式把首读留给会话闸门，不预设身份', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await prepareAppGateway(true)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'unknown', username: undefined })
    expect(fetch).not.toHaveBeenCalled()
  })
})

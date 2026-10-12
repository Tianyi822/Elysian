import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHttpError, agentPathPart, isAgentGlobalUnavailableError, isAgentUnavailableError, requestAgentJson } from './agentShared'
import { useAgentRuntimeStore } from '../../../stores/agentRuntimeStore'

afterEach(() => vi.unstubAllGlobals())

describe('模型标识编码', () => {
  it('空标识抛中文错误，非空逐段编码', () => {
    expect(agentPathPart('model/1')).toBe('model%2F1')
    expect(() => agentPathPart('', '模型标识')).toThrow('Agent 模型标识不能为空')
  })
})

describe('requestAgentJson', () => {
  it('写请求 Content-Type 恒 application/json，服务端 {error,code} 中文透传并保留 code', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(
      JSON.stringify({ error: '模型服务已被修改', code: 'revision-conflict' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestAgentJson('/api/agent/model-services', { method: 'POST', body: '{}' }))
      .rejects.toThrow('模型服务已被修改')
    const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    try {
      await requestAgentJson('/api/agent/model-services', { method: 'POST' })
    } catch (error) {
      expect(isAgentUnavailableError(error)).toBe(false)
      expect((error as AgentHttpError).code).toBe('revision-conflict')
    }
  })

  it('以 HTTP 状态识别 503，只有内核级故障影响模型设置', () => {
    expect(isAgentGlobalUnavailableError(new AgentHttpError('内核不可用', 'unavailable', 503))).toBe(true)
    expect(isAgentGlobalUnavailableError(new AgentHttpError('记录副本故障', 'record-storage-unavailable', 503))).toBe(true)
    for (const code of ['extensions-unavailable', 'mcp-unavailable', 'execution-unavailable', 'resource-rules-unavailable']) {
      const error = new AgentHttpError('分项能力不可用', code, 503)
      expect(isAgentUnavailableError(error)).toBe(true)
      expect(isAgentGlobalUnavailableError(error)).toBe(false)
    }
    expect(isAgentUnavailableError(new AgentHttpError('冲突', 'revision-conflict', 409))).toBe(false)
    expect(isAgentUnavailableError(new AgentHttpError('伪造状态', 'unavailable', 400))).toBe(false)
    expect(isAgentUnavailableError(new Error('unavailable'))).toBe(false)
  })

  it('503 服务端中文 reason 进入全局禁写状态，分项 503 不污染它', async () => {
    useAgentRuntimeStore.getState().reset()
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown) => new Response(
      JSON.stringify({ error: '记录副本尚未恢复', code: 'record-storage-unavailable' }),
      { status: 503 },
    )))
    await expect(requestAgentJson('/api/agent/model-services')).rejects.toMatchObject({
      status: 503, code: 'record-storage-unavailable', message: '记录副本尚未恢复',
    })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBe('记录副本尚未恢复')
    useAgentRuntimeStore.getState().reset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'MCP 通道不可用', code: 'mcp-unavailable' }),
      { status: 503 },
    )))
    await expect(requestAgentJson('/api/agent/mcp-servers')).rejects.toMatchObject({ status: 503 })
    expect(useAgentRuntimeStore.getState().unavailableReason).toBeUndefined()
  })

  it('无 error 体的失败回 HTTP 状态码；成功体原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      }
      return new Response('<html>', { status: 500 })
    }))
    await expect(requestAgentJson('/api/agent/x')).resolves.toEqual({ ok: true })
    await expect(requestAgentJson('/api/agent/x', { method: 'POST' })).rejects.toThrow('Agent 请求失败：HTTP 500')
  })
})

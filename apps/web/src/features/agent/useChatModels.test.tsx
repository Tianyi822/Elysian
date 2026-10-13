import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { AgentModelProfile, AgentModelService } from '@elysian/contracts'
import { describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useChatModels } from './useChatModels'

const profile: AgentModelProfile & { enabled: boolean } = {
  id: 'text-model', revision: 1, model: 'text-v1',
  provider: 'openai-compatible', apiFormat: 'chat-completions', baseUrl: 'https://example.test/v1',
  contextTokens: 32000, outputTokens: 4096, active: true, enabled: true, hasCredential: false,
  capabilities: { text: true, tools: true, source: '测试', reasoningLevels: ['low', 'medium', 'high'] },
}
const service: AgentModelService = {
  id: 'test-service', revision: 1, name: '测试服务', provider: profile.provider, apiFormat: profile.apiFormat,
  baseUrl: profile.baseUrl, active: true, hasCredential: false, models: [profile],
}

function setup() {
  const gateway = createMockGateway({ eventStream: 'memory' })
  const read = vi.spyOn(gateway.modelSettings, 'listModelServices')
  const runtime = vi.spyOn(gateway.agentRuntime, 'runtime')
  const wrapper = ({ children }: { children: ReactNode }) => <GatewayProvider gateway={gateway}>{children}</GatewayProvider>
  return { read, runtime, wrapper }
}

describe('会话模型目录', () => {
  it('只呈现启用且支持文本与工具的模型，保留真实等级声明，且不检查运行内核', async () => {
    const { read, runtime, wrapper } = setup()
    read.mockResolvedValue([
      { ...service, models: [
        profile,
        { ...profile, id: 'disabled', enabled: false },
        { ...profile, id: 'inactive', active: false },
        { ...profile, id: 'image-only', capabilities: { text: false, tools: false, source: '测试', image: true } },
        { ...profile, id: 'plain', capabilities: { text: true, tools: false, source: '测试' } },
      ] },
      { ...service, id: 'inactive-service', active: false, models: [{ ...profile, id: 'inactive-parent' }] },
    ])
    const { result } = renderHook(useChatModels, { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.models.map(model => model.id)).toEqual(['text-model'])
    expect(result.current.models[0]).toMatchObject({ serviceName: '测试服务', reasoningLevels: ['low', 'medium', 'high'] })
    expect(read).toHaveBeenCalledTimes(1)
    expect(runtime).not.toHaveBeenCalled()
  })

  it('区分读取失败与空目录，并且只在手动重试时再次读取', async () => {
    const { read, wrapper } = setup()
    read.mockRejectedValueOnce(new Error('模型服务暂不可用')).mockResolvedValueOnce([])
    const { result } = renderHook(useChatModels, { wrapper })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('模型服务暂不可用')
    expect(read).toHaveBeenCalledTimes(1)
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.models).toEqual([])
    expect(result.current.error).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('重读时中止旧请求，旧目录迟到也不会覆盖新目录', async () => {
    const { read, wrapper } = setup()
    let finishFirst!: (value: readonly AgentModelService[]) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce([{ ...service, models: [{ ...profile, id: 'latest-model' }] }])
    const { result, unmount } = renderHook(useChatModels, { wrapper })
    const firstSignal = read.mock.calls[0]?.[0]
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.models[0]?.id).toBe('latest-model'))
    expect(firstSignal?.aborted).toBe(true)
    await act(async () => finishFirst([service]))
    expect(result.current.models[0]?.id).toBe('latest-model')
    const lastSignal = read.mock.calls[1]?.[0]
    unmount()
    expect(lastSignal?.aborted).toBe(true)
  })
})

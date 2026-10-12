import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelService, AgentModelServiceInput } from '@elysian/contracts'
import { createHttpModelSettingsAdapter } from './modelSettingsHttpAdapter'
const input: AgentModelServiceInput = { name: '服务', provider: 'deepseek', apiFormat: 'responses', baseUrl: 'https://api.deepseek.com', active: true, models: ['a', 'b'].map(model => ({ name: model, model, contextTokens: 1000000, outputTokens: 4096, capabilities: { text: true, tools: true, source: '测试' }, enabled: true })) }
const publicService: AgentModelService = { ...input, id: 'service-a', revision: 2, hasCredential: true, models: input.models.map((model, index) => ({ ...model, id: `model-${index}`, revision: 2, provider: input.provider, apiFormat: input.apiFormat, baseUrl: input.baseUrl, active: true, hasCredential: true })) }
afterEach(() => vi.unstubAllGlobals())
describe('模型服务 HTTP 接线', () => {
  it('目录读取通过同源 POST 发送临时凭据、修订及取消信号，只返回公开元数据', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ model: 'deepseek-flash', name: 'Flash', contextTokens: 1048576, outputTokens: 393216, credential: '不得回显' }])))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const adapter = createHttpModelSettingsAdapter()
    const request = { provider: input.provider, apiFormat: input.apiFormat, baseUrl: input.baseUrl, serviceId: 'service-a', expectedRevision: 2, credential: 'fake-key' }
    expect(await adapter.discoverModels(request, controller.signal)).toEqual([{ model: 'deepseek-flash', name: 'Flash', contextTokens: 1048576, outputTokens: 393216 }])
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent/model-services/discover')
    expect(fetch.mock.calls[0]?.[1].method).toBe('POST')
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(request)
    expect(fetch.mock.calls[0]?.[1].signal).toBeDefined()
  })
  it('目录拒绝重复模型和无效容量', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ model: 'a', name: 'A' }, { model: 'a', name: '重复' }]))).mockResolvedValueOnce(new Response(JSON.stringify([{ model: 'a', name: 'A', contextTokens: 0 }]))))
    const adapter = createHttpModelSettingsAdapter()
    await expect(adapter.discoverModels(input)).rejects.toThrow('模型目录响应无效')
    await expect(adapter.discoverModels(input)).rejects.toThrow('模型目录容量无效')
  })
  it('列表、新建、更新一次提交整组，共享凭据只出现在提交根字段', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([publicService]))).mockResolvedValueOnce(new Response(JSON.stringify(publicService))).mockResolvedValueOnce(new Response(JSON.stringify(publicService)))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpModelSettingsAdapter()
    expect((await adapter.listModelServices())[0]?.models).toHaveLength(2)
    await adapter.createModelService({ ...input, credential: 'fake-key' })
    await adapter.updateModelService('service-a', { ...input, expectedRevision: 2 })
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/agent/model-services')
    expect(fetch.mock.calls[1]?.[1].method).toBe('POST')
    const create = JSON.parse(fetch.mock.calls[1]?.[1].body)
    expect(create.apiFormat).toBe('responses')
    expect(create.credential).toBe('fake-key')
    expect(create.models).toHaveLength(2)
    expect(create.models.every((model: object) => !('credential' in model))).toBe(true)
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/agent/model-services/service-a')
    expect(fetch.mock.calls[2]?.[1].method).toBe('PUT')
    expect(JSON.parse(fetch.mock.calls[2]?.[1].body)).toEqual({ ...input, expectedRevision: 2 })
    expect(publicService).not.toHaveProperty('credential')
  })
  it('拒绝未知 API 格式或组内不一致的服务配置', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ ...publicService, apiFormat: 'unknown' }]))).mockResolvedValueOnce(new Response(JSON.stringify([{ ...publicService, models: publicService.models.map((model, index) => ({ ...model, apiFormat: index ? 'chat-completions' : 'responses' })) }]))))
    const adapter = createHttpModelSettingsAdapter()
    await expect(adapter.listModelServices()).rejects.toThrow()
    await expect(adapter.listModelServices()).rejects.toThrow('配置不一致')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentModelProfile,
  AgentModelProfileInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { ModelSettingsMockAdapter } from '../adapters/mock/agent/modelSettingsMockAdapter'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import {
  mockCreateModelProfile,
  mockUpdateModelProfile,
  resetModelSettingsData,
} from '../adapters/mock/agent/modelSettingsData'
import { useMessageStore } from './messageStore'
import { useModelSettingsStore } from './modelSettingsStore'

/*
 * store 层测试跑在确定性 mock 适配器上：验证六态装载、前端上限拦截、
 * 编号一致性拦截、写操作单飞锁、CAS 冲突回读合并与修订详情。
 */

function makeGateway(adapter = new ModelSettingsMockAdapter()): { gateway: ElysianGateway; adapter: ModelSettingsMockAdapter } {
  return { gateway: { modelSettings: adapter } as unknown as ElysianGateway, adapter }
}

const MODEL_INPUT: AgentModelProfileInput = {
  baseUrl: 'https://api.example.com/v1',
  model: 'store-model',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32000,
  outputTokens: 2048,
  capabilities: { text: true, tools: true, source: 'store 测试' },
  active: true, credential: 'store-test-key',
}

beforeEach(async () => { resetModelSettingsData(); useModelSettingsStore.getState().reset(); useMessageStore.getState().clear() })
describe('模型设置保存与冲突回读', () => {
  it('新建模型（提交凭据）后列表回显 hasCredential=true 且凭据不回显', async () => {
    const { gateway } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const ok = await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, credential: 'store-secret' })
    expect(ok).toBe(true)
    const created = useModelSettingsStore.getState().models.find((item) => item.model === 'store-model')
    expect(created?.hasCredential).toBe(true)
    expect(created && Object.hasOwn(created as unknown as Record<string, unknown>, 'credential')).toBe(false)
  })

  it('单飞锁期间重复提交直接返回 false，不重复派发', async () => {
    const { gateway, adapter } = makeGateway()
    const spy = vi.spyOn(adapter, 'createModelProfile')
    await useModelSettingsStore.getState().load(gateway)
    let resolveFirst: ((value: AgentModelProfile) => void) | undefined
    spy.mockImplementationOnce(() => new Promise<AgentModelProfile>((resolve) => {
      resolveFirst = resolve
    }))
    const first = useModelSettingsStore.getState().saveModel(gateway, MODEL_INPUT)
    // 第一次提交已同步进入 saving=true；连点被单飞锁挡下。
    const second = await useModelSettingsStore.getState().saveModel(gateway, MODEL_INPUT)
    expect(second).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    resolveFirst?.({
      id: 'mp-single', revision: 1, baseUrl: MODEL_INPUT.baseUrl, model: MODEL_INPUT.model,
      provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: MODEL_INPUT.contextTokens, outputTokens: MODEL_INPUT.outputTokens,
      capabilities: MODEL_INPUT.capabilities, active: MODEL_INPUT.active, hasCredential: false,
    })
    expect(await first).toBe(true)
    expect(useModelSettingsStore.getState().saving).toBe(false)
  })

  it('模型 CAS 冲突同样回读合并（revision-conflict 家族）', async () => {
    const { gateway } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const model = useModelSettingsStore.getState().models[0]
    if (model === undefined) throw new Error('模型种子应存在')
    mockUpdateModelProfile(model.id, { ...MODEL_INPUT, baseUrl: 'https://other.example.test/v1', model: model.model, provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: model.contextTokens, outputTokens: model.outputTokens, capabilities: model.capabilities, active: model.active, expectedRevision: model.revision })
    const result = await useModelSettingsStore.getState().saveModel(
      gateway,
      { ...MODEL_INPUT, baseUrl: 'https://local.example.test/v1' },
      { id: model.id, revision: model.revision },
    )
    expect(result).toBe(false)
    expect(useModelSettingsStore.getState().models[0]?.baseUrl).toBe('https://other.example.test/v1')
  })
  it('模型目录读取失败后可以重试', async () => {
    const { gateway, adapter } = makeGateway()
    const read = vi.spyOn(adapter, 'listModelServices').mockRejectedValueOnce(new Error('读取失败'))
    await useModelSettingsStore.getState().load(gateway)
    expect(useModelSettingsStore.getState().status).toBe('error')
    await useModelSettingsStore.getState().refresh(gateway)
    expect(useModelSettingsStore.getState().status).toBe('ready')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('缺少 API Key 的配置在提交前拦截，停用或自定义供应商也不放行', async () => {
    const { gateway, adapter } = makeGateway()
    const create = vi.spyOn(adapter, 'createModelProfile')
    for (const provider of ['deepseek', 'openai-compatible', 'zhipu'] as const) {
      expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, provider, credential: undefined })).toBe(false)
      expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, provider, credential: undefined, active: false })).toBe(false)
    }
    expect(create).not.toHaveBeenCalled()
  })
  it('智谱供应商仅接受 Chat Completions 格式，且不能声明 disabled 档', async () => {
    const { gateway, adapter } = makeGateway()
    const create = vi.spyOn(adapter, 'createModelProfile')
    expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, provider: 'zhipu', apiFormat: 'anthropic-messages' })).toBe(false)
    expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, provider: 'zhipu', apiFormat: 'responses' })).toBe(false)
    expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, provider: 'zhipu', capabilities: { ...MODEL_INPUT.capabilities, reasoningLevels: ['low', 'disabled'] } })).toBe(false)
    expect(await useModelSettingsStore.getState().saveModel(gateway, { ...MODEL_INPUT, capabilities: { ...MODEL_INPUT.capabilities, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'max' } })).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(() => mockCreateModelProfile({ ...MODEL_INPUT, provider: 'zhipu', capabilities: { ...MODEL_INPUT.capabilities, reasoningLevels: ['low', 'disabled'] } })).toThrow('智谱模型的思考无法关闭')
    expect(() => mockCreateModelProfile({ ...MODEL_INPUT, provider: 'zhipu', apiFormat: 'anthropic-messages' })).toThrow('智谱服务当前仅支持 Chat Completions 格式')
  })
})

describe('模型表格批量启停', () => {
  it('刷新先读取到更高修订时，迟到的批量写回执不能让模型服务倒退', async () => {
    const { gateway, adapter } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const services = useModelSettingsStore.getState().services
    const service = services.find(item => item.active)!
    const receipt = { ...service, revision: service.revision + 1 }
    const newer = { ...service, revision: service.revision + 2, name: '其他窗口的后续修订' }
    let resolve!: (value: typeof service) => void
    const write = vi.spyOn(adapter, 'updateModelService').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = useModelSettingsStore.getState().setModelsEnabled(gateway, service, [service.models[0]!.id], false)
    vi.spyOn(adapter, 'listModelServices').mockResolvedValueOnce(services.map(item => item.id === service.id ? newer : item))
    await useModelSettingsStore.getState().refresh(gateway)
    resolve(receipt)
    expect((await pending).status).toBe('succeeded')
    expect(write).toHaveBeenCalledTimes(1)
    expect(useModelSettingsStore.getState().services.find(item => item.id === service.id)).toEqual(newer)
    expect(useModelSettingsStore.getState().models).toEqual(useModelSettingsStore.getState().services.flatMap(item => item.models))
  })

  it('同服务的多个所选模型一次 CAS，保留未选模型、服务状态和全部声明且不发送凭据', async () => {
    const { gateway, adapter } = makeGateway()
    await useModelSettingsStore.getState().saveService(gateway, {
      name: '批量服务', provider: 'openai-compatible', apiFormat: 'responses', baseUrl: MODEL_INPUT.baseUrl, active: true, credential: 'keep-secret',
      models: ['selected-a', 'selected-b', 'unselected'].map(model => ({ model, contextTokens: 32000, outputTokens: 4096, capabilities: { ...MODEL_INPUT.capabilities, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' }, enabled: true })),
    })
    const snapshot = useModelSettingsStore.getState().services.find(service => service.name === '批量服务')!
    const update = vi.spyOn(adapter, 'updateModelService')
    const result = await useModelSettingsStore.getState().setModelsEnabled(gateway, snapshot, snapshot.models.slice(0, 2).map(model => model.id), false)
    expect(result.status).toBe('succeeded')
    expect(update).toHaveBeenCalledTimes(1)
    const payload = update.mock.calls[0]![1]
    expect(payload).not.toHaveProperty('credential')
    expect(payload.expectedRevision).toBe(snapshot.revision)
    expect(payload.active).toBe(snapshot.active)
    expect(payload.models.map(model => model.enabled)).toEqual([false, false, true])
    expect(payload.models.map(model => model.capabilities)).toEqual(snapshot.models.map(model => model.capabilities))
    expect(useModelSettingsStore.getState().services.find(service => service.id === snapshot.id)?.revision).toBe(snapshot.revision + 1)
  })

  it('停用服务内不能批量启用模型；陈旧确认不派发', async () => {
    const { gateway, adapter } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const disabled = useModelSettingsStore.getState().services.find(service => !service.active)!
    const update = vi.spyOn(adapter, 'updateModelService')
    expect((await useModelSettingsStore.getState().setModelsEnabled(gateway, disabled, [disabled.models[0]!.id], true)).status).toBe('failed')
    const service = useModelSettingsStore.getState().services[0]!
    expect((await useModelSettingsStore.getState().setModelsEnabled(gateway, { ...service, revision: service.revision - 1 }, [service.models[0]!.id], false)).status).toBe('failed')
    expect(update).not.toHaveBeenCalled()
  })

  it('可信拒绝与网络未知分别返回，未知不更新本地状态或自动重投', async () => {
    const { gateway, adapter } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const service = useModelSettingsStore.getState().services.find(item => item.active)!
    const update = vi.spyOn(adapter, 'updateModelService').mockRejectedValueOnce(new AgentHttpError('修订变化', 'revision-conflict', 409)).mockRejectedValueOnce(new Error('网络断开'))
    expect((await useModelSettingsStore.getState().setModelsEnabled(gateway, service, [service.models[0]!.id], false)).status).toBe('failed')
    const snapshot = useModelSettingsStore.getState().services
    expect((await useModelSettingsStore.getState().setModelsEnabled(gateway, service, [service.models[0]!.id], false)).status).toBe('unknown')
    expect(update).toHaveBeenCalledTimes(2)
    expect(useModelSettingsStore.getState().services).toBe(snapshot)
    expect(useModelSettingsStore.getState().saving).toBe(false)
  })
})


describe('服务级原子保存', () => {
  const serviceInput = { name: '共用服务', provider: 'openai-compatible' as const, apiFormat: 'responses' as const, baseUrl: MODEL_INPUT.baseUrl, active: true, credential: 'fake-shared-key', models: ['a', 'b'].map(model => ({ name: model, model, contextTokens: 32000, outputTokens: 4096, capabilities: MODEL_INPUT.capabilities, enabled: true })) }
  it('同组模型一次保存，重复提交被拦截，凭据不会进入 store', async () => {
    const { gateway, adapter } = makeGateway()
    await useModelSettingsStore.getState().load(gateway)
    const original = adapter.createModelService.bind(adapter)
    let release: (() => void) | undefined
    const spy = vi.spyOn(adapter, 'createModelService').mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve }); return original(input) })
    const first = useModelSettingsStore.getState().saveService(gateway, serviceInput)
    expect(await useModelSettingsStore.getState().saveService(gateway, serviceInput)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    release?.()
    expect(await first).toBe(true)
    const service = useModelSettingsStore.getState().services.find(service => service.name === '共用服务')!
    expect(service.models).toHaveLength(2)
    expect(JSON.stringify(service)).not.toContain('fake-shared-key')
    expect(service.models.every(model => model.hasCredential)).toBe(true)
  })
  it('第二个模型无效时整组不创建；重复标识拒绝', async () => {
    const { gateway, adapter } = makeGateway()
    const spy = vi.spyOn(adapter, 'createModelService')
    expect(await useModelSettingsStore.getState().saveService(gateway, { ...serviceInput, models: serviceInput.models.map((row, index) => ({ ...row, contextTokens: index ? 0 : 32000 })) })).toBe(false)
    expect(await useModelSettingsStore.getState().saveService(gateway, { ...serviceInput, models: [serviceInput.models[0]!, serviceInput.models[0]!] })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

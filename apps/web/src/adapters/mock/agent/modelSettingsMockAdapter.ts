import type {
  AgentModelProfile,
  AgentModelProfileInput,
  AgentModelDiscoveryInput,
  AgentDiscoveredModel,
  AgentUpdateModelProfileInput,
} from '@elysian/contracts'
import type { ModelSettingsAdapter } from '../../../contracts/adapters'
import {
  ModelSettingsMockError,
  mockCreateModelProfile,
  mockListModelProfiles,
  mockListModelServices,
  mockSaveModelService,
  mockUpdateModelProfile,
  resetModelSettingsData,
} from './modelSettingsData'

export { resetModelSettingsData }

/** 系统设置的模型演示适配器。 */
export class ModelSettingsMockAdapter implements ModelSettingsAdapter {
  async discoverModels(input: AgentModelDiscoveryInput, signal?: AbortSignal): Promise<readonly AgentDiscoveredModel[]> {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    const service = mockListModelServices().find(service => service.id === input.serviceId)
    if (input.serviceId && !service) throw new ModelSettingsMockError(404, 'service-not-found', '模型服务不存在')
    if (service && service.revision !== input.expectedRevision) throw new ModelSettingsMockError(409, 'revision-conflict', '模型服务已被修改，请重新读取后重试')
    if ((input.provider === 'deepseek' || input.provider === 'zhipu') && !(input.credential === undefined ? service?.hasCredential : input.credential.trim())) throw new Error(input.provider === 'deepseek' ? '获取 DeepSeek 模型前请配置 API Key' : '获取智谱模型前请配置 API Key')
    if (input.credential === undefined && service?.hasCredential && (input.provider !== service.provider || input.baseUrl.replace(/\/+$/, '') !== service.baseUrl)) throw new Error('服务地址已修改，请输入 API Key 后再获取模型')
    if (input.provider === 'deepseek') return [{ model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextTokens: 1048576, outputTokens: 393216 }, { model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextTokens: 1048576, outputTokens: 393216 }]
    if (input.provider === 'zhipu') return [{ model: 'glm-5.3', name: 'GLM-5.3', contextTokens: 1048576, outputTokens: 131072 }, { model: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextTokens: 1048576, outputTokens: 131072 }]
    return [{ model: 'demo-model', name: '演示模型' }]
  }
  async listModelServices() { return mockListModelServices() }
  async createModelService(input: import('@elysian/contracts').AgentModelServiceInput) { return mockSaveModelService(input) }
  async updateModelService(id: string, input: import('@elysian/contracts').AgentUpdateModelServiceInput) { return mockSaveModelService(input, id, input.expectedRevision) }

  async listModelProfiles(): Promise<readonly AgentModelProfile[]> {
    return mockListModelProfiles()
  }

  async createModelProfile(input: AgentModelProfileInput): Promise<AgentModelProfile> {
    return mockCreateModelProfile(input)
  }

  async updateModelProfile(profileId: string, input: AgentUpdateModelProfileInput): Promise<AgentModelProfile> {
    return mockUpdateModelProfile(profileId, input)
  }

}

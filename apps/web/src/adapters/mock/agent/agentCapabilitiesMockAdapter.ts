import type {
  AgentExecutionGrant,
  AgentExecutionGrantInput,
  AgentExecutionProfile,
  AgentExecutionProfileInput,
  AgentExecutionRuntime,
  AgentModelProfile,
  AgentModelProfileInput,
  AgentModelDiscoveryInput,
  AgentDiscoveredModel,
  AgentResourceRule,
  AgentResourceRuleInput,
  AgentUpdateModelProfileInput,
  AgentUpdateResourceRuleInput,
} from '@elysian/contracts'
import type { AgentCapabilitiesAdapter } from '../../../contracts/adapters'
import {
  AgentCapabilitiesMockError,
  mockCreateExecutionProfile,
  mockCreateGrant,
  mockCreateModelProfile,
  mockCreateResourceRule,
  mockGetExecutionProfile,
  mockGetGrant,
  mockGetResourceRule,
  mockListExecutionProfiles,
  mockListExecutionRuntimes,
  mockListGrants,
  mockListModelProfiles,
  mockListModelServices,
  mockSaveModelService,
  mockListResourceRules,
  mockSetExecutionProfileEnabled,
  mockSetGrantEnabled,
  mockUpdateExecutionProfile,
  mockUpdateGrant,
  mockUpdateModelProfile,
  mockUpdateResourceRule,
  resetAgentCapabilitiesData,
} from './agentCapabilitiesData'

/*
 * Ely 模型与执行配置域 mock 适配器：全部方法落到确定性数据集的状态机上，
 * 语义与服务端一致（修订 CAS、凭据只写不回显、限额裁决）。状态机抛出的
 * AgentCapabilitiesMockError 自带 code，供 store 按与服务端同口径判定
 * expectedRevision 冲突并回读合并。resetAgentCapabilitiesData 自数据集
 * 重导出，供 test/agentTestUtils 聚合复位。
 */

export { resetAgentCapabilitiesData }

export class AgentCapabilitiesMockAdapter implements AgentCapabilitiesAdapter {
  async discoverModels(input: AgentModelDiscoveryInput, signal?: AbortSignal): Promise<readonly AgentDiscoveredModel[]> {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    const service = mockListModelServices().find(service => service.id === input.serviceId)
    if (input.serviceId && !service) throw new AgentCapabilitiesMockError(404, 'service-not-found', '模型服务不存在')
    if (service && service.revision !== input.expectedRevision) throw new AgentCapabilitiesMockError(409, 'revision-conflict', '模型服务已被修改，请重新读取后重试')
    if (input.provider === 'deepseek' && !(input.credential === undefined ? service?.hasCredential : input.credential.trim())) throw new Error('获取 DeepSeek 模型前请配置 API Key')
    if (input.credential === undefined && service?.hasCredential && (input.provider !== service.provider || input.baseUrl.replace(/\/+$/, '') !== service.baseUrl)) throw new Error('服务地址已修改，请输入 API Key 后再获取模型')
    return input.provider === 'deepseek'
      ? [{ model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextTokens: 1048576, outputTokens: 393216 }, { model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextTokens: 1048576, outputTokens: 393216 }]
      : [{ model: 'demo-model', name: '演示模型' }]
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

  async listExecutionProfiles(): Promise<readonly AgentExecutionProfile[]> {
    return mockListExecutionProfiles()
  }

  async getExecutionProfile(profileId: string, revision?: number): Promise<AgentExecutionProfile> {
    return mockGetExecutionProfile(profileId, revision)
  }

  async createExecutionProfile(input: AgentExecutionProfileInput): Promise<AgentExecutionProfile> {
    return mockCreateExecutionProfile(input)
  }

  async updateExecutionProfile(profileId: string, input: AgentExecutionProfileInput): Promise<AgentExecutionProfile> {
    return mockUpdateExecutionProfile(profileId, input)
  }

  async setExecutionProfileEnabled(profileId: string, expectedRevision: number, enabled: boolean): Promise<AgentExecutionProfile> {
    return mockSetExecutionProfileEnabled(profileId, expectedRevision, enabled)
  }

  async listGrants(): Promise<readonly AgentExecutionGrant[]> {
    return mockListGrants()
  }

  async getGrant(grantId: string, revision?: number): Promise<AgentExecutionGrant> {
    return mockGetGrant(grantId, revision)
  }

  async createGrant(input: AgentExecutionGrantInput): Promise<AgentExecutionGrant> {
    return mockCreateGrant(input)
  }

  async updateGrant(grantId: string, input: AgentExecutionGrantInput): Promise<AgentExecutionGrant> {
    return mockUpdateGrant(grantId, input)
  }

  async setGrantEnabled(grantId: string, expectedRevision: number, enabled: boolean): Promise<AgentExecutionGrant> {
    return mockSetGrantEnabled(grantId, expectedRevision, enabled)
  }

  async listExecutionRuntimes(): Promise<readonly AgentExecutionRuntime[]> {
    return mockListExecutionRuntimes()
  }

  async listResourceRules(): Promise<readonly AgentResourceRule[]> {
    return mockListResourceRules()
  }

  async getResourceRule(ruleId: string, revision?: number): Promise<AgentResourceRule> {
    return mockGetResourceRule(ruleId, revision)
  }

  async createResourceRule(input: AgentResourceRuleInput): Promise<AgentResourceRule> {
    return mockCreateResourceRule(input)
  }

  async updateResourceRule(ruleId: string, input: AgentUpdateResourceRuleInput): Promise<AgentResourceRule> {
    return mockUpdateResourceRule(ruleId, input)
  }
}

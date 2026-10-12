import type { AgentDiscoveredModel } from '@elysian/contracts'
import type { ModelSettingsAdapter } from '../../../contracts/adapters'
import { agentPathPart, requestAgentJson } from './agentShared'
import { parseAgentModelProfile, parseAgentModelService } from './agentCatalogParse'

/** 系统设置中的模型服务与模型目录；端点仍由 Agent 后端提供。 */
function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

function parseDiscoveredModels(value: unknown): readonly AgentDiscoveredModel[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error('模型目录响应无效')
  const seen = new Set<string>()
  return value.map(value => {
    const row = object(value, '模型目录响应无效')
    if (typeof row.model !== 'string' || !row.model.trim() || row.model.length > 200 || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || seen.has(row.model)) throw new Error('模型目录响应无效')
    seen.add(row.model)
    const capacity = (value: unknown) => {
      const tokens = positiveInteger(value, '模型目录容量无效')
      if (tokens > 2_000_000) throw new Error('模型目录容量无效')
      return tokens
    }
    return { model: row.model, name: row.name, ...(row.contextTokens === undefined ? {} : { contextTokens: capacity(row.contextTokens) }), ...(row.outputTokens === undefined ? {} : { outputTokens: capacity(row.outputTokens) }) }
  })
}

export function createHttpModelSettingsAdapter(baseUrl = '/api/agent'): ModelSettingsAdapter {
  const serviceBase = `${baseUrl}/model-services`
  const modelBase = `${baseUrl}/model-profiles`
  return {
    async discoverModels(input, signal) {
      return parseDiscoveredModels(await requestAgentJson(`${serviceBase}/discover`, { method: 'POST', body: JSON.stringify(input), signal }))
    },
    async listModelServices(signal) {
      const value = await requestAgentJson(serviceBase, { signal })
      if (!Array.isArray(value)) throw new Error('Agent 模型服务列表响应无效')
      return value.map(parseAgentModelService)
    },
    async createModelService(input) {
      return parseAgentModelService(await requestAgentJson(serviceBase, { method: 'POST', body: JSON.stringify(input) }))
    },
    async updateModelService(serviceId, input) {
      return parseAgentModelService(await requestAgentJson(`${serviceBase}/${agentPathPart(serviceId, '模型服务编号')}`, { method: 'PUT', body: JSON.stringify(input) }))
    },
    async listModelProfiles(signal) {
      const value = await requestAgentJson(modelBase, { signal })
      if (!Array.isArray(value)) throw new Error('Agent 模型配置列表响应无效')
      return value.map(parseAgentModelProfile)
    },
    async createModelProfile(input) {
      // credential 为 undefined 时 JSON.stringify 省略字段＝沿用旧值；空串＝清除。
      return parseAgentModelProfile(await requestAgentJson(modelBase, {
        method: 'POST',
        body: JSON.stringify(input),
      }))
    },
    async updateModelProfile(profileId, input) {
      return parseAgentModelProfile(await requestAgentJson(`${modelBase}/${agentPathPart(profileId, '模型配置编号')}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }))
    },
  }
}

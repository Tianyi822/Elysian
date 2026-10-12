import type {
  AgentExecutionGrant,
  AgentExecutionProfile,
  AgentExecutionRuntime,
  AgentModelProfile,
  AgentDiscoveredModel,
  AgentResourceRule,
} from '@elysian/contracts'
import type { AgentCapabilitiesAdapter } from '../../../contracts/adapters'
import { agentPathPart, agentQueryString, requestAgentJson } from './agentShared'
import {
  parseAgentExecutionGrant,
  parseAgentExecutionProfile,
  parseAgentModelProfile,
  parseAgentModelService,
  parseAgentResourceRule,
} from './agentCatalogParse'

/*
 * 模型与执行配置域 HTTP 适配器。端点全部挂 /api/agent：
 * - 模型：GET/POST /model-profiles、PUT /model-profiles/{id}（更新体平铺 expectedRevision；
 *   credential 省略沿用、空串清除，凭据永不回显）；
 * - 执行配置与授权：列表/详情（?revision= 可选历史修订）/新建/编辑（Input 自带
 *   expectedRevision，创建必须为 0 且不带 id）/启停（{expectedRevision,enabled}）；
 * - 资源规则：POST 体为纯输入（服务端以空路径＋预期修订零落盘），PUT 平铺 expectedRevision；
 * - 执行器运行时：GET /execution-runtimes，执行器未就绪回空数组。
 * 全部写端点无 requestId；解析复用 agentCatalogParse 的共享 parse。
 */

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

/** 执行器受管进程条目：state 为服务端事实字符串（当前取值 running 与 stopping）。 */
export function parseAgentExecutionRuntime(value: unknown): AgentExecutionRuntime {
  const row = object(value, 'Agent 执行器运行时响应无效')
  return {
    id: typeof row.id === 'string' ? row.id : (() => { throw new Error('Agent 执行器运行时响应无效') })(),
    containerId: typeof row.containerId === 'string' ? row.containerId : (() => { throw new Error('Agent 执行器运行时响应无效') })(),
    ...row.serverId === undefined ? {} : { serverId: typeof row.serverId === 'string' ? row.serverId : (() => { throw new Error('Agent 执行器运行时响应无效') })() },
    ...row.serverRevision === undefined ? {} : { serverRevision: positiveInteger(row.serverRevision, 'Agent 执行器运行时响应无效') },
    state: typeof row.state === 'string' ? row.state : (() => { throw new Error('Agent 执行器运行时响应无效') })(),
  }
}

function parseAgentExecutionRuntimes(value: unknown): readonly AgentExecutionRuntime[] {
  if (!Array.isArray(value)) throw new Error('Agent 执行器运行时列表响应无效')
  return value.map(parseAgentExecutionRuntime)
}

function parseModelProfiles(value: unknown): readonly AgentModelProfile[] {
  if (!Array.isArray(value)) throw new Error('Agent 模型配置列表响应无效')
  return value.map(parseAgentModelProfile)
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

function parseExecutionProfiles(value: unknown): readonly AgentExecutionProfile[] {
  if (!Array.isArray(value)) throw new Error('Agent 执行配置列表响应无效')
  return value.map(parseAgentExecutionProfile)
}

function parseGrants(value: unknown): readonly AgentExecutionGrant[] {
  if (!Array.isArray(value)) throw new Error('Agent 授权列表响应无效')
  return value.map(parseAgentExecutionGrant)
}

function parseResourceRules(value: unknown): readonly AgentResourceRule[] {
  if (!Array.isArray(value)) throw new Error('Agent 资源规则列表响应无效')
  return value.map(parseAgentResourceRule)
}

function revisionQuery(revision: number | undefined): string {
  if (revision === undefined) return ''
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('修订必须是正整数')
  return `?${agentQueryString({ revision })}`
}

export function createHttpAgentCapabilitiesAdapter(baseUrl = '/api/agent'): AgentCapabilitiesAdapter {
  const serviceBase = `${baseUrl}/model-services`
  const modelBase = `${baseUrl}/model-profiles`
  const executionBase = `${baseUrl}/execution-profiles`
  const grantBase = `${baseUrl}/grants`
  const ruleBase = `${baseUrl}/resource-rules`
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
      return parseModelProfiles(await requestAgentJson(modelBase, { signal }))
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
    async listExecutionProfiles(signal) {
      return parseExecutionProfiles(await requestAgentJson(executionBase, { signal }))
    },
    async getExecutionProfile(profileId, revision, signal) {
      return parseAgentExecutionProfile(await requestAgentJson(
        `${executionBase}/${agentPathPart(profileId, '执行配置编号')}${revisionQuery(revision)}`,
        { signal },
      ))
    },
    async createExecutionProfile(input) {
      return parseAgentExecutionProfile(await requestAgentJson(executionBase, {
        method: 'POST',
        body: JSON.stringify(input),
      }))
    },
    async updateExecutionProfile(profileId, input) {
      return parseAgentExecutionProfile(await requestAgentJson(`${executionBase}/${agentPathPart(profileId, '执行配置编号')}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }))
    },
    async setExecutionProfileEnabled(profileId, expectedRevision, enabled) {
      return parseAgentExecutionProfile(await requestAgentJson(`${executionBase}/${agentPathPart(profileId, '执行配置编号')}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision, enabled }),
      }))
    },
    async listGrants(signal) {
      return parseGrants(await requestAgentJson(grantBase, { signal }))
    },
    async getGrant(grantId, revision, signal) {
      return parseAgentExecutionGrant(await requestAgentJson(
        `${grantBase}/${agentPathPart(grantId, '授权编号')}${revisionQuery(revision)}`,
        { signal },
      ))
    },
    async createGrant(input) {
      return parseAgentExecutionGrant(await requestAgentJson(grantBase, {
        method: 'POST',
        body: JSON.stringify(input),
      }))
    },
    async updateGrant(grantId, input) {
      return parseAgentExecutionGrant(await requestAgentJson(`${grantBase}/${agentPathPart(grantId, '授权编号')}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }))
    },
    async setGrantEnabled(grantId, expectedRevision, enabled) {
      return parseAgentExecutionGrant(await requestAgentJson(`${grantBase}/${agentPathPart(grantId, '授权编号')}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision, enabled }),
      }))
    },
    async listExecutionRuntimes(signal) {
      return parseAgentExecutionRuntimes(await requestAgentJson(`${baseUrl}/execution-runtimes`, { signal }))
    },
    async listResourceRules(signal) {
      return parseResourceRules(await requestAgentJson(ruleBase, { signal }))
    },
    async getResourceRule(ruleId, revision, signal) {
      return parseAgentResourceRule(await requestAgentJson(
        `${ruleBase}/${agentPathPart(ruleId, '资源规则编号')}${revisionQuery(revision)}`,
        { signal },
      ))
    },
    async createResourceRule(input) {
      // POST 体为纯输入：expectedRevision 不出现在请求里（服务端以空路径落盘）。
      return parseAgentResourceRule(await requestAgentJson(ruleBase, {
        method: 'POST',
        body: JSON.stringify(input),
      }))
    },
    async updateResourceRule(ruleId, input) {
      const { expectedRevision, ...rest } = input
      return parseAgentResourceRule(await requestAgentJson(`${ruleBase}/${agentPathPart(ruleId, '资源规则编号')}`, {
        method: 'PUT',
        body: JSON.stringify({ ...rest, expectedRevision }),
      }))
    },
  }
}

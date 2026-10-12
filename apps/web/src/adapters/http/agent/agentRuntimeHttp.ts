import type { AgentRuntimeInfo, RuntimeCapability, RuntimeJSONValue, RuntimeLimits, RuntimeToolSchema } from '@elysian/contracts'
import { RUNTIME_TOOL_NAMES } from '@elysian/contracts'
import { requestAgentJson } from './agentShared'

/*
 * GET /api/agent/runtime 的真实 HTTP 适配与响应解析。这是唯一挂在 503 组之外的
 * 端点：内核不可用时也可读（available:false + 中文 reason），页面先读它判定
 * 可用性与 12 个能力位，再决定渲染内容还是「内核不可用」状态。
 */

/** RuntimeInfo 携带的 12 个能力位；服务端按值序列化，全部必在响应里。 */
export const AGENT_RUNTIME_CAPABILITY_KEYS = [
  'batch', 'agent', 'skills', 'mcp', 'containerExecution', 'approvals',
  'workflow', 'wiki', 'embedding', 'workflowV2', 'resourceLocks', 'executionRuntimes',
] as const

export type AgentRuntimeCapabilityKey = (typeof AGENT_RUNTIME_CAPABILITY_KEYS)[number]

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function parseRuntimeCapability(value: unknown, label: string): RuntimeCapability {
  const row = object(value, `Agent 运行时能力位 ${label} 无效`)
  if (typeof row.available !== 'boolean' ||
    (row.reason !== undefined && typeof row.reason !== 'string')) {
    throw new Error(`Agent 运行时能力位 ${label} 无效`)
  }
  return row.reason === undefined ? { available: row.available } : { available: row.available, reason: row.reason }
}

/** Limits 的数值字段全部安全整数；可选字段缺省保持未知，不补零。 */
export function parseAgentRuntimeLimits(value: unknown): RuntimeLimits {
  const row = object(value, 'Agent 运行时限额无效')
  const required = ['concurrency', 'queueCapacity', 'maxSteps', 'inputBytes', 'callTimeoutSeconds',
    'runTimeoutSeconds', 'resultBytes', 'runResultBytes', 'logBytes', 'frameBytes', 'retentionDays', 'cancelGraceSeconds'] as const
  const limits: Record<string, number> = {}
  for (const key of required) {
    const entry = row[key]
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error('Agent 运行时限额无效')
    }
    limits[key] = entry
  }
  for (const key of ['maxModelRequests', 'modelTimeoutSeconds', 'outputTokens', 'tokenBudget', 'userBytes', 'memoryBytes', 'modelResponseBytes'] as const) {
    const entry = row[key]
    if (entry === undefined) continue
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error('Agent 运行时限额无效')
    }
    limits[key] = entry
  }
  return limits as RuntimeLimits
}

function parseRuntimeToolSchema(value: unknown): RuntimeToolSchema {
  const row = object(value, 'Agent 运行时工具描述无效')
  const name = row.name
  if (typeof name !== 'string' || !(RUNTIME_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new Error('Agent 运行时工具描述无效')
  }
  const parameters = row.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('Agent 运行时工具描述无效')
  }
  return {
    name: name as RuntimeToolSchema['name'],
    description: typeof row.description === 'string' ? row.description : '',
    parameters: parameters as Readonly<Record<string, RuntimeJSONValue>>,
  }
}

/** 解析 /runtime 响应为完整 AgentRuntimeInfo（12 能力位必在，缺任一即形状漂移）。 */
export function parseAgentRuntimeInfo(value: unknown): AgentRuntimeInfo {
  const row = object(value, 'Agent 运行时报告无效')
  if (typeof row.available !== 'boolean' || typeof row.worker !== 'string' ||
    typeof row.storage !== 'string' || typeof row.queueDepth !== 'number' || !Array.isArray(row.tools)) {
    throw new Error('Agent 运行时报告无效')
  }
  if (row.reason !== undefined && typeof row.reason !== 'string') {
    throw new Error('Agent 运行时报告无效')
  }
  const info: Record<string, unknown> = {
    available: row.available,
    worker: row.worker,
    storage: row.storage,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    tools: row.tools.map(parseRuntimeToolSchema),
    limits: parseAgentRuntimeLimits(row.limits),
    queueDepth: row.queueDepth,
  }
  for (const key of AGENT_RUNTIME_CAPABILITY_KEYS) {
    info[key] = parseRuntimeCapability(row[key], key)
  }
  return info as unknown as AgentRuntimeInfo
}

/** 读取运行时能力报告；401 由共享出口上报，其余错误透传中文 reason。 */
export async function fetchAgentRuntime(baseUrl = '/api/agent', signal?: AbortSignal): Promise<AgentRuntimeInfo> {
  return parseAgentRuntimeInfo(await requestAgentJson(`${baseUrl}/runtime`, { signal }))
}

import type { AgentRevisionRef } from './capabilities.ts'

export type AgentResourceAccess = 'read' | 'write'
/** 资源身份不含规则修订；更新配置不能绕过同一资源的互斥。 */
export type AgentResourceClaim = { kind: string; authority: string; key: string; access: AgentResourceAccess; subtree?: boolean }
export type AgentResourceSelector = {
  source: 'mcp-tool' | 'mcp-resource' | 'mcp-prompt' | 'script'
  ref: AgentRevisionRef
  originalName?: string
  catalogDigest?: string
}
export type AgentResourceMapping = {
  kind: string
  authority: string
  access: AgentResourceAccess
  subtree?: boolean
} & ({ literal: string; pointer?: never } | { literal?: never; pointer: string })
export type AgentResourceRuleInput = {
  name: string
  enabled: boolean
  complete: boolean
  selector: AgentResourceSelector
  mappings: readonly AgentResourceMapping[]
}
export type AgentResourceRule = AgentResourceRuleInput & { id: string; revision: number; digest: string; createdAt: string }
export type AgentUpdateResourceRuleInput = AgentResourceRuleInput & { expectedRevision: number }
export const AGENT_RESOURCE_LEASE_STATUSES = ['waiting', 'held', 'unknown', 'released'] as const
export type AgentResourceLeaseStatus = (typeof AGENT_RESOURCE_LEASE_STATUSES)[number]
export const AGENT_RESOURCE_LEASE_STATUS_LABELS: Record<AgentResourceLeaseStatus, string> = {
  waiting: '等待资源', held: '持有资源', unknown: '停止未确认', released: '已释放',
}
export type AgentResourceLease = {
  id: string
  source?: 'mcp-probe'
  serverId?: string
  serverRevision?: number
  containerId?: string
  runId?: string
  operationId?: string
  scopeId: string
  state: AgentResourceLeaseStatus
  claims: readonly AgentResourceClaim[]
  createdAt: string
  endedAt?: string
  evidence?: string
  decision?: 'confirmed-completed' | 'confirmed-stopped'
}
/** 仅核实无 Run/Operation 的 MCP 管理探测租约，不能代替运行节点恢复。 */
export type AgentResourceLeaseReconcileInput = { evidence: string; decision: 'confirmed-stopped' }

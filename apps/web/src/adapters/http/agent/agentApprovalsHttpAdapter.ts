import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentContextItem,
  AgentExecutionBarrier,
  AgentOperation,
  AgentResourceLease,
} from '@elysian/contracts'
import {
  AGENT_APPROVAL_STATUSES,
  AGENT_OPERATION_STATUSES,
} from '@elysian/contracts'
import type { AgentApprovalsAdapter } from '../../../contracts/adapters'
import { agentPathPart, agentQueryString, requestAgentJson } from './agentShared'

/*
 * 审批与治理域 HTTP 适配器。端点全部挂 /api/agent 前缀（capability_routes.go 与
 * extensions_routes.go 的 resource-locks 段）：
 * - GET /approvals?workflowId=、GET /execution-barriers?workflowId=（pending/approved
 *   优先、最多 200 条的服务端序）、GET /resource-locks（不带任何查询参数，服务端
 *   runtimeQuery 白名单会拒绝未知参数）、GET /runs/{id}/operations 与 /context-items；
 * - 写端点一律 POST，请求体只有 {decision}、{decision,evidence}、{evidence,decision}
 *   与 {revision,reason} 四种形状，均无 requestId 字段（服务端 DisallowUnknownFields）。
 * argumentsJson 等原文字段只按字符串搬运，绝不 JSON.parse 后重序列化。
 */

const POLICIES = ['', 'approval-required', 'trusted-read-only'] as const
const BARRIER_STATUSES = ['dispatched', 'unknown', 'confirmed', 'reconciled'] as const
const LEASE_STATES = ['waiting', 'held', 'unknown', 'released'] as const
const RECONCILIATION_DECISIONS = ['confirmed-completed', 'confirmed-stopped'] as const
const LEASE_SOURCES = ['mcp-probe'] as const

const encoder = new TextEncoder()

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function integer(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(message)
  return value
}

/** 执行计划里的授权完整解析（目录与出网端点会展示在审批详情中，不能丢字段）。 */
function parseExecutionGrant(value: unknown): NonNullable<AgentOperation['execution']>['grant'] {
  const row = object(value, 'Agent 操作执行计划无效')
  const directories = Array.isArray(row.directories) ? row.directories.map((item) => {
    const entry = object(item, 'Agent 操作执行计划无效')
    return { path: string(entry.path, 'Agent 操作执行计划无效'), access: enumValue(entry.access, ['ro', 'rw'] as const, 'Agent 操作执行计划无效') }
  }) : []
  const network = Array.isArray(row.network) ? row.network.map((item) => {
    const entry = object(item, 'Agent 操作执行计划无效')
    return {
      scheme: enumValue(entry.scheme, ['http', 'https'] as const, 'Agent 操作执行计划无效'),
      host: string(entry.host, 'Agent 操作执行计划无效'),
      port: integer(entry.port, 'Agent 操作执行计划无效'),
    }
  }) : []
  const privateCidrs = Array.isArray(row.privateCidrs) && row.privateCidrs.every((item) => typeof item === 'string')
    ? row.privateCidrs as readonly string[]
    : []
  return {
    id: string(row.id, 'Agent 操作执行计划无效'),
    revision: integer(row.revision, 'Agent 操作执行计划无效'),
    enabled: row.enabled === true,
    name: string(row.name, 'Agent 操作执行计划无效'),
    directories,
    network,
    privateCidrs,
    createdAt: string(row.createdAt, 'Agent 操作执行计划无效'),
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(message)
  return value as T
}

function revisionRef(value: unknown, message: string): { id: string; revision: number; digest?: string } {
  const row = object(value, message)
  return {
    id: string(row.id, message),
    revision: integer(row.revision, message),
    ...(row.digest === undefined ? {} : { digest: string(row.digest, message) }),
  }
}

/** Operation 权威字段逐项校验；argumentsJson 按服务端原文字符串保留。 */
export function parseAgentOperation(value: unknown): AgentOperation {
  const row = object(value, 'Agent 操作响应无效')
  const capabilityRow = object(row.capability, 'Agent 操作能力快照无效')
  const capability = {
    name: string(capabilityRow.name, 'Agent 操作能力快照无效'),
    description: string(capabilityRow.description, 'Agent 操作能力快照无效'),
    parameters: capabilityRow.parameters as AgentOperation['capability']['parameters'],
    source: string(capabilityRow.source, 'Agent 操作能力快照无效'),
    ref: revisionRef(capabilityRow.ref, 'Agent 操作能力快照无效'),
    ...(capabilityRow.originalName === undefined ? {} : { originalName: string(capabilityRow.originalName, 'Agent 操作能力快照无效') }),
    ...(capabilityRow.catalogDigest === undefined ? {} : { catalogDigest: string(capabilityRow.catalogDigest, 'Agent 操作能力快照无效') }),
    ...(capabilityRow.outputSchema === undefined ? {} : { outputSchema: capabilityRow.outputSchema as AgentOperation['capability']['outputSchema'] }),
    readOnly: capabilityRow.readOnly === true,
  }
  const execution = row.execution === undefined ? undefined : (() => {
    const plan = object(row.execution, 'Agent 操作执行计划无效')
    const profileRow = object(plan.profile, 'Agent 操作执行计划无效')
    const profile = {
      id: string(profileRow.id, 'Agent 操作执行计划无效'),
      revision: integer(profileRow.revision, 'Agent 操作执行计划无效'),
      enabled: profileRow.enabled === true,
      name: string(profileRow.name, 'Agent 操作执行计划无效'),
      image: string(profileRow.image, 'Agent 操作执行计划无效'),
      runtime: enumValue(profileRow.runtime, ['python', 'node', 'bash'] as const, 'Agent 操作执行计划无效'),
      command: Array.isArray(profileRow.command) && profileRow.command.every((item) => typeof item === 'string')
        ? profileRow.command as readonly string[]
        : (() => { throw new Error('Agent 操作执行计划无效') })(),
      timeoutSeconds: integer(profileRow.timeoutSeconds, 'Agent 操作执行计划无效'),
      cpuMillis: integer(profileRow.cpuMillis, 'Agent 操作执行计划无效'),
      memoryBytes: integer(profileRow.memoryBytes, 'Agent 操作执行计划无效'),
      pids: integer(profileRow.pids, 'Agent 操作执行计划无效'),
      createdAt: string(profileRow.createdAt, 'Agent 操作执行计划无效'),
    }
    const grant = plan.grant === undefined ? undefined : parseExecutionGrant(plan.grant)
    return { profile, ...(grant === undefined ? {} : { grant }), scriptDigest: string(plan.scriptDigest, 'Agent 操作执行计划无效') }
  })()
  return {
    ...(row.scopeId === undefined ? {} : { scopeId: string(row.scopeId, 'Agent 操作响应无效') }),
    ...(row.nodeId === undefined ? {} : { nodeId: string(row.nodeId, 'Agent 操作响应无效') }),
    ...(row.source === undefined ? {} : { source: string(row.source, 'Agent 操作响应无效') }),
    ...(row.workflowId === undefined ? {} : { workflowId: string(row.workflowId, 'Agent 操作响应无效') }),
    ...(row.workflowStepId === undefined ? {} : { workflowStepId: string(row.workflowStepId, 'Agent 操作响应无效') }),
    ...(row.workflowAttempt === undefined ? {} : { workflowAttempt: integer(row.workflowAttempt, 'Agent 操作响应无效') }),
    id: string(row.id, 'Agent 操作响应无效'),
    runId: string(row.runId, 'Agent 操作响应无效'),
    taskId: string(row.taskId, 'Agent 操作响应无效'),
    modelRequestId: string(row.modelRequestId, 'Agent 操作响应无效'),
    callIndex: integer(row.callIndex, 'Agent 操作响应无效'),
    modelCallId: string(row.modelCallId, 'Agent 操作响应无效'),
    argumentsJson: string(row.argumentsJson, 'Agent 操作响应无效'),
    capability,
    snapshotDigest: string(row.snapshotDigest, 'Agent 操作响应无效'),
    workspaceRevision: integer(row.workspaceRevision, 'Agent 操作响应无效'),
    ...(execution === undefined ? {} : { execution }),
    ...(row.resourceClaims === undefined ? {} : { resourceClaims: row.resourceClaims as AgentOperation['resourceClaims'] }),
    ...(row.resourceRules === undefined ? {} : {
      resourceRules: Array.isArray(row.resourceRules) && row.resourceRules.every((item) => typeof item === 'object')
        ? row.resourceRules.map((item) => revisionRef(item, 'Agent 操作响应无效'))
        : (() => { throw new Error('Agent 操作响应无效') })(),
    }),
    ...(row.claimsDigest === undefined ? {} : { claimsDigest: string(row.claimsDigest, 'Agent 操作响应无效') }),
    policy: enumValue(row.policy, POLICIES, 'Agent 操作响应无效'),
    status: enumValue(row.status, AGENT_OPERATION_STATUSES, 'Agent 操作响应无效'),
    ...(row.approvalId === undefined ? {} : { approvalId: string(row.approvalId, 'Agent 操作响应无效') }),
    callId: string(row.callId, 'Agent 操作响应无效'),
    ...(row.dispatchId === undefined ? {} : { dispatchId: string(row.dispatchId, 'Agent 操作响应无效') }),
    createdAt: string(row.createdAt, 'Agent 操作响应无效'),
    ...(row.dispatchedAt === undefined ? {} : { dispatchedAt: string(row.dispatchedAt, 'Agent 操作响应无效') }),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, 'Agent 操作响应无效') }),
    ...(row.error === undefined ? {} : { error: row.error as AgentOperation['error'] }),
  }
}

/** 审批：workflow-gate 与 operation 两形态共用入口，权威原文字段按字符串保留。 */
export function parseAgentApproval(value: unknown): AgentApproval {
  const row = object(value, 'Agent 审批响应无效')
  const common = {
    ...(row.scopeId === undefined ? {} : { scopeId: string(row.scopeId, 'Agent 审批响应无效') }),
    ...(row.nodeId === undefined ? {} : { nodeId: string(row.nodeId, 'Agent 审批响应无效') }),
    ...(row.workflowId === undefined ? {} : { workflowId: string(row.workflowId, 'Agent 审批响应无效') }),
    ...(row.workflowStepId === undefined ? {} : { workflowStepId: string(row.workflowStepId, 'Agent 审批响应无效') }),
    ...(row.workflowAttempt === undefined ? {} : { workflowAttempt: integer(row.workflowAttempt, 'Agent 审批响应无效') }),
    ...(row.contentDigest === undefined ? {} : { contentDigest: string(row.contentDigest, 'Agent 审批响应无效') }),
    ...(row.instruction === undefined ? {} : { instruction: string(row.instruction, 'Agent 审批响应无效') }),
    ...(row.inputJson === undefined ? {} : { inputJson: string(row.inputJson, 'Agent 审批响应无效') }),
    id: string(row.id, 'Agent 审批响应无效'),
    runId: string(row.runId, 'Agent 审批响应无效'),
    status: enumValue(row.status, AGENT_APPROVAL_STATUSES, 'Agent 审批响应无效'),
    createdAt: string(row.createdAt, 'Agent 审批响应无效'),
    expiresAt: string(row.expiresAt, 'Agent 审批响应无效'),
    ...(row.decidedAt === undefined ? {} : { decidedAt: string(row.decidedAt, 'Agent 审批响应无效') }),
    ...(row.decision === undefined ? {} : { decision: enumValue(row.decision, ['approved', 'denied'] as const, 'Agent 审批响应无效') }),
  }
  if (row.kind === 'workflow-gate') {
    if (common.workflowId === undefined || common.workflowStepId === undefined || common.workflowAttempt === undefined ||
      common.contentDigest === undefined || common.instruction === undefined || common.inputJson === undefined) {
      throw new Error('Agent 工作流审批响应无效')
    }
    return { kind: 'workflow-gate', ...common } as AgentApproval
  }
  return {
    ...(row.kind === undefined || row.kind === '' ? {} : { kind: enumValue(row.kind, ['operation'] as const, 'Agent 审批响应无效') }),
    ...common,
    operationId: string(row.operationId, 'Agent 审批响应无效'),
    operation: parseAgentOperation(row.operation),
  } as AgentApproval
}

export function parseAgentApprovals(value: unknown): readonly AgentApproval[] {
  if (!Array.isArray(value)) throw new Error('Agent 审批列表响应无效')
  return value.map(parseAgentApproval)
}

export function parseAgentOperations(value: unknown): readonly AgentOperation[] {
  if (!Array.isArray(value)) throw new Error('Agent 操作列表响应无效')
  return value.map(parseAgentOperation)
}

export function parseAgentContextItems(value: unknown): readonly AgentContextItem[] {
  if (!Array.isArray(value)) throw new Error('Agent 资料列表响应无效')
  return value.map((item) => {
    const row = object(item, 'Agent 资料响应无效')
    return {
      id: string(row.id, 'Agent 资料响应无效'),
      runId: string(row.runId, 'Agent 资料响应无效'),
      taskId: string(row.taskId, 'Agent 资料响应无效'),
      source: string(row.source, 'Agent 资料响应无效'),
      ref: revisionRef(row.ref, 'Agent 资料响应无效'),
      ...(row.path === undefined ? {} : { path: string(row.path, 'Agent 资料响应无效') }),
      digest: string(row.digest, 'Agent 资料响应无效'),
      content: string(row.content, 'Agent 资料响应无效'),
      createdAt: string(row.createdAt, 'Agent 资料响应无效'),
      eventSeq: string(row.eventSeq, 'Agent 资料响应无效'),
      ...(row.callId === undefined ? {} : { callId: string(row.callId, 'Agent 资料响应无效') }),
    }
  })
}

export function parseAgentExecutionBarrier(value: unknown): AgentExecutionBarrier {
  const row = object(value, 'Agent 执行屏障响应无效')
  return {
    ...(row.scopeId === undefined ? {} : { scopeId: string(row.scopeId, 'Agent 执行屏障响应无效') }),
    ...(row.nodeId === undefined ? {} : { nodeId: string(row.nodeId, 'Agent 执行屏障响应无效') }),
    ...(row.workflowId === undefined ? {} : { workflowId: string(row.workflowId, 'Agent 执行屏障响应无效') }),
    id: string(row.id, 'Agent 执行屏障响应无效'),
    runId: string(row.runId, 'Agent 执行屏障响应无效'),
    operationId: string(row.operationId, 'Agent 执行屏障响应无效'),
    status: enumValue(row.status, BARRIER_STATUSES, 'Agent 执行屏障响应无效'),
    createdAt: string(row.createdAt, 'Agent 执行屏障响应无效'),
    ...(row.evidence === undefined ? {} : { evidence: string(row.evidence, 'Agent 执行屏障响应无效') }),
    ...(row.decision === undefined ? {} : { decision: enumValue(row.decision, RECONCILIATION_DECISIONS, 'Agent 执行屏障响应无效') }),
    ...(row.reconciledAt === undefined ? {} : { reconciledAt: string(row.reconciledAt, 'Agent 执行屏障响应无效') }),
  }
}

export function parseAgentExecutionBarriers(value: unknown): readonly AgentExecutionBarrier[] {
  if (!Array.isArray(value)) throw new Error('Agent 执行屏障列表响应无效')
  return value.map(parseAgentExecutionBarrier)
}

export function parseAgentResourceLease(value: unknown): AgentResourceLease {
  const row = object(value, 'Agent 资源租约响应无效')
  return {
    id: string(row.id, 'Agent 资源租约响应无效'),
    ...(row.source === undefined ? {} : { source: enumValue(row.source, LEASE_SOURCES, 'Agent 资源租约响应无效') }),
    ...(row.serverId === undefined ? {} : { serverId: string(row.serverId, 'Agent 资源租约响应无效') }),
    ...(row.serverRevision === undefined ? {} : { serverRevision: integer(row.serverRevision, 'Agent 资源租约响应无效') }),
    ...(row.containerId === undefined ? {} : { containerId: string(row.containerId, 'Agent 资源租约响应无效') }),
    ...(row.runId === undefined ? {} : { runId: string(row.runId, 'Agent 资源租约响应无效') }),
    ...(row.operationId === undefined ? {} : { operationId: string(row.operationId, 'Agent 资源租约响应无效') }),
    scopeId: string(row.scopeId, 'Agent 资源租约响应无效'),
    state: enumValue(row.state, LEASE_STATES, 'Agent 资源租约响应无效'),
    claims: row.claims === undefined ? [] : row.claims as AgentResourceLease['claims'],
    createdAt: string(row.createdAt, 'Agent 资源租约响应无效'),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, 'Agent 资源租约响应无效') }),
    ...(row.evidence === undefined ? {} : { evidence: string(row.evidence, 'Agent 资源租约响应无效') }),
    ...(row.decision === undefined ? {} : { decision: enumValue(row.decision, RECONCILIATION_DECISIONS, 'Agent 资源租约响应无效') }),
  }
}

export function parseAgentResourceLeases(value: unknown): readonly AgentResourceLease[] {
  if (!Array.isArray(value)) throw new Error('Agent 资源租约列表响应无效')
  return value.map(parseAgentResourceLease)
}

export function parseAgentRevokeResult(value: unknown): { revoked: boolean } {
  const row = object(value, 'Agent 能力撤销响应无效')
  if (typeof row.revoked !== 'boolean') throw new Error('Agent 能力撤销响应无效')
  return { revoked: row.revoked }
}

/** 核实证据按字节校验（服务端 Go len() 同口径）：1 到 8192 字节。 */
export function assertReconciliationEvidenceBytes(evidence: string): string {
  if (encoder.encode(evidence).length < 1 || encoder.encode(evidence).length > 8192) {
    throw new Error('核实证据必须为 1 到 8192 字节')
  }
  return evidence
}

/** 撤销原因按字节校验（服务端 materials.go:124 同口径）：1 到 2048 字节。 */
export function assertRevokeReasonBytes(reason: string): string {
  if (encoder.encode(reason).length < 1 || encoder.encode(reason).length > 2048) {
    throw new Error('撤销原因必须为 1 到 2048 字节')
  }
  return reason
}

function assertApprovalDecision(decision: AgentApprovalDecision): AgentApprovalDecision {
  if (decision !== 'approved' && decision !== 'denied') {
    throw new Error('审批决定必须为 approved 或 denied')
  }
  return decision
}

function assertReconciliationDecision(decision: string): 'confirmed-completed' | 'confirmed-stopped' {
  if (decision !== 'confirmed-completed' && decision !== 'confirmed-stopped') {
    throw new Error('核实决定必须为 confirmed-completed 或 confirmed-stopped')
  }
  return decision
}

function filteredUrl(baseUrl: string, path: string, workflowId?: string): string {
  const query = agentQueryString({ workflowId })
  return `${baseUrl}${path}${query === '' ? '' : `?${query}`}`
}

export function createHttpAgentApprovalsAdapter(baseUrl = '/api/agent'): AgentApprovalsAdapter {
  const id = (value: string, label: string) => agentPathPart(value, label)
  return {
    async listApprovals(workflowId, signal) {
      return parseAgentApprovals(await requestAgentJson(filteredUrl(baseUrl, '/approvals', workflowId), { signal }))
    },
    async decideApproval(approvalId, input) {
      assertApprovalDecision(input.decision)
      return parseAgentApproval(await requestAgentJson(
        `${baseUrl}/approvals/${id(approvalId, '审批标识')}/decision`,
        { method: 'POST', body: JSON.stringify({ decision: input.decision }) },
      ))
    },
    async listOperations(runId, signal) {
      return parseAgentOperations(await requestAgentJson(`${baseUrl}/runs/${id(runId, '运行标识')}/operations`, { signal }))
    },
    async listContextItems(runId, signal) {
      return parseAgentContextItems(await requestAgentJson(`${baseUrl}/runs/${id(runId, '运行标识')}/context-items`, { signal }))
    },
    async listBarriers(workflowId, signal) {
      return parseAgentExecutionBarriers(await requestAgentJson(filteredUrl(baseUrl, '/execution-barriers', workflowId), { signal }))
    },
    async reconcileBarrier(barrierId, input) {
      assertReconciliationEvidenceBytes(input.evidence)
      assertReconciliationDecision(input.decision)
      return parseAgentExecutionBarrier(await requestAgentJson(
        `${baseUrl}/execution-barriers/${id(barrierId, '屏障标识')}/reconcile`,
        { method: 'POST', body: JSON.stringify({ decision: input.decision, evidence: input.evidence }) },
      ))
    },
    async listResourceLocks(signal) {
      // /resource-locks 不接受任何查询参数（服务端 runtimeQuery 白名单）；过滤由前端做。
      return parseAgentResourceLeases(await requestAgentJson(`${baseUrl}/resource-locks`, { signal }))
    },
    async reconcileResourceLock(lockId, input) {
      assertReconciliationEvidenceBytes(input.evidence)
      if (input.decision !== 'confirmed-stopped') {
        throw new Error('探测租约核实决定必须为 confirmed-stopped')
      }
      return parseAgentResourceLease(await requestAgentJson(
        `${baseUrl}/resource-locks/${id(lockId, '租约标识')}/reconcile`,
        { method: 'POST', body: JSON.stringify({ evidence: input.evidence, decision: input.decision }) },
      ))
    },
    async revokeSkill(skillId, revision, reason) {
      return parseAgentRevokeResult(await requestAgentJson(
        `${baseUrl}/skills/${id(skillId, '技能标识')}/revoke`,
        { method: 'POST', body: JSON.stringify({ revision, reason: assertRevokeReasonBytes(reason) }) },
      ))
    },
    async revokeMcpServer(serverId, revision, reason) {
      return parseAgentRevokeResult(await requestAgentJson(
        `${baseUrl}/mcp-servers/${id(serverId, 'MCP 服务标识')}/revoke`,
        { method: 'POST', body: JSON.stringify({ revision, reason: assertRevokeReasonBytes(reason) }) },
      ))
    },
    async revokeExecutionProfile(profileId, revision, reason) {
      return parseAgentRevokeResult(await requestAgentJson(
        `${baseUrl}/execution-profiles/${id(profileId, '执行配置标识')}/revoke`,
        { method: 'POST', body: JSON.stringify({ revision, reason: assertRevokeReasonBytes(reason) }) },
      ))
    },
    async revokeGrant(grantId, revision, reason) {
      return parseAgentRevokeResult(await requestAgentJson(
        `${baseUrl}/grants/${id(grantId, '授权标识')}/revoke`,
        { method: 'POST', body: JSON.stringify({ revision, reason: assertRevokeReasonBytes(reason) }) },
      ))
    },
  }
}

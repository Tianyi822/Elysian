import type { RuntimeFailure, RuntimeJSONValue } from './runtime.ts'
import type { AgentResourceClaim, AgentResourceRule } from './resources.ts'
import type { AgentWikiRef } from './memory.ts'

/** 不可变配置身份；digest 用于固定包、目录或环境内容。 */
export type AgentRevisionRef = { id: string; revision: number; digest?: string }
export type AgentResourceRef = { serverId: string; uri: string }
export type AgentPromptRef = { serverId: string; name: string; arguments: Readonly<Record<string, string>> }

/** 会话固定环境。目录中的提示与服务器 annotations 不自动授予权限。 */
export type AgentEnvironment = {
  sessionId: string
  revision: number
  skills: readonly AgentRevisionRef[]
  servers: readonly AgentRevisionRef[]
  tools: readonly string[]
  resources: readonly AgentResourceRef[]
  executionProfiles: readonly AgentRevisionRef[]
  grants: readonly AgentRevisionRef[]
  trustedReadOnly: readonly string[]
  resourceRules?: readonly AgentRevisionRef[]
}
export type AgentJSONSchema = boolean | Readonly<Record<string, RuntimeJSONValue>>
export type AgentCapability = {
  name: string
  description: string
  parameters: AgentJSONSchema
  source: string
  ref: AgentRevisionRef
  originalName?: string
  catalogDigest?: string
  outputSchema?: AgentJSONSchema
  readOnly: boolean
}
export type AgentSkillSummary = { ref: AgentRevisionRef; name: string; description: string }
export type AgentCapabilitySnapshot = {
  environment: AgentEnvironment
  tools: readonly AgentCapability[]
  materials?: readonly AgentCapability[]
  skillSummaries?: readonly AgentSkillSummary[]
  executionProfiles?: readonly AgentExecutionProfile[]
  grants?: readonly AgentExecutionGrant[]
  resourceRules?: readonly AgentResourceRule[]
  digest: string
}
export type AgentExecutionPlan = { profile: AgentExecutionProfile; grant?: AgentExecutionGrant; scriptDigest: string }
export type AgentRecoveryCursor = { responseId: string; callIndex: number }

export const AGENT_OPERATION_STATUSES = ['planned', 'waiting-approval', 'waiting-resource', 'dispatched', 'completed', 'unknown'] as const
export type AgentOperationStatus = (typeof AGENT_OPERATION_STATUSES)[number]
export const AGENT_OPERATION_STATUS_LABELS: Record<AgentOperationStatus, string> = {
  planned: '已规划', 'waiting-approval': '等待审批', 'waiting-resource': '等待资源', dispatched: '已派发', completed: '已确认完成', unknown: '结果未确认',
}
export type AgentOperation = {
  /** workflow/v2 执行树定位：所属作用域与节点；非工作流运行为空。 */
  scopeId?: string
  nodeId?: string
  source?: string
  workflowId?: string
  workflowStepId?: string
  workflowAttempt?: number
  id: string
  runId: string
  taskId: string
  modelRequestId: string
  callIndex: number
  modelCallId: string
  /** 权威参数原文；显示和审批不得经 JSON.parse 后重序列化来决定执行内容。 */
  argumentsJson: string
  capability: AgentCapability
  snapshotDigest: string
  workspaceRevision: number
  execution?: AgentExecutionPlan
  resourceClaims?: readonly AgentResourceClaim[]
  resourceRules?: readonly AgentRevisionRef[]
  claimsDigest?: string
  policy: '' | 'approval-required' | 'trusted-read-only'
  status: AgentOperationStatus
  approvalId?: string
  callId: string
  dispatchId?: string
  createdAt: string
  dispatchedAt?: string
  endedAt?: string
  error?: RuntimeFailure
}
export const AGENT_APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'consumed', 'revoked'] as const
export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number]
export const AGENT_APPROVAL_STATUS_LABELS: Record<AgentApprovalStatus, string> = {
  pending: '待审批', approved: '已同意', denied: '已拒绝', expired: '已过期', consumed: '已执行审批', revoked: '已撤销',
}
export type AgentApprovalDecision = 'approved' | 'denied'
type AgentApprovalCommon = {
  /** workflow/v2 执行树定位：所属作用域与节点；非工作流审批为空。 */
  scopeId?: string
  nodeId?: string
  workflowId?: string
  workflowStepId?: string
  workflowAttempt?: number
  contentDigest?: string
  instruction?: string
  inputJson?: string
  id: string
  runId: string
  status: AgentApprovalStatus
  createdAt: string
  expiresAt: string
  decidedAt?: string
  decision?: AgentApprovalDecision
}
export type AgentOperationApproval = AgentApprovalCommon & {
  kind?: '' | 'operation'
  operationId: string
  operation: AgentOperation
}
export type AgentWorkflowApproval = AgentApprovalCommon & {
  kind: 'workflow-gate'
  workflowId: string
  workflowStepId: string
  workflowAttempt: number
  contentDigest: string
  instruction: string
  inputJson: string
  operationId?: never
  operation?: never
}
export type AgentApproval = AgentOperationApproval | AgentWorkflowApproval
export type AgentApprovalDecisionInput = { decision: AgentApprovalDecision }
export type AgentExecutionBarrierStatus = 'dispatched' | 'unknown' | 'confirmed' | 'reconciled'
export type AgentReconciliationDecision = 'confirmed-completed' | 'confirmed-stopped'
export type AgentExecutionBarrier = {
  /** workflow/v2 执行树定位：所属作用域与节点；非工作流屏障为空。 */
  scopeId?: string
  nodeId?: string
  workflowId?: string
  id: string
  runId: string
  operationId: string
  status: AgentExecutionBarrierStatus
  createdAt: string
  evidence?: string
  decision?: AgentReconciliationDecision
  reconciledAt?: string
}
export type AgentReconciliationInput = { evidence: string; decision: AgentReconciliationDecision }
export type AgentContextItem = {
  id: string
  runId: string
  taskId: string
  source: string
  ref: AgentRevisionRef
  path?: string
  digest: string
  content: string
  createdAt: string
  eventSeq: string
  callId?: string
}

export type AgentWorkspaceFile = { path: string; size: number; digest: string }
export type AgentWorkspaceVersion = {
  taskId: string
  revision: number
  baseRevision: number
  bytes: number
  fileCount: number
  digest: string
}
export type AgentWorkspaceSnapshot = AgentWorkspaceVersion & { files: readonly AgentWorkspaceFile[] }
export type AgentWorkspaceView = {
  version: AgentWorkspaceVersion
  files?: readonly AgentWorkspaceFile[]
  path?: string
  /** 文件内容按 JSON 标准以 base64 返回。 */
  content?: string
  quarantined?: boolean
  wikiSources?: readonly AgentWikiRef[]
}

export type AgentSkillSource = {
  kind: 'directory' | 'zip' | 'git'
  path?: string
  url?: string
  ref?: string
  subdirectory?: string
  /** 服务端解析的完整提交，不接受导入请求预填。 */
  commit?: string
}
export type AgentSkillManifest = {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Readonly<Record<string, string>>
  /** 技能自述的需求，不能替代环境授权与逐调用审批。 */
  allowedTools?: string
}
export type AgentSkill = {
  id: string
  revision: number
  createdAt: string
  enabled: boolean
  source: AgentSkillSource
  manifest: AgentSkillManifest
  digest: string
  bytes: number
  files: readonly AgentWorkspaceFile[]
}
export type AgentSkillFilePreview = {
  skillId: string
  revision: number
  path: string
  previewable: boolean
  content?: string
  reason?: 'binary' | 'too-large'
}
export type AgentCapabilityKind = 'skill' | 'mcp' | 'execution-profile' | 'grant'
export type AgentCapabilityRevocation = {
  /** SQLite row cursor is kept as a decimal string to avoid precision loss. */
  cursor: string
  kind: AgentCapabilityKind
  id: string
  /** Zero revokes every revision of this capability. */
  revision: number
  reason: string
  createdAt: string
}
export type AgentCapabilityRevocationQuery = {
  kind?: AgentCapabilityKind
  id?: string
  cursor?: string
  limit?: number
}
export type AgentCapabilityRevocationPage = {
  items: readonly AgentCapabilityRevocation[]
  nextCursor: string
  hasMore: boolean
}
export type AgentSkillImportInput = {
  requestId: string
  skillId?: string
  expectedRevision?: number
  source: Omit<AgentSkillSource, 'commit'>
  enabled: boolean
  /** 可选的 Git 只写凭据，不进入导入任务或技能来源。 */
  credential?: string
}
export type AgentSkillImportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type AgentSkillImportTask = {
  id: string
  requestId: string
  state: AgentSkillImportStatus
  source: AgentSkillSource
  createdAt: string
  startedAt?: string
  endedAt?: string
  cancelRequestedAt?: string
  skillId?: string
  revision?: number
  error?: RuntimeFailure
}
export type AgentSkillImportLimits = { packageBytes: number; archiveBytes: number; files: number; queue: number }

export type AgentExecutionProfile = {
  id: string
  revision: number
  enabled: boolean
  name: string
  image: string
  runtime: 'python' | 'node' | 'bash'
  command: readonly string[]
  timeoutSeconds: number
  cpuMillis: number
  memoryBytes: number
  pids: number
  createdAt: string
}
export type AgentExecutionProfileInput = Omit<AgentExecutionProfile, 'id' | 'revision' | 'createdAt'> & { id?: string; expectedRevision: number }
export type AgentDirectoryGrant = { path: string; access: 'ro' | 'rw' }
export type AgentNetworkEndpoint = { scheme: 'http' | 'https'; host: string; port: number }
export type AgentExecutionGrant = {
  id: string
  revision: number
  enabled: boolean
  name: string
  directories: readonly AgentDirectoryGrant[]
  network: readonly AgentNetworkEndpoint[]
  privateCidrs: readonly string[]
  createdAt: string
}
export type AgentExecutionGrantInput = Omit<AgentExecutionGrant, 'id' | 'revision' | 'createdAt'> & { id?: string; expectedRevision: number }

export const AGENT_MCP_PROTOCOL_VERSION = '2025-11-25' as const
export type AgentMCPContainerSpec = {
  image: string
  command: readonly string[]
  hasEnvironment: boolean
  /** 容器挂载与出网授权必须固定具体修订；省略二者表示无授权。 */
  grantId?: string
  grantRevision?: number
}
/** 公开配置不含 credential 和容器 environment。 */
export type AgentMCPServer = {
  id: string
  revision: number
  name: string
  transport: 'streamable-http' | 'stdio'
  url?: string
  stdio?: AgentMCPContainerSpec
  active: boolean
  revoked: boolean
  hasCredential: boolean
}
export type AgentMCPServerInput = {
  name: string
  transport: 'streamable-http' | 'stdio'
  url?: string
  stdio?: {
    image: string
    command: readonly string[]
    environment?: Readonly<Record<string, string>>
    grantId?: string
    grantRevision?: number
  }
  active: boolean
  revoked: boolean
  /** 只写凭据；省略沿用旧值，空串清除。 */
  credential?: string
}
export type AgentUpdateMCPServerInput = AgentMCPServerInput & { expectedRevision: number }
export type AgentMCPTool = {
  name: string
  title?: string
  description?: string
  inputSchema: AgentJSONSchema
  outputSchema?: AgentJSONSchema
  annotations?: Readonly<Record<string, RuntimeJSONValue>>
}
export type AgentMCPResource = { uri: string; name: string; title?: string; description?: string; mimeType?: string }
export type AgentMCPPromptArgument = { name: string; description?: string; required?: boolean }
export type AgentMCPPrompt = { name: string; title?: string; description?: string; arguments?: readonly AgentMCPPromptArgument[] }
export type AgentMCPCatalog = {
  protocolVersion: typeof AGENT_MCP_PROTOCOL_VERSION
  capabilities: { tools: boolean; resources: boolean; prompts: boolean }
  tools: readonly AgentMCPTool[]
  resources: readonly AgentMCPResource[]
  prompts: readonly AgentMCPPrompt[]
  digest: string
  fetchedAt: string
}
/** 目录 API 的模型名称映射；会话工具和显式只读信任采用这些别名。 */
export type AgentMCPCatalogProjection = AgentMCPCatalog & {
  modelAliases: Readonly<Record<string, string>>
  resourceAliases: Readonly<Record<string, string>>
  promptAliases: Readonly<Record<string, string>>
}
export type AgentMCPResourceContent = { uri: string; mimeType?: string } & ({ text: string; blob?: never } | { blob: string; text?: never })
export type AgentMCPContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: AgentMCPResourceContent }
  | ({ type: 'resource_link' } & AgentMCPResource)
export type AgentMCPCallResult = {
  requestId: string
  connectionId: string
  content: readonly AgentMCPContent[]
  structuredContent?: Readonly<Record<string, RuntimeJSONValue>>
  isError: boolean
}
export type AgentMCPResourceResult = { requestId: string; connectionId: string; contents: readonly AgentMCPResourceContent[] }
export type AgentMCPPromptResult = {
  requestId: string
  connectionId: string
  description?: string
  messages: readonly { role: 'user' | 'assistant'; content: AgentMCPContent }[]
}

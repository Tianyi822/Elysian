import type {
  AgentWorkflowAttempt,
  AgentWorkflowBinding,
  AgentWorkflowCondition,
  AgentWorkflowDefinition,
  AgentWorkflowEvent,
  AgentWorkflowExecutionTree,
  AgentWorkflowInstance,
  AgentWorkflowLanguageVersion,
  AgentWorkflowNodeExecution,
  AgentWorkflowRecoveryAction,
  AgentWorkflowRecoveryInput,
  AgentWorkflowScope,
  AgentWorkflowStatus,
  AgentWorkflowStepDefinition,
  RuntimeFailure,
} from '@elysian/contracts'
import { AGENT_WORKFLOW_CONDITION_OPERATORS, AGENT_WORKFLOW_RECOVERY_ACTIONS, AGENT_WORKFLOW_STATUSES, AGENT_WORKFLOW_STEP_KINDS, RUNTIME_RUN_STATUSES } from '@elysian/contracts'
import type { AgentPageQuery, AgentWorkflowsAdapter } from '../../../contracts/adapters'
import { agentPathPart, agentQueryString, assertDecimalCursor, parseAgentPage, requestAgentJson } from './agentShared'

/*
 * 工作流域 HTTP 适配器。端点与请求体形状按服务端 workflow_routes.go：
 * - 模板创建/更新的体是模板字段本身（更新体在顶层平铺 expectedRevision），
 *   都不带 requestId（readWorkflowBody 的 DisallowUnknownFields 多带即 400）；
 * - 实例创建（CreateWorkflowInput）与恢复（WorkflowRecoveryInput）带 requestId；
 * - 取消实例没有请求体；
 * - 实例列表查询白名单是 status/cursor/limit，步骤与事件分页白名单是 cursor/limit；
 * - 执行树端点对 v1 实例返回空 scopes/nodes（rootScopeId 为空串）。
 * GET 侧 Content-Type 恒 application/json（requestAgentJson）；
 * 服务端 {error,code} 经 agentShared 透传中文 error。
 */

const PAGE_LIMIT = 50

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function number(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(message)
  return value
}

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(message)
  return value as T
}

function failure(value: unknown, message: string): RuntimeFailure | undefined {
  if (value === undefined || value === null) return undefined
  const row = object(value, message)
  return { code: string(row.code, message), message: string(row.message, message) }
}

const BINDING_KEYS = ['literalJson', 'input', 'step', 'object', 'array'] as const
/** 绑定五选一：恰好一个值来源；object/array 允许空容器。 */
export function parseWorkflowBinding(value: unknown): AgentWorkflowBinding {
  const row = object(value, '工作流绑定响应无效')
  const present = BINDING_KEYS.filter((key) => row[key] !== undefined)
  if (present.length !== 1) throw new Error('工作流绑定响应无效')
  const key = present[0]
  if (key === undefined) throw new Error('工作流绑定响应无效')
  if (key === 'literalJson' || key === 'input') {
    string(row[key], '工作流绑定响应无效')
    return row as AgentWorkflowBinding
  }
  if (key === 'step') {
    const step = object(row.step, '工作流绑定响应无效')
    string(step.stepId, '工作流绑定响应无效')
    string(step.pointer, '工作流绑定响应无效')
    return row as AgentWorkflowBinding
  }
  if (key === 'object') {
    const entries = object(row.object, '工作流绑定响应无效')
    for (const child of Object.values(entries)) parseWorkflowBinding(child)
    return row as AgentWorkflowBinding
  }
  if (!Array.isArray(row.array)) throw new Error('工作流绑定响应无效')
  for (const child of row.array) parseWorkflowBinding(child)
  return row as AgentWorkflowBinding
}

function parseWorkflowSelection(value: unknown): NonNullable<AgentWorkflowStepDefinition['selection']> {
  const row = object(value, '步骤资料选择响应无效')
  return {
    requestId: string(row.requestId ?? '', '步骤资料选择响应无效'),
    content: string(row.content ?? '', '步骤资料选择响应无效'),
    ...(row.skills === undefined ? {} : {
      skills: (Array.isArray(row.skills) ? row.skills : []).map((item) => {
        const ref = object(item, '步骤资料选择响应无效')
        return {
          id: string(ref.id, '步骤资料选择响应无效'),
          revision: number(ref.revision, '步骤资料选择响应无效'),
          ...(ref.digest === undefined ? {} : { digest: string(ref.digest, '步骤资料选择响应无效') }),
        }
      }),
    }),
    ...(row.resources === undefined ? {} : {
      resources: (Array.isArray(row.resources) ? row.resources : []).map((item) => {
        const ref = object(item, '步骤资料选择响应无效')
        return { serverId: string(ref.serverId, '步骤资料选择响应无效'), uri: string(ref.uri, '步骤资料选择响应无效') }
      }),
    }),
    ...(row.prompts === undefined ? {} : {
      prompts: (Array.isArray(row.prompts) ? row.prompts : []).map((item) => {
        const ref = object(item, '步骤资料选择响应无效')
        const args = object(ref.arguments, '步骤资料选择响应无效')
        return {
          serverId: string(ref.serverId, '步骤资料选择响应无效'),
          name: string(ref.name, '步骤资料选择响应无效'),
          arguments: Object.fromEntries(Object.entries(args).map(([key, arg]) => [key, string(arg, '步骤资料选择响应无效')])),
        }
      }),
    }),
  }
}

export function parseWorkflowStepDefinition(value: unknown): AgentWorkflowStepDefinition {
  const row = object(value, '工作流步骤响应无效')
  return {
    id: string(row.id, '工作流步骤响应无效'),
    kind: enumValue(row.kind, AGENT_WORKFLOW_STEP_KINDS, '工作流步骤响应无效'),
    ...(row.instruction === undefined ? {} : { instruction: string(row.instruction, '工作流步骤响应无效') }),
    ...(row.capability === undefined ? {} : { capability: string(row.capability, '工作流步骤响应无效') }),
    input: parseWorkflowBinding(row.input),
    outputSchemaJson: string(row.outputSchemaJson, '工作流步骤响应无效'),
    ...(row.next === undefined ? {} : { next: string(row.next, '工作流步骤响应无效') }),
    ...(row.condition === undefined ? {} : { condition: parseWorkflowCondition(row.condition) }),
    ...(row.then === undefined ? {} : { then: string(row.then, '工作流步骤响应无效') }),
    ...(row.else === undefined ? {} : { else: string(row.else, '工作流步骤响应无效') }),
    ...(row.finish === undefined ? {} : { finish: parseWorkflowBinding(row.finish) }),
    ...(row.selection === undefined ? {} : { selection: parseWorkflowSelection(row.selection) }),
    ...(row.parallel === undefined ? {} : { parallel: parseWorkflowParallel(row.parallel) }),
    ...(row.foreach === undefined ? {} : { foreach: parseWorkflowForeach(row.foreach) }),
    ...(row.subworkflow === undefined ? {} : { subworkflow: parseWorkflowSubworkflow(row.subworkflow) }),
  }
}

function parseWorkflowCondition(value: unknown): AgentWorkflowCondition {
  const row = object(value, '工作流条件响应无效')
  return {
    op: enumValue(row.op, AGENT_WORKFLOW_CONDITION_OPERATORS, '工作流条件响应无效'),
    ...(row.left === undefined ? {} : { left: parseWorkflowBinding(row.left) }),
    ...(row.right === undefined ? {} : { right: parseWorkflowBinding(row.right) }),
    ...(row.children === undefined
      ? {}
      : { children: (Array.isArray(row.children) ? row.children : []).map(parseWorkflowCondition) }),
  }
}

function parseWorkflowBody(value: unknown): AgentWorkflowScope['body'] {
  const row = object(value, '工作流主体响应无效')
  return {
    entry: string(row.entry, '工作流主体响应无效'),
    steps: (Array.isArray(row.steps) ? row.steps : []).map(parseWorkflowStepDefinition),
    outputSchemaJson: string(row.outputSchemaJson, '工作流主体响应无效'),
  }
}

function parseWorkflowParallel(value: unknown): NonNullable<AgentWorkflowStepDefinition['parallel']> {
  const row = object(value, '并行分支响应无效')
  if (row.join !== 'all') throw new Error('并行分支响应无效')
  const branches = Array.isArray(row.branches) ? row.branches : []
  return {
    join: 'all',
    branches: branches.map((branch) => {
      const branchRow = object(branch, '并行分支响应无效')
      return {
        id: string(branchRow.id, '并行分支响应无效'),
        input: parseWorkflowBinding(branchRow.input),
        body: parseWorkflowBody(branchRow.body),
      }
    }),
  }
}

function parseWorkflowForeach(value: unknown): NonNullable<AgentWorkflowStepDefinition['foreach']> {
  const row = object(value, '遍历步骤响应无效')
  return {
    items: parseWorkflowBinding(row.items),
    body: parseWorkflowBody(row.body),
  }
}

function parseWorkflowSubworkflow(value: unknown): NonNullable<AgentWorkflowStepDefinition['subworkflow']> {
  const row = object(value, '子流程响应无效')
  return {
    definitionId: string(row.definitionId, '子流程响应无效'),
    definitionRevision: number(row.definitionRevision, '子流程响应无效'),
  }
}

export function parseWorkflowDefinition(value: unknown): AgentWorkflowDefinition {
  const row = object(value, '工作流模板响应无效')
  const definition: AgentWorkflowDefinition = {
    id: string(row.id, '工作流模板响应无效'),
    revision: number(row.revision, '工作流模板响应无效'),
    name: string(row.name, '工作流模板响应无效'),
    enabled: boolean(row.enabled, '工作流模板响应无效'),
    goal: string(row.goal, '工作流模板响应无效'),
    inputSchemaJson: string(row.inputSchemaJson, '工作流模板响应无效'),
    outputSchemaJson: string(row.outputSchemaJson, '工作流模板响应无效'),
    entry: string(row.entry, '工作流模板响应无效'),
    steps: (Array.isArray(row.steps) ? row.steps : []).map(parseWorkflowStepDefinition),
    createdAt: string(row.createdAt, '工作流模板响应无效'),
    ...(row.languageVersion === undefined ? {} : { languageVersion: parseLanguageVersion(row.languageVersion, '工作流模板响应无效') }),
  }
  return definition
}

export function parseWorkflowDefinitions(value: unknown): readonly AgentWorkflowDefinition[] {
  if (!Array.isArray(value)) throw new Error('工作流模板列表响应无效')
  return value.map(parseWorkflowDefinition)
}

export function parseWorkflowScope(value: unknown): AgentWorkflowScope {
  const row = object(value, '工作流作用域响应无效')
  return {
    id: string(row.id, '工作流作用域响应无效'),
    workflowId: string(row.workflowId, '工作流作用域响应无效'),
    ...(row.parentScopeId === undefined ? {} : { parentScopeId: string(row.parentScopeId, '工作流作用域响应无效') }),
    ...(row.parentNodeId === undefined ? {} : { parentNodeId: string(row.parentNodeId, '工作流作用域响应无效') }),
    path: string(row.path, '工作流作用域响应无效'),
    kind: string(row.kind, '工作流作用域响应无效'),
    taskId: string(row.taskId, '工作流作用域响应无效'),
    parentWorkspaceRevision: number(row.parentWorkspaceRevision, '工作流作用域响应无效'),
    parentMemoryRevision: number(row.parentMemoryRevision, '工作流作用域响应无效'),
    depth: number(row.depth, '工作流作用域响应无效'),
    ordinal: number(row.ordinal, '工作流作用域响应无效'),
    status: parseNodeStatus(row.status, '工作流作用域响应无效'),
    currentStepId: string(row.currentStepId, '工作流作用域响应无效'),
    inputJson: string(row.inputJson, '工作流作用域响应无效'),
    ...(row.outputJson === undefined ? {} : { outputJson: string(row.outputJson, '工作流作用域响应无效') }),
    body: parseWorkflowBody(row.body),
    createdAt: string(row.createdAt, '工作流作用域响应无效'),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, '工作流作用域响应无效') }),
  }
}

export function parseWorkflowNodeExecution(value: unknown): AgentWorkflowNodeExecution {
  const row = object(value, '工作流节点响应无效')
  return {
    id: string(row.id, '工作流节点响应无效'),
    workflowId: string(row.workflowId, '工作流节点响应无效'),
    scopeId: string(row.scopeId, '工作流节点响应无效'),
    stepId: string(row.stepId, '工作流节点响应无效'),
    stableKey: string(row.stableKey, '工作流节点响应无效'),
    kind: enumValue(row.kind, AGENT_WORKFLOW_STEP_KINDS, '工作流节点响应无效'),
    ordinal: number(row.ordinal, '工作流节点响应无效'),
    status: parseNodeStatus(row.status, '工作流节点响应无效'),
    taskId: string(row.taskId, '工作流节点响应无效'),
    ...(row.runId === undefined ? {} : { runId: string(row.runId, '工作流节点响应无效') }),
    attempt: number(row.attempt, '工作流节点响应无效'),
    revision: number(row.revision, '工作流节点响应无效'),
    inputJson: string(row.inputJson, '工作流节点响应无效'),
    ...(row.outputJson === undefined ? {} : { outputJson: string(row.outputJson, '工作流节点响应无效') }),
    expanded: boolean(row.expanded, '工作流节点响应无效'),
    joinWorkspaceRevision: number(row.joinWorkspaceRevision, '工作流节点响应无效'),
    ...(row.error === undefined ? {} : { error: failure(row.error, '工作流节点响应无效') }),
    createdAt: string(row.createdAt, '工作流节点响应无效'),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, '工作流节点响应无效') }),
    allowedActions: parseAllowedActions(row.allowedActions, '工作流节点响应无效'),
  }
}

function parseAllowedActions(value: unknown, message: string): readonly AgentWorkflowRecoveryAction[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value.map((item) => enumValue(item, AGENT_WORKFLOW_RECOVERY_ACTIONS, message))
}

/**
 * 节点状态宽入口：服务端对兄弟失败后不可达的节点会落 'skipped'
 * （scope_runtime.go:680），冻结契约的 AgentWorkflowStatus 联合暂缺该值；
 * 解析层先收下（缺口语法上仍按 AgentWorkflowStatus 传递），展示层用本地标签兜底。
 */
const WORKFLOW_NODE_STATUS_EXTRA: readonly string[] = ['skipped']

function parseNodeStatus(value: unknown, message: string): AgentWorkflowStatus {
  if (typeof value === 'string' && WORKFLOW_NODE_STATUS_EXTRA.includes(value)) return value as AgentWorkflowStatus
  return enumValue(value, AGENT_WORKFLOW_STATUSES, message)
}

/**
 * languageVersion 宽入口：服务端输入接受 'workflow/v1' 别名且模板文档原样保存
 * （workflow_definition.go:51-53），冻结契约联合只有 'v1'|'workflow/v2'——解析层
 * 三个值都收下并按契约类型传递（契约缺口已上报，收窄后移除本函数）。
 */
function parseLanguageVersion(value: unknown, message: string): AgentWorkflowLanguageVersion {
  if (value === undefined || value === '') return 'v1'
  if (value === 'v1' || value === 'workflow/v1' || value === 'workflow/v2') return value as AgentWorkflowLanguageVersion
  throw new Error(message)
}

export function parseWorkflowExecutionTree(value: unknown): AgentWorkflowExecutionTree {
  const row = object(value, '工作流执行树响应无效')
  return {
    rootScopeId: string(row.rootScopeId, '工作流执行树响应无效'),
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).map(parseWorkflowScope),
    nodes: (Array.isArray(row.nodes) ? row.nodes : []).map(parseWorkflowNodeExecution),
  }
}

function parseWorkflowUsage(value: unknown): AgentWorkflowInstance['usage'] {
  const row = object(value, '工作流用量响应无效')
  return {
    activeMilliseconds: number(row.activeMilliseconds, '工作流用量响应无效'),
    reservedMilliseconds: number(row.reservedMilliseconds, '工作流用量响应无效'),
    modelRequests: number(row.modelRequests, '工作流用量响应无效'),
    calls: number(row.calls, '工作流用量响应无效'),
    tokens: number(row.tokens, '工作流用量响应无效'),
    resultBytes: number(row.resultBytes, '工作流用量响应无效'),
  }
}

function parseWorkflowLimits(value: unknown): AgentWorkflowInstance['limits'] {
  const row = object(value, '工作流限额响应无效')
  return {
    activeMilliseconds: number(row.activeMilliseconds, '工作流限额响应无效'),
    modelRequests: number(row.modelRequests, '工作流限额响应无效'),
    calls: number(row.calls, '工作流限额响应无效'),
    tokens: number(row.tokens, '工作流限额响应无效'),
    resultBytes: number(row.resultBytes, '工作流限额响应无效'),
    attempts: number(row.attempts, '工作流限额响应无效'),
  }
}

export function parseWorkflowInstance(value: unknown): AgentWorkflowInstance {
  const row = object(value, '工作流实例响应无效')
  return {
    id: string(row.id, '工作流实例响应无效'),
    requestId: string(row.requestId, '工作流实例响应无效'),
    definitionId: string(row.definitionId, '工作流实例响应无效'),
    definitionRevision: number(row.definitionRevision, '工作流实例响应无效'),
    sourceSessionId: string(row.sourceSessionId, '工作流实例响应无效'),
    sessionId: string(row.sessionId, '工作流实例响应无效'),
    taskId: string(row.taskId, '工作流实例响应无效'),
    revision: number(row.revision, '工作流实例响应无效'),
    status: enumValue(row.status, AGENT_WORKFLOW_STATUSES, '工作流实例响应无效'),
    currentStepId: string(row.currentStepId, '工作流实例响应无效'),
    ...(row.activeRunId === undefined ? {} : { activeRunId: string(row.activeRunId, '工作流实例响应无效') }),
    inputJson: string(row.inputJson, '工作流实例响应无效'),
    ...(row.outputJson === undefined ? {} : { outputJson: string(row.outputJson, '工作流实例响应无效') }),
    model: object(row.model, '工作流实例响应无效') as AgentWorkflowInstance['model'],
    snapshot: object(row.snapshot, '工作流实例响应无效') as AgentWorkflowInstance['snapshot'],
    createdAt: string(row.createdAt, '工作流实例响应无效'),
    updatedAt: string(row.updatedAt, '工作流实例响应无效'),
    ...(row.readyAt === undefined ? {} : { readyAt: string(row.readyAt, '工作流实例响应无效') }),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, '工作流实例响应无效') }),
    ...(row.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: string(row.cancelRequestedAt, '工作流实例响应无效') }),
    ...(row.error === undefined ? {} : { error: failure(row.error, '工作流实例响应无效') }),
    limits: parseWorkflowLimits(row.limits),
    usage: parseWorkflowUsage(row.usage),
    lastSeq: assertDecimalCursor(string(row.lastSeq, '工作流实例响应无效'), '工作流事件序号'),
    allowedActions: parseAllowedActions(row.allowedActions, '工作流实例响应无效'),
    ...(row.languageVersion === undefined ? {} : { languageVersion: parseLanguageVersion(row.languageVersion, '工作流实例响应无效') }),
    ...(row.rootScopeId === undefined ? {} : { rootScopeId: string(row.rootScopeId, '工作流实例响应无效') }),
    ...(row.gateClosed === undefined ? {} : { gateClosed: boolean(row.gateClosed, '工作流实例响应无效') }),
    ...(row.definitions === undefined ? {} : { definitions: parseWorkflowDefinitions(row.definitions) }),
    ...(row.executionTree === undefined ? {} : { executionTree: parseWorkflowExecutionTree(row.executionTree) }),
  }
}

export function parseWorkflowAttempt(value: unknown): AgentWorkflowAttempt {
  const row = object(value, '工作流尝试响应无效')
  return {
    workflowId: string(row.workflowId, '工作流尝试响应无效'),
    stepId: string(row.stepId, '工作流尝试响应无效'),
    number: number(row.number, '工作流尝试响应无效'),
    runId: string(row.runId, '工作流尝试响应无效'),
    runNumber: number(row.runNumber, '工作流尝试响应无效'),
    status: enumValue(row.status, RUNTIME_RUN_STATUSES, '工作流尝试响应无效'),
    inputJson: string(row.inputJson, '工作流尝试响应无效'),
    ...(row.outputJson === undefined ? {} : { outputJson: string(row.outputJson, '工作流尝试响应无效') }),
    ...(row.outputCallId === undefined ? {} : { outputCallId: string(row.outputCallId, '工作流尝试响应无效') }),
    ...(row.outputRequestId === undefined ? {} : { outputRequestId: string(row.outputRequestId, '工作流尝试响应无效') }),
    ...(row.completionSource === undefined ? {} : { completionSource: string(row.completionSource, '工作流尝试响应无效') }),
    ...(row.evidence === undefined ? {} : { evidence: string(row.evidence, '工作流尝试响应无效') }),
    ...(row.eventSeq === undefined ? {} : { eventSeq: assertDecimalCursor(string(row.eventSeq, '工作流尝试响应无效'), '工作流事件序号') }),
    workspaceRevision: number(row.workspaceRevision, '工作流尝试响应无效'),
    createdAt: string(row.createdAt, '工作流尝试响应无效'),
    ...(row.endedAt === undefined ? {} : { endedAt: string(row.endedAt, '工作流尝试响应无效') }),
    ...(row.scopeId === undefined ? {} : { scopeId: string(row.scopeId, '工作流尝试响应无效') }),
    ...(row.nodeId === undefined ? {} : { nodeId: string(row.nodeId, '工作流尝试响应无效') }),
    ...(row.iteration === undefined ? {} : { iteration: number(row.iteration, '工作流尝试响应无效') }),
    ...(row.expectedRevision === undefined ? {} : { expectedRevision: number(row.expectedRevision, '工作流尝试响应无效') }),
  }
}

export function parseWorkflowEvent(value: unknown): AgentWorkflowEvent {
  const row = object(value, '工作流事件响应无效')
  return {
    workflowId: string(row.workflowId, '工作流事件响应无效'),
    seq: assertDecimalCursor(string(row.seq, '工作流事件响应无效'), '工作流事件序号'),
    type: string(row.type, '工作流事件响应无效'),
    ...(row.stepId === undefined ? {} : { stepId: string(row.stepId, '工作流事件响应无效') }),
    ...(row.runId === undefined ? {} : { runId: string(row.runId, '工作流事件响应无效') }),
    at: string(row.at, '工作流事件响应无效'),
    ...(row.detail === undefined ? {} : { detail: string(row.detail, '工作流事件响应无效') }),
  }
}

function pageQuery(query?: AgentPageQuery): { cursor?: string; limit?: number } {
  if (query === undefined) return { limit: PAGE_LIMIT }
  const limit = query.limit !== undefined && Number.isSafeInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 200) : PAGE_LIMIT
  return query.cursor === undefined ? { limit } : { cursor: query.cursor, limit }
}

export function createHttpAgentWorkflowsAdapter(baseUrl = '/api/agent'): AgentWorkflowsAdapter {
  const definitionsUrl = `${baseUrl}/workflow-definitions`
  const instancesUrl = `${baseUrl}/workflow-instances`
  const instanceUrl = (instanceId: string) => `${instancesUrl}/${agentPathPart(instanceId, '实例标识')}`

  return {
    async listDefinitions(signal) {
      return parseWorkflowDefinitions(await requestAgentJson(definitionsUrl, { signal }))
    },
    async getDefinition(definitionId, revision, signal) {
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
        throw new Error('模板修订必须是正整数')
      }
      const query = agentQueryString({ revision })
      const url = query === '' ? `${definitionsUrl}/${agentPathPart(definitionId, '模板标识')}` : `${definitionsUrl}/${agentPathPart(definitionId, '模板标识')}?${query}`
      return parseWorkflowDefinition(await requestAgentJson(url, { signal }))
    },
    async createDefinition(input) {
      // 创建体只含模板字段本身；不带 requestId（服务端 DisallowUnknownFields）。
      return parseWorkflowDefinition(
        await requestAgentJson(definitionsUrl, { method: 'POST', body: JSON.stringify(input) }),
      )
    },
    async updateDefinition(definitionId, input) {
      // 更新体在顶层平铺 expectedRevision（服务端匿名内嵌结构体）。
      return parseWorkflowDefinition(
        await requestAgentJson(`${definitionsUrl}/${agentPathPart(definitionId, '模板标识')}`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      )
    },
    async createInstance(input) {
      return parseWorkflowInstance(await requestAgentJson(instancesUrl, { method: 'POST', body: JSON.stringify(input) }))
    },
    async listInstances(query, signal) {
      const params = agentQueryString({
        status: query.status,
        cursor: query.cursor,
        limit: query.limit !== undefined && Number.isSafeInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 200) : PAGE_LIMIT,
      })
      const url = params === '' ? instancesUrl : `${instancesUrl}?${params}`
      return parseAgentPage(await requestAgentJson(url, { signal }), parseWorkflowInstance, '工作流实例分页')
    },
    async getInstance(instanceId, signal) {
      return parseWorkflowInstance(await requestAgentJson(instanceUrl(instanceId), { signal }))
    },
    async getExecutionTree(instanceId, signal) {
      return parseWorkflowExecutionTree(await requestAgentJson(`${instanceUrl(instanceId)}/execution-tree`, { signal }))
    },
    async listAttempts(instanceId, query, signal) {
      const params = agentQueryString(pageQuery(query))
      return parseAgentPage(
        await requestAgentJson(`${instanceUrl(instanceId)}/steps?${params}`, { signal }),
        parseWorkflowAttempt,
        '工作流尝试分页',
      )
    },
    async listInstanceEvents(instanceId, query, signal) {
      const params = agentQueryString(pageQuery(query))
      return parseAgentPage(
        await requestAgentJson(`${instanceUrl(instanceId)}/events?${params}`, { signal }),
        parseWorkflowEvent,
        '工作流事件分页',
      )
    },
    async cancelInstance(instanceId) {
      // 取消端点没有请求体；幂等回读由服务端语义承担，无 requestId。
      return parseWorkflowInstance(await requestAgentJson(`${instanceUrl(instanceId)}/cancel`, { method: 'POST' }))
    },
    async recoverInstance(instanceId, input: AgentWorkflowRecoveryInput) {
      return parseWorkflowInstance(
        await requestAgentJson(`${instanceUrl(instanceId)}/recover`, { method: 'POST', body: JSON.stringify(input) }),
      )
    },
  }
}

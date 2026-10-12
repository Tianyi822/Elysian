import type {
  AgentCreateWorkflowDefinitionInput,
  AgentCreateWorkflowInput,
  AgentModelProfile,
  AgentWorkflowAttempt,
  AgentWorkflowBody,
  AgentWorkflowDefinition,
  AgentWorkflowEvent,
  AgentWorkflowInstance,
  AgentWorkflowNodeExecution,
  AgentWorkflowRecoveryAction,
  AgentWorkflowRecoveryInput,
  AgentWorkflowScope,
  AgentWorkflowStatus,
  AgentWorkflowStepDefinition,
  RuntimePage,
  RuntimeRunStatus,
} from '@elysian/contracts'
import {
  WORKFLOW_ATTEMPTS_PORTAL_RUNNING,
  WORKFLOW_CONTRACT_DEFINITIONS,
  WORKFLOW_DEFINITION_PORTAL_REVISION1,
  WORKFLOW_EVENTS_PORTAL_RUNNING,
  WORKFLOW_INSTANCE_AUDIT_CANCELLED,
  WORKFLOW_INSTANCE_BACKUP_SUCCEEDED,
  WORKFLOW_INSTANCE_PORTAL_RECOVERY,
  WORKFLOW_INSTANCE_PORTAL_RUNNING,
  WORKFLOW_TREE_PORTAL_RECOVERY,
  WORKFLOW_TREE_PORTAL_RUNNING,
} from '../../agentWorkflowsFixtures'
import { AgentHttpError } from '../../http/agent/agentShared'

/*
 * 工作流域确定性演示数据集：模板修订、实例（v1/v2）、执行树、尝试与事件。
 * - 种子固定相对基准时间生成，resetAgentWorkflowsData() 复位全部可变状态；
 * - 状态机遵守服务端语义：allowedActions 只按可恢复状态与屏障/预算计算、
 *   cancel 终态幂等且「取消请求已提交」与「已取消」分栏、恢复同 requestId 幂等、
 *   预算不随恢复重置、confirmed-stopped 屏障经旋钮阻断 accept-result；
 * - 非终态实例只在 dataGetInstance 读取时推进一格（详情页 3s 轮询即见推进），
 *   dataListInstances 不推进但始终回读已存事实。
 * - 通用推进引擎按模板结构确定性前进：agent/operation 步骤必然成功、approval
 *   停在等待审批、条件求值为尽力子集；兄弟分支进入恢复态后其余分支不再推进。
 */

/** 深层可变副本：种子 fixture 是 readonly 文档，运行态需要可写字段。 */
type W<T> = T extends readonly (infer U)[] ? W<U>[] : T extends object ? { -readonly [K in keyof T]: W<T[K]> } : T

type DefinitionDoc = W<AgentWorkflowDefinition>
type ScopeDoc = W<AgentWorkflowScope>
type NodeDoc = W<AgentWorkflowNodeExecution>
type AttemptDoc = W<AgentWorkflowAttempt>
type EventDoc = W<AgentWorkflowEvent>
type InstanceDoc = W<AgentWorkflowInstance>
type BodyDoc = W<AgentWorkflowScope['body']>

type InstanceState = {
  doc: InstanceDoc
  scopes: ScopeDoc[]
  nodes: NodeDoc[]
  attempts: AttemptDoc[]
  events: EventDoc[]
  /** 下一个事件序号（十进制字符串递增，不经 number）。 */
  nextSeq: string
  nextRunNumber: number
  /** 取消请求已提交但尚未生效：下一格推进时统一终态化为 cancelled。 */
  cancelPending: boolean
  /** 创建幂等键的规范化输入（不含 requestId）。 */
  createCanonical: string
  recoveries: Map<string, { canonical: string }>
  recoverySnapshots: Map<string, InstanceDoc>
}

const BASE_MS = Date.parse('2026-10-11T09:00:00+08:00')

const MODEL: W<AgentModelProfile> = {
  id: 'model-primary',
  revision: 3,
  name: '演示模型',
  baseUrl: 'https://model.example.internal/v1',
  model: 'demo-opus',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 128_000,
  outputTokens: 4_096,
  capabilities: { text: true, tools: true, source: 'config' },
  active: true,
  hasCredential: true,
}

const SNAPSHOT = {
  environment: {
    sessionId: 'sess-source-demo',
    revision: 1,
    skills: [],
    servers: [],
    tools: ['docker_containers_list', 'docker_images_list', 'docker_policy_view', 'docker_self_container'],
    resources: [],
    executionProfiles: [],
    grants: [],
    trustedReadOnly: [],
  },
  tools: [],
  skillSummaries: [],
  digest: 'demo-snapshot-digest',
} as const

const TERMINAL: readonly AgentWorkflowStatus[] = ['succeeded', 'failed', 'cancelled']
const TERMINAL_RUN: readonly RuntimeRunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted']

function statusIsTerminal(status: AgentWorkflowStatus): boolean {
  return TERMINAL.includes(status)
}

function runIsTerminal(status: RuntimeRunStatus): boolean {
  return TERMINAL_RUN.includes(status)
}

/** 十进制字符串加一：逐位进位，绝不转 number。 */
export function nextDecimal(value: string): string {
  const digits = value.split('')
  let index = digits.length - 1
  for (; index >= 0; index -= 1) {
    const digit = digits[index]
    if (digit === undefined) break
    if (digit === '9') {
      digits[index] = '0'
      continue
    }
    digits[index] = String.fromCharCode(digit.charCodeAt(0) + 1)
    return digits.join('')
  }
  return `1${digits.join('')}`
}

function clone<T>(value: T): W<T> {
  return JSON.parse(JSON.stringify(value)) as W<T>
}

function readKeyBefore(text: string, colonIndex: number): string | null {
  let end = colonIndex - 1
  while (end >= 0 && /\s/.test(text[end] ?? '')) end -= 1
  if (text[end] !== '"') return null
  let start = end - 1
  let escaped = false
  while (start >= 0) {
    const char = text[start]
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
    else if (char === '"') break
    start -= 1
  }
  if (start < 0) return null
  return text.slice(start + 1, end)
}

/** 重复 JSON 键探测：JSON.parse 会静默取后者，服务端 jsonvalue.Object 直接拒绝。 */
export function hasDuplicateJsonKeys(text: string): boolean {
  let inString = false
  let escaped = false
  let index = 0
  const objectKeys: string[][] = []
  while (index < text.length) {
    const char = text[index]
    index += 1
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      objectKeys.push([])
      continue
    }
    if (char === '}') {
      objectKeys.pop()
      continue
    }
    if (char === ':') {
      const key = readKeyBefore(text, index - 1)
      const bucket = objectKeys[objectKeys.length - 1]
      if (key !== null && bucket !== undefined) {
        if (bucket.includes(key)) return true
        bucket.push(key)
      }
    }
  }
  return false
}

/** 严格 JSON 解析（拒绝重复键）；仅用于演示状态机内部的语义求值，不用于展示。 */
function parseStrictJson(text: string): unknown {
  if (hasDuplicateJsonKeys(text)) throw new Error('JSON 包含重复键')
  return JSON.parse(text)
}

type MutableJson = { [key: string]: unknown }

function asObject(value: unknown): MutableJson | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as MutableJson) : null
}

// ---------------------------------------------------------------------------
// 绑定求值：五选一（literalJson / input / step / object / array），尽力子集。
// ---------------------------------------------------------------------------

type BindingLike = {
  literalJson?: string
  input?: string
  step?: { readonly stepId: string; readonly pointer: string }
  object?: Readonly<Record<string, BindingLike>>
  array?: readonly BindingLike[]
}

function selectByPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value
  let current = value
  for (const rawToken of pointer.split('/').slice(1)) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined
      current = current[Number(token)]
      continue
    }
    const row = asObject(current)
    if (row === null) return undefined
    current = row[token]
  }
  return current
}

function evaluateBinding(binding: BindingLike, input: unknown, outputs: Map<string, unknown>): unknown {
  if (binding.literalJson !== undefined) return parseStrictJson(binding.literalJson)
  if (binding.input !== undefined) return selectByPointer(input, binding.input)
  if (binding.step !== undefined) {
    const output = outputs.get(binding.step.stepId)
    if (output === undefined) throw new Error(`所引用的步骤 ${binding.step.stepId} 尚无已确认输出`)
    return selectByPointer(output, binding.step.pointer)
  }
  if (binding.object !== undefined) {
    const result: MutableJson = {}
    for (const [key, child] of Object.entries(binding.object)) result[key] = evaluateBinding(child, input, outputs)
    return result
  }
  if (binding.array !== undefined) return binding.array.map((child) => evaluateBinding(child, input, outputs))
  throw new Error('工作流绑定没有选择值来源')
}

function stringifyBinding(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

// ---------------------------------------------------------------------------
// 状态容器
// ---------------------------------------------------------------------------

let definitions: DefinitionDoc[] = []
let instances: InstanceState[] = []
let idCounter = 0
let minuteCursor = 40
let barrierCount = 0

function stampNext(): string {
  minuteCursor += 1
  return new Date(BASE_MS + minuteCursor * 60_000).toISOString()
}

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${String(idCounter).padStart(3, '0')}`
}

function emitEvent(state: InstanceState, type: string, detail: string, stepId?: string): void {
  state.events.push({
    workflowId: state.doc.id,
    seq: state.nextSeq,
    type,
    ...(stepId === undefined ? {} : { stepId }),
    at: stampNext(),
    ...(detail === '' ? {} : { detail }),
  })
  state.doc.lastSeq = state.nextSeq
  state.nextSeq = nextDecimal(state.nextSeq)
}

function findInstance(instanceId: string): InstanceState {
  const state = instances.find((item) => item.doc.id === instanceId)
  if (state === undefined) throw new AgentHttpError(`演示数据中不存在工作流实例 ${instanceId}`, 'not-found')
  return state
}

// ---------------------------------------------------------------------------
// allowedActions：按服务端规则（workflow_api.go:439 / scope_recovery.go:89 的演示子集）
// ---------------------------------------------------------------------------

function budgetExhausted(doc: InstanceDoc): boolean {
  const usage = doc.usage
  return (
    usage.activeMilliseconds + usage.reservedMilliseconds >= doc.limits.activeMilliseconds ||
    usage.modelRequests >= doc.limits.modelRequests ||
    usage.tokens >= doc.limits.tokens ||
    usage.calls >= doc.limits.calls ||
    usage.resultBytes >= doc.limits.resultBytes
  )
}

function nodeAllowedActions(state: InstanceState, node: NodeDoc): AgentWorkflowRecoveryAction[] {
  const doc = state.doc
  if (doc.status !== 'recovery-required' || doc.cancelRequestedAt !== undefined || node.status !== 'recovery-required') {
    return []
  }
  if (barrierCount > 0 || budgetExhausted(doc)) return []
  const maintenance = node.error?.code === 'maintenance-recovery'
  if (node.runId === '') {
    if (maintenance) return ['continue']
    if (node.attempt < doc.limits.attempts) return ['retry']
    return []
  }
  const attempt = state.attempts.find((item) => item.runId === node.runId)
  const runTerminal = attempt !== undefined && runIsTerminal(attempt.status)
  if (!runTerminal) {
    // 冻结在审批边界（run 非终态）的节点只能重新申请审批。
    return ['renew-approval']
  }
  if (attempt !== undefined && attempt.status === 'succeeded') return []
  const out: AgentWorkflowRecoveryAction[] = []
  if (node.attempt < doc.limits.attempts) out.push('retry')
  if (node.kind === 'agent' || node.kind === 'operation') out.push('accept-result')
  return out
}

function instanceAllowedActions(state: InstanceState): AgentWorkflowRecoveryAction[] {
  const doc = state.doc
  if (doc.status !== 'recovery-required' || doc.cancelRequestedAt !== undefined || barrierCount > 0 || budgetExhausted(doc)) {
    return []
  }
  if (doc.languageVersion === 'workflow/v2') {
    // v2 的实例级动作就是当前恢复中节点的动作（workflowV2AllowedActions 同口径）。
    const node = state.nodes.find((item) => item.id === doc.currentStepId)
    return node === undefined ? [] : nodeAllowedActions(state, node)
  }
  if (doc.activeRunId === '') return doc.error?.code === 'maintenance-recovery' ? ['continue'] : []
  const attempt = state.attempts.find((item) => item.runId === doc.activeRunId)
  if (attempt === undefined || !runIsTerminal(attempt.status)) return []
  if (attempt.status === 'succeeded') return []
  const out: AgentWorkflowRecoveryAction[] = []
  if (attempt.number < doc.limits.attempts) out.push('retry')
  const definition = definitions.find((item) => item.id === doc.definitionId && item.revision === doc.definitionRevision)
  const step = definition?.steps.find((item) => item.id === doc.currentStepId)
  if (step?.kind === 'agent' || step?.kind === 'operation') out.push('accept-result')
  return out
}

/** 回读视图：重组 allowedActions/executionTree 后返回文档副本。 */
function materialize(state: InstanceState, options?: { withTree?: boolean }): InstanceDoc {
  const doc = clone(state.doc)
  doc.allowedActions = instanceAllowedActions(state)
  if (doc.languageVersion === 'workflow/v2' && options?.withTree !== false) {
    const tree = materializeTree(state)
    doc.executionTree = tree
    doc.rootScopeId = tree.rootScopeId
  }
  return doc
}

function materializeTree(state: InstanceState): { rootScopeId: string; scopes: ScopeDoc[]; nodes: NodeDoc[] } {
  if (state.doc.languageVersion !== 'workflow/v2') {
    return { rootScopeId: '', scopes: [], nodes: [] }
  }
  return {
    rootScopeId: state.scopes[0]?.id ?? '',
    scopes: clone(state.scopes),
    nodes: state.nodes.map((node) => ({ ...clone(node), allowedActions: nodeAllowedActions(state, node) })),
  }
}

// ---------------------------------------------------------------------------
// 确定性推进引擎：每次 dataGetInstance 对非终态实例推进一格。
// ---------------------------------------------------------------------------

function nodesOfScope(state: InstanceState, scopeId: string): NodeDoc[] {
  return state.nodes.filter((node) => node.scopeId === scopeId).sort((a, b) => a.ordinal - b.ordinal)
}

function childScopes(state: InstanceState, parentNodeId: string): ScopeDoc[] {
  return state.scopes
    .filter((scope) => scope.parentNodeId === parentNodeId)
    .sort((a, b) => a.ordinal - b.ordinal)
}

function scopeOutputs(state: InstanceState, scopeId: string): Map<string, unknown> {
  const outputs = new Map<string, unknown>()
  for (const node of nodesOfScope(state, scopeId)) {
    if (node.outputJson !== undefined) {
      try {
        outputs.set(node.stepId, parseStrictJson(node.outputJson))
      } catch {
        // 输出原文无法解析时保持缺失，引用它的后续绑定会进入恢复态。
      }
    }
  }
  return outputs
}

function parseScopeInput(scope: ScopeDoc): unknown {
  try {
    return parseStrictJson(scope.inputJson)
  } catch {
    return undefined
  }
}

/** 按 outputSchemaJson 的属性名构造确定性输出，保证后续指针可解析。 */
function buildAgentOutput(step: AgentWorkflowStepDefinition, node: NodeDoc): string {
  let schema: MutableJson | null = null
  try {
    schema = asObject(parseStrictJson(step.outputSchemaJson))
  } catch {
    schema = null
  }
  const properties = asObject(schema?.['properties'])
  let input: unknown = undefined
  try {
    input = parseStrictJson(node.inputJson)
  } catch {
    input = undefined
  }
  const output: MutableJson = {}
  if (properties !== null) {
    for (const [key, declared] of Object.entries(properties)) {
      const type = asObject(declared)?.['type']
      if (type === 'array') output[key] = Array.isArray(input) ? input : [`demo-${key}`]
      else if (type === 'boolean') output[key] = true
      else if (type === 'number') output[key] = 1
      else output[key] = `${node.stableKey} 完成`
    }
  }
  if (Object.keys(output).length === 0) return '{"summary":"完成"}'
  return stringifyBinding(output)
}

function findStep(body: BodyDoc, stepId: string): AgentWorkflowStepDefinition | undefined {
  return body.steps.find((step) => step.id === stepId)
}

function createAttempt(state: InstanceState, node: NodeDoc, scope: ScopeDoc, inputJson: string): void {
  state.nextRunNumber += 1
  const runId = nextId('run')
  const isV2 = state.doc.languageVersion === 'workflow/v2'
  const attempt: AttemptDoc = {
    workflowId: state.doc.id,
    stepId: node.stepId,
    number: node.attempt + 1,
    runId,
    runNumber: state.nextRunNumber - 1,
    status: 'queued',
    inputJson,
    workspaceRevision: scope.parentWorkspaceRevision + 1,
    createdAt: stampNext(),
    ...(isV2 ? { scopeId: scope.id, nodeId: node.id } : {}),
  }
  state.attempts.push(attempt)
  node.runId = runId
  node.attempt += 1
  state.doc.activeRunId = runId
}

function expandCompound(state: InstanceState, node: NodeDoc, scope: ScopeDoc, step: AgentWorkflowStepDefinition): void {
  node.expanded = true
  const outputs = scopeOutputs(state, scope.id)
  const input = parseScopeInput(scope)
  const children: { key: string; inputJson: string; body: AgentWorkflowBody }[] = []
  if (step.kind === 'parallel' && step.parallel !== undefined) {
    for (const branch of step.parallel.branches) {
      children.push({ key: branch.id, inputJson: stringifyBinding(evaluateBinding(branch.input, input, outputs)), body: branch.body })
    }
  }
  if (step.kind === 'foreach' && step.foreach !== undefined) {
    const foreachBody = step.foreach.body
    const items = evaluateBinding(step.foreach.items, input, outputs)
    if (!Array.isArray(items) || items.length > 32) {
      failNode(state, node, scope, { code: 'workflow-foreach-limit', message: 'foreach items 必须为不超过 32 项的数组' })
      return
    }
    items.forEach((item) => {
      children.push({ key: String(children.length), inputJson: stringifyBinding(item), body: foreachBody })
    })
  }
  children.forEach((child, ordinal) => {
    const childScope: ScopeDoc = {
      id: nextId('scope'),
      workflowId: state.doc.id,
      parentScopeId: scope.id,
      parentNodeId: node.id,
      path: `${node.stableKey}/${child.key}`,
      kind: step.kind,
      taskId: nextId('task'),
      parentWorkspaceRevision: scope.parentWorkspaceRevision + 1,
      parentMemoryRevision: scope.parentMemoryRevision + 1,
      depth: scope.depth + 1,
      ordinal,
      status: 'ready',
      currentStepId: child.body.entry,
      inputJson: child.inputJson,
      body: child.body as BodyDoc,
      createdAt: stampNext(),
    }
    state.scopes.push(childScope)
    const entryStep = findStep(childScope.body, child.body.entry)
    if (entryStep !== undefined) {
      state.nodes.push({
        id: nextId('node'),
        workflowId: state.doc.id,
        scopeId: childScope.id,
        stepId: entryStep.id,
        stableKey: `${childScope.path}/${entryStep.id}`,
        kind: entryStep.kind,
        ordinal: 0,
        status: 'ready',
        taskId: childScope.taskId,
        attempt: 0,
        revision: 0,
        inputJson: '',
        expanded: false,
        joinWorkspaceRevision: 0,
        createdAt: childScope.createdAt,
        allowedActions: [],
      })
    }
  })
  emitEvent(state, 'workflow/expanded', node.id, node.stepId)
}

function failNode(state: InstanceState, node: NodeDoc, scope: ScopeDoc, failure: { code: string; message: string }): void {
  node.status = 'recovery-required'
  node.error = failure
  const attempt = state.attempts.find((item) => item.runId === node.runId)
  if (attempt !== undefined) {
    attempt.status = 'failed'
    attempt.endedAt = stampNext()
  }
  scope.status = 'recovery-required'
  state.doc.status = 'recovery-required'
  state.doc.error = failure
  state.doc.gateClosed = state.doc.languageVersion === 'workflow/v2'
  state.doc.currentStepId = state.doc.languageVersion === 'workflow/v2' ? node.id : node.stepId
  emitEvent(state, 'workflow/node-failed', `${node.id}:${failure.code}`, node.stepId)
}

function joinCompound(state: InstanceState, node: NodeDoc, scope: ScopeDoc, step: AgentWorkflowStepDefinition): void {
  const children = childScopes(state, node.id)
  const joined: MutableJson = {}
  const ordered: unknown[] = []
  for (const child of children) {
    let value: unknown = null
    if (child.outputJson !== undefined) {
      try {
        value = parseStrictJson(child.outputJson)
      } catch {
        value = null
      }
    }
    if (node.kind === 'parallel') joined[child.path.split('/').at(-1) ?? child.id] = value
    ordered.push(value)
  }
  node.outputJson = node.kind === 'parallel' ? stringifyBinding(joined) : stringifyBinding(ordered)
  node.status = 'succeeded'
  node.joinWorkspaceRevision = scope.parentWorkspaceRevision + 2
  node.endedAt = stampNext()
  emitEvent(state, 'workflow/joined', node.id, node.stepId)
  advanceAfterNode(state, node, scope, step)
}

function advanceAfterNode(state: InstanceState, node: NodeDoc, scope: ScopeDoc, step: AgentWorkflowStepDefinition): void {
  const outputs = scopeOutputs(state, scope.id)
  if (step.finish !== undefined) {
    const input = parseScopeInput(scope)
    try {
      scope.outputJson = stringifyBinding(evaluateBinding(step.finish, input, outputs))
    } catch {
      scope.outputJson = 'null'
    }
    scope.status = 'succeeded'
    scope.endedAt = stampNext()
    scope.currentStepId = node.stepId
    return
  }
  const nextStepId = step.next
  if (nextStepId !== undefined) {
    const nextNode = nodesOfScope(state, scope.id).find((item) => item.stepId === nextStepId)
    if (nextNode !== undefined) {
      nextNode.status = 'ready'
      scope.currentStepId = state.doc.languageVersion === 'workflow/v2' ? nextNode.id : nextStepId
    }
  }
}

function tickScope(state: InstanceState, scope: ScopeDoc): boolean {
  if (state.cancelPending) return false
  for (const node of nodesOfScope(state, scope.id)) {
    if (node.status === 'succeeded' || node.status === 'cancelled') continue
    const step = findStep(scope.body, node.stepId)
    if (step === undefined) continue
    if (node.status === 'ready') {
      node.status = 'queued'
      const outputs = scopeOutputs(state, scope.id)
      const input = parseScopeInput(scope)
      try {
        node.inputJson = stringifyBinding(evaluateBinding(step.input, input, outputs))
      } catch {
        node.inputJson = ''
        failNode(state, node, scope, { code: 'workflow-binding', message: '步骤输入引用不存在或无效' })
        return true
      }
      createAttempt(state, node, scope, node.inputJson)
      scope.status = 'queued'
      scope.currentStepId = state.doc.languageVersion === 'workflow/v2' ? node.id : node.stepId
      if (state.doc.languageVersion !== 'workflow/v2') emitEvent(state, 'workflow/queued', '', node.stepId)
      return true
    }
    if (node.status === 'queued') {
      node.status = step.kind === 'approval' ? 'waiting-approval' : 'running'
      if (step.kind === 'approval') {
        scope.status = 'waiting-approval'
        state.doc.status = 'waiting-approval'
        state.doc.currentStepId = state.doc.languageVersion === 'workflow/v2' ? node.id : node.stepId
      }
      return true
    }
    if (node.status === 'waiting-approval') {
      scope.status = 'waiting-approval'
      return false
    }
    if (node.status === 'recovery-required' || node.status === 'failed') {
      // 兄弟分支失败后其余成功分支不再推进：作用域停在恢复态，等待人工处置。
      return false
    }
    if (node.status === 'running' && (step.kind === 'parallel' || step.kind === 'foreach' || step.kind === 'subworkflow')) {
      if (!node.expanded) {
        expandCompound(state, node, scope, step)
        return true
      }
      const children = childScopes(state, node.id)
      if (children.length === 0) {
        joinCompound(state, node, scope, step)
        return true
      }
      for (const child of children) {
        if (tickScope(state, child)) return true
      }
      if (children.every((child) => child.status === 'succeeded')) {
        joinCompound(state, node, scope, step)
        return true
      }
      return false
    }
    if (node.status === 'running' && step.kind === 'condition') {
      const outputs = scopeOutputs(state, scope.id)
      const input = parseScopeInput(scope)
      let matched = false
      try {
        const condition = step.condition
        if (condition !== undefined) {
          const left = condition.left === undefined ? null : evaluateBinding(condition.left, input, outputs)
          const right = condition.right === undefined ? null : evaluateBinding(condition.right, input, outputs)
          matched =
            condition.op === 'eq'
              ? stringifyBinding(left) === stringifyBinding(right)
              : condition.op === 'ne'
                ? stringifyBinding(left) !== stringifyBinding(right)
                : condition.op === 'exists'
                  ? left !== undefined
                  : Boolean(left)
        }
      } catch {
        failNode(state, node, scope, { code: 'workflow-binding', message: '条件绑定求值失败' })
        return true
      }
      node.outputJson = stringifyBinding({ matched })
      node.status = 'succeeded'
      node.endedAt = stampNext()
      const target = (matched ? step.then : step.else) ?? ''
      const nextNode = nodesOfScope(state, scope.id).find((item) => item.stepId === target)
      if (nextNode !== undefined && target !== '') {
        nextNode.status = 'ready'
        scope.currentStepId = state.doc.languageVersion === 'workflow/v2' ? nextNode.id : target
      }
      return true
    }
    if (node.status === 'running') {
      // agent / operation 步骤确定性成功；usage 只增不减。
      node.outputJson = buildAgentOutput(step, node)
      node.status = 'succeeded'
      node.endedAt = stampNext()
      const attempt = state.attempts.find((item) => item.runId === node.runId)
      if (attempt !== undefined) {
        attempt.status = 'succeeded'
        attempt.outputJson = node.outputJson
        attempt.endedAt = node.endedAt
      }
      const usage = state.doc.usage
      usage.modelRequests += 1
      usage.tokens += 800
      usage.activeMilliseconds += 20_000
      usage.reservedMilliseconds = Math.max(0, usage.reservedMilliseconds - 10_000)
      usage.resultBytes += node.outputJson.length
      if (step.kind === 'operation') usage.calls += 1
      advanceAfterNode(state, node, scope, step)
      return true
    }
  }
  return false
}

function recomputeStatus(state: InstanceState): void {
  const doc = state.doc
  if (statusIsTerminal(doc.status)) return
  if (state.cancelPending) {
    doc.status = 'cancelled'
    doc.endedAt = stampNext()
    for (const node of state.nodes) {
      if (node.status !== 'succeeded') {
        node.status = 'cancelled'
        node.endedAt = doc.endedAt
      }
    }
    for (const scope of state.scopes) {
      if (scope.status !== 'succeeded') scope.status = 'cancelled'
    }
    for (const attempt of state.attempts) {
      if (!runIsTerminal(attempt.status)) {
        attempt.status = 'cancelled'
        attempt.endedAt = doc.endedAt
      }
    }
    doc.activeRunId = ''
    emitEvent(state, 'workflow/cancelled', '')
    return
  }
  if (state.nodes.some((node) => node.status === 'recovery-required')) {
    doc.status = 'recovery-required'
    doc.gateClosed = doc.languageVersion === 'workflow/v2'
    const failed = state.nodes.find((node) => node.status === 'recovery-required')
    if (failed !== undefined) {
      doc.currentStepId = doc.languageVersion === 'workflow/v2' ? failed.id : failed.stepId
      if (failed.error !== undefined) doc.error = failed.error
    }
    return
  }
  if (state.nodes.some((node) => node.status === 'waiting-approval')) {
    doc.status = 'waiting-approval'
    const waiting = state.nodes.find((node) => node.status === 'waiting-approval')
    if (waiting !== undefined) doc.currentStepId = doc.languageVersion === 'workflow/v2' ? waiting.id : waiting.stepId
    return
  }
  const root = state.scopes[0]
  if (root !== undefined && root.status === 'succeeded') {
    doc.status = 'succeeded'
    doc.outputJson = root.outputJson ?? 'null'
    doc.endedAt = stampNext()
    doc.activeRunId = ''
    return
  }
  doc.status = 'running'
  const active = state.nodes.find((node) => node.status === 'running' || node.status === 'queued')
  if (active !== undefined) doc.currentStepId = doc.languageVersion === 'workflow/v2' ? active.id : active.stepId
}

/** 非终态实例推进一格：详情页 3s 轮询由此看到真实前进。 */
function advanceOnce(state: InstanceState): void {
  if (statusIsTerminal(state.doc.status) || state.doc.status === 'recovery-required') return
  const root = state.scopes[0]
  if (root === undefined) return
  const before = state.doc.status
  const ticked = tickScope(state, root)
  recomputeStatus(state)
  // 等待审批等稳定态不再产生修订抖动：只有真实前进或状态迁移才更新修订。
  if (!ticked && state.doc.status === before) return
  state.doc.updatedAt = stampNext()
  state.doc.revision += 1
  if (before !== 'succeeded' && state.doc.status === 'succeeded') {
    emitEvent(state, 'workflow/succeeded', '')
  }
}

// ---------------------------------------------------------------------------
// 种子
// ---------------------------------------------------------------------------

function seedInstanceState(
  doc: InstanceDoc,
  extras?: { scopes?: ScopeDoc[]; nodes?: NodeDoc[]; attempts?: AttemptDoc[]; events?: EventDoc[] },
): InstanceState {
  return {
    doc,
    scopes: extras?.scopes ?? [],
    nodes: extras?.nodes ?? [],
    attempts: extras?.attempts ?? [],
    events: extras?.events ?? [],
    nextSeq: nextDecimal(doc.lastSeq),
    nextRunNumber: Math.max(0, ...(extras?.attempts ?? []).map((item) => item.runNumber), 0) + 1,
    cancelPending: false,
    createCanonical: '',
    recoveries: new Map(),
    recoverySnapshots: new Map(),
  }
}

function seed(): void {
  // 种子含门户模板的历史修订 1：精确修订回读（?revision=1）有据可查。
  definitions = [
    ...WORKFLOW_CONTRACT_DEFINITIONS.map((item) => clone(item)),
    clone(WORKFLOW_DEFINITION_PORTAL_REVISION1),
  ]
  instances = []
  idCounter = 100
  minuteCursor = 40
  barrierCount = 0

  instances.push(
    seedInstanceState(clone(WORKFLOW_INSTANCE_PORTAL_RUNNING), {
      scopes: clone([...WORKFLOW_TREE_PORTAL_RUNNING.scopes]),
      nodes: clone([...WORKFLOW_TREE_PORTAL_RUNNING.nodes]),
      attempts: clone([...WORKFLOW_ATTEMPTS_PORTAL_RUNNING]),
      events: clone([...WORKFLOW_EVENTS_PORTAL_RUNNING]),
    }),
  )

  instances.push(
    seedInstanceState(clone(WORKFLOW_INSTANCE_BACKUP_SUCCEEDED), {
      attempts: [
        {
          workflowId: 'wf-inst-backup-01',
          stepId: 'collect',
          number: 1,
          runId: 'run-backup-collect-1',
          runNumber: 1,
          status: 'failed',
          inputJson: '"bk-2026-10-10"',
          evidence: '首次尝试在模型侧超时，已核实无副作用',
          workspaceRevision: 1,
          createdAt: new Date(BASE_MS + 17 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 18 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-backup-01',
          stepId: 'collect',
          number: 2,
          runId: 'run-backup-collect-2',
          runNumber: 2,
          status: 'succeeded',
          inputJson: '"bk-2026-10-10"',
          outputJson: '{"found":true,"ageHours":9}',
          workspaceRevision: 2,
          createdAt: new Date(BASE_MS + 18 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 19 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-backup-01',
          stepId: 'check',
          number: 1,
          runId: 'run-backup-check-1',
          runNumber: 3,
          status: 'succeeded',
          inputJson: '{}',
          outputJson: '{"matched":true}',
          workspaceRevision: 2,
          createdAt: new Date(BASE_MS + 19 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 19 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-backup-01',
          stepId: 'apply',
          number: 1,
          runId: 'run-backup-apply-1',
          runNumber: 4,
          status: 'succeeded',
          inputJson: '{}',
          outputJson: '{}',
          completionSource: 'docker_policy_view',
          workspaceRevision: 3,
          createdAt: new Date(BASE_MS + 20 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 21 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-backup-01',
          stepId: 'confirm',
          number: 1,
          runId: 'run-backup-confirm-1',
          runNumber: 5,
          status: 'succeeded',
          inputJson: '"bk-2026-10-10"',
          outputJson: '{"approved":true}',
          workspaceRevision: 3,
          createdAt: new Date(BASE_MS + 22 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 23 * 60_000).toISOString(),
        },
      ],
      events: [
        { workflowId: 'wf-inst-backup-01', seq: '1', type: 'workflow/accepted', at: new Date(BASE_MS + 16 * 60_000).toISOString() },
        { workflowId: 'wf-inst-backup-01', seq: '2', type: 'workflow/queued', stepId: 'collect', at: new Date(BASE_MS + 16 * 60_000).toISOString() },
        { workflowId: 'wf-inst-backup-01', seq: '4', type: 'workflow/node-failed', stepId: 'collect', detail: 'run-backup-collect-1:model-request-failed', at: new Date(BASE_MS + 18 * 60_000).toISOString() },
        { workflowId: 'wf-inst-backup-01', seq: '5', type: 'workflow/recovered', detail: 'retry：已在模型提供方控制台确认故障已排除', at: new Date(BASE_MS + 18 * 60_000).toISOString() },
        { workflowId: 'wf-inst-backup-01', seq: '9', type: 'workflow/succeeded', at: new Date(BASE_MS + 24 * 60_000).toISOString() },
      ],
    }),
  )

  instances.push(
    seedInstanceState(clone(WORKFLOW_INSTANCE_PORTAL_RECOVERY), {
      scopes: clone([...WORKFLOW_TREE_PORTAL_RECOVERY.scopes]),
      nodes: clone([...WORKFLOW_TREE_PORTAL_RECOVERY.nodes]),
      attempts: [
        {
          workflowId: 'wf-inst-portal-02',
          stepId: 'inspect',
          number: 1,
          runId: 'run-inspect-02',
          runNumber: 1,
          status: 'succeeded',
          inputJson: '["edge"]',
          outputJson: '{"containers":["edge"]}',
          workspaceRevision: 1,
          scopeId: 'scope-root-02',
          nodeId: 'node-inspect-02',
          createdAt: new Date(BASE_MS + 10 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 11 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-portal-02',
          stepId: 'scan',
          number: 1,
          runId: 'run-scan-02',
          runNumber: 2,
          status: 'succeeded',
          inputJson: '["cpu","memory"]',
          outputJson: '{"series":["cpu","memory"]}',
          workspaceRevision: 1,
          scopeId: 'scope-metrics-02',
          nodeId: 'node-scan-02',
          createdAt: new Date(BASE_MS + 13 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 14 * 60_000).toISOString(),
        },
        {
          workflowId: 'wf-inst-portal-02',
          stepId: 'analyze',
          number: 1,
          runId: 'run-analyze-02',
          runNumber: 3,
          status: 'failed',
          inputJson: '["edge"]',
          workspaceRevision: 1,
          scopeId: 'scope-logs-02',
          nodeId: 'node-analyze-logs-02',
          createdAt: new Date(BASE_MS + 13 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 14 * 60_000).toISOString(),
        },
      ],
      events: [
        { workflowId: 'wf-inst-portal-02', seq: '1', type: 'workflow/accepted', at: new Date(BASE_MS + 10 * 60_000).toISOString() },
        { workflowId: 'wf-inst-portal-02', seq: '3', type: 'workflow/expanded', stepId: 'fanout', detail: 'node-fanout-02', at: new Date(BASE_MS + 12 * 60_000).toISOString() },
        { workflowId: 'wf-inst-portal-02', seq: '11', type: 'workflow/node-failed', stepId: 'analyze', detail: 'node-analyze-logs-02:model-request-failed', at: new Date(BASE_MS + 14 * 60_000).toISOString() },
      ],
    }),
  )

  instances.push(
    seedInstanceState(clone(WORKFLOW_INSTANCE_AUDIT_CANCELLED), {
      attempts: [
        {
          workflowId: 'wf-inst-audit-01',
          stepId: 'scan',
          number: 1,
          runId: 'run-audit-scan-1',
          runNumber: 1,
          status: 'cancelled',
          inputJson: '{}',
          workspaceRevision: 1,
          createdAt: new Date(BASE_MS + 26 * 60_000).toISOString(),
          endedAt: new Date(BASE_MS + 28 * 60_000).toISOString(),
        },
      ],
      events: [
        { workflowId: 'wf-inst-audit-01', seq: '1', type: 'workflow/accepted', at: new Date(BASE_MS + 26 * 60_000).toISOString() },
        { workflowId: 'wf-inst-audit-01', seq: '2', type: 'workflow/queued', stepId: 'scan', at: new Date(BASE_MS + 26 * 60_000).toISOString() },
        { workflowId: 'wf-inst-audit-01', seq: '3', type: 'workflow/cancel-requested', at: new Date(BASE_MS + 27 * 60_000).toISOString() },
        { workflowId: 'wf-inst-audit-01', seq: '4', type: 'workflow/cancelled', at: new Date(BASE_MS + 28 * 60_000).toISOString() },
      ],
    }),
  )
}

// ---------------------------------------------------------------------------
// 对外数据操作（由 AgentWorkflowsMockAdapter 调用）
// ---------------------------------------------------------------------------

export function resetAgentWorkflowsData(): void {
  seed()
}

/** 演示用屏障旋钮：unknown/dispatched 屏障计数 >0 时恢复被 409 execution-barrier 阻断。 */
export function setAgentWorkflowBarrierCount(count: number): void {
  barrierCount = Math.max(0, Math.floor(count))
}

export function getAgentWorkflowBarrierCount(): number {
  return barrierCount
}

export function dataListDefinitions(): DefinitionDoc[] {
  // 服务端口径：每个 id 只回最新修订（WorkflowDefinitions 的 MAX(revision) 子查询）。
  const latest = new Map<string, DefinitionDoc>()
  for (const item of definitions) {
    const current = latest.get(item.id)
    if (current === undefined || item.revision > current.revision) latest.set(item.id, item)
  }
  return [...latest.values()].map((item) => clone(item))
}

export function dataGetDefinition(definitionId: string, revision?: number): DefinitionDoc {
  const candidates = definitions.filter((item) => item.id === definitionId)
  if (candidates.length === 0) throw new AgentHttpError(`演示数据中不存在工作流模板 ${definitionId}`, 'not-found')
  const latest = candidates.reduce((a, b) => (a.revision > b.revision ? a : b))
  if (revision === undefined || revision === 0) return clone(latest)
  const exact = candidates.find((item) => item.revision === revision)
  if (exact === undefined) throw new AgentHttpError(`演示数据中不存在工作流模板 ${definitionId} 的修订 ${revision}`, 'not-found')
  return clone(exact)
}

const STEP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** 模板结构校验（服务端 workflow_definition.go 的演示子集；未覆盖支配者分析等全量规则）。 */
export function validateDefinitionInput(input: AgentCreateWorkflowDefinitionInput): void {
  const language: string = input.languageVersion ?? 'v1'
  if (language !== 'v1' && language !== 'workflow/v1' && language !== 'workflow/v2') {
    throw new AgentHttpError('不支持的工作流 languageVersion', 'workflow-definition-invalid')
  }
  if (!input.name.trim() || input.name.length > 120 || !input.goal.trim() || input.goal.length > 32_768) {
    throw new AgentHttpError('工作流名称、目标或修订无效', 'workflow-definition-invalid')
  }
  if (input.steps.length < 1 || input.steps.length > 32) {
    throw new AgentHttpError('工作流必须包含 1 至 32 个步骤', 'workflow-definition-invalid')
  }
  const ids = new Set<string>()
  for (const step of input.steps) {
    if (language !== 'workflow/v2' && (step.parallel !== undefined || step.foreach !== undefined || step.subworkflow !== undefined)) {
      throw new AgentHttpError('workflow/v1 不能包含复合步骤字段', 'workflow-definition-invalid')
    }
    if (!STEP_ID_PATTERN.test(step.id)) {
      throw new AgentHttpError('步骤编号必须以字母开头且只含字母、数字、下划线或连字符，最长 64 字符', 'workflow-definition-invalid')
    }
    if (ids.has(step.id)) throw new AgentHttpError('工作流步骤编号重复', 'workflow-definition-invalid')
    ids.add(step.id)
  }
  if (!ids.has(input.entry)) throw new AgentHttpError('工作流入口步骤不存在', 'workflow-definition-invalid')
  if (JSON.stringify(input).length > 1_048_576) {
    throw new AgentHttpError('工作流定义超过 1 MiB 上限或无法序列化', 'workflow-definition-invalid')
  }
}

export function dataCreateDefinition(input: AgentCreateWorkflowDefinitionInput): DefinitionDoc {
  validateDefinitionInput(input)
  const doc: DefinitionDoc = {
    ...clone(input),
    languageVersion: input.languageVersion ?? 'v1',
    id: nextId('wf-def'),
    revision: 1,
    createdAt: stampNext(),
  }
  definitions.push(doc)
  return clone(doc)
}

export function dataUpdateDefinition(
  definitionId: string,
  input: { expectedRevision: number } & AgentCreateWorkflowDefinitionInput,
): DefinitionDoc {
  validateDefinitionInput(input)
  const candidates = definitions.filter((item) => item.id === definitionId)
  if (candidates.length === 0) throw new AgentHttpError(`演示数据中不存在工作流模板 ${definitionId}`, 'not-found')
  const latest = candidates.reduce((a, b) => (a.revision > b.revision ? a : b))
  if (latest.revision !== input.expectedRevision) {
    throw new AgentHttpError('工作流模板版本已变化', 'revision-conflict')
  }
  const doc: DefinitionDoc = {
    ...clone(input),
    languageVersion: input.languageVersion ?? 'v1',
    id: definitionId,
    revision: latest.revision + 1,
    createdAt: stampNext(),
  }
  definitions.push(doc)
  return clone(doc)
}

function canonicalCreateInput(input: AgentCreateWorkflowInput): string {
  return JSON.stringify({
    definitionId: input.definitionId,
    definitionRevision: input.definitionRevision,
    sourceSessionId: input.sourceSessionId,
    inputJson: input.inputJson,
  })
}

export function dataCreateInstance(input: AgentCreateWorkflowInput): { doc: InstanceDoc; duplicate: boolean } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) {
    throw new AgentHttpError('请求标识格式无效', 'invalid-request-id')
  }
  const canonical = canonicalCreateInput(input)
  const existing = instances.find((item) => item.doc.requestId === input.requestId)
  if (existing !== undefined) {
    if (existing.createCanonical !== canonical) {
      throw new AgentHttpError('相同请求标识对应不同工作流输入', 'request-conflict')
    }
    return { doc: materialize(existing), duplicate: true }
  }
  if (hasDuplicateJsonKeys(input.inputJson)) {
    throw new AgentHttpError('流程输入必须为精确 JSON', 'invalid-input')
  }
  try {
    parseStrictJson(input.inputJson)
  } catch {
    throw new AgentHttpError('流程输入必须为精确 JSON', 'invalid-input')
  }
  if (new TextEncoder().encode(input.inputJson).length > 32_768) {
    throw new AgentHttpError('工作流输入不得超过 32 KiB', 'input-too-large')
  }
  const definition = dataGetDefinition(input.definitionId, input.definitionRevision)
  if (!definition.enabled) throw new AgentHttpError('工作流模板已停用', 'workflow-disabled')
  if (instances.filter((item) => !statusIsTerminal(item.doc.status)).length >= 32) {
    throw new AgentHttpError('非终态工作流已达 32 个上限', 'workflows-full')
  }
  const languageVersion = definition.languageVersion === 'workflow/v2' ? 'workflow/v2' : 'v1'
  const now = stampNext()
  const doc: InstanceDoc = {
    id: nextId('wf-inst'),
    requestId: input.requestId,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    sourceSessionId: input.sourceSessionId,
    sessionId: nextId('sess'),
    taskId: nextId('task'),
    languageVersion,
    revision: 1,
    status: 'ready',
    currentStepId: definition.entry,
    inputJson: input.inputJson,
    model: clone(MODEL),
    snapshot: clone(SNAPSHOT),
    createdAt: now,
    updatedAt: now,
    readyAt: now,
    limits: { activeMilliseconds: 3_600_000, modelRequests: 64, calls: 64, tokens: 256_000, resultBytes: 8_388_608, attempts: 3 },
    usage: { activeMilliseconds: 0, reservedMilliseconds: 0, modelRequests: 0, calls: 0, tokens: 0, resultBytes: 0 },
    lastSeq: '1',
    allowedActions: [],
    ...(languageVersion === 'workflow/v2' ? { definitions: [clone(definition)], gateClosed: false } : {}),
  }
  const body: BodyDoc = { entry: definition.entry, steps: definition.steps, outputSchemaJson: definition.outputSchemaJson }
  const rootScope: ScopeDoc = {
    id: nextId('scope'),
    workflowId: doc.id,
    path: 'root',
    kind: 'root',
    taskId: doc.taskId,
    parentWorkspaceRevision: 0,
    parentMemoryRevision: 0,
    depth: 0,
    ordinal: 0,
    status: 'ready',
    currentStepId: definition.entry,
    inputJson: input.inputJson,
    body,
    createdAt: now,
  }
  const nodes: NodeDoc[] = definition.steps.map((step, ordinal) => ({
    id: nextId('node'),
    workflowId: doc.id,
    scopeId: rootScope.id,
    stepId: step.id,
    stableKey: languageVersion === 'workflow/v2' ? `root/${step.id}` : step.id,
    kind: step.kind,
    ordinal,
    status: 'ready',
    taskId: doc.taskId,
    attempt: 0,
    revision: 0,
    inputJson: '',
    expanded: false,
    joinWorkspaceRevision: 0,
    createdAt: now,
    allowedActions: [],
  }))
  const state: InstanceState = {
    doc,
    scopes: [rootScope],
    nodes,
    attempts: [],
    events: [{ workflowId: doc.id, seq: '1', type: 'workflow/accepted', at: now }],
    nextSeq: '2',
    nextRunNumber: 1,
    cancelPending: false,
    createCanonical: canonical,
    recoveries: new Map(),
    recoverySnapshots: new Map(),
  }
  if (languageVersion === 'workflow/v2') {
    doc.rootScopeId = rootScope.id
  } else {
    // v1 的执行树恒为空；合成作用域只驱动状态机，读取面由 materializeTree 排除。
    doc.rootScopeId = ''
  }
  instances.push(state)
  return { doc: materialize(state), duplicate: false }
}

export function dataListInstances(query: { status?: string; cursor?: string; limit?: number }): RuntimePage<InstanceDoc> {
  const status = query.status ?? ''
  const filtered = status === '' ? instances : instances.filter((item) => item.doc.status === status)
  const offset = /^\d+$/.test(query.cursor ?? '') ? Number(query.cursor) : 0
  const limit = query.limit !== undefined && Number.isSafeInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 200) : 50
  const slice = filtered.slice(offset, offset + limit + 1)
  const hasMore = slice.length > limit
  const items = (hasMore ? slice.slice(0, limit) : slice).map((item) => materialize(item, { withTree: false }))
  return { items, nextCursor: hasMore ? String(offset + limit) : '', hasMore }
}

export function dataGetInstance(instanceId: string): InstanceDoc {
  const state = findInstance(instanceId)
  advanceOnce(state)
  return materialize(state)
}

export function dataGetExecutionTree(instanceId: string): { rootScopeId: string; scopes: ScopeDoc[]; nodes: NodeDoc[] } {
  const state = findInstance(instanceId)
  return materializeTree(state)
}

function pageSlice<T>(rows: readonly T[], query: { cursor?: string; limit?: number }): RuntimePage<T> {
  const offset = /^\d+$/.test(query.cursor ?? '') ? Number(query.cursor) : 0
  const limit = query.limit !== undefined && Number.isSafeInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 200) : 50
  const slice = rows.slice(offset, offset + limit + 1)
  const hasMore = slice.length > limit
  const items = (hasMore ? slice.slice(0, limit) : slice).map((item) => clone(item) as T)
  return { items, nextCursor: hasMore ? String(offset + limit) : '', hasMore }
}

export function dataListAttempts(instanceId: string, query: { cursor?: string; limit?: number }): RuntimePage<AttemptDoc> {
  return pageSlice(findInstance(instanceId).attempts, query)
}

export function dataListInstanceEvents(instanceId: string, query: { cursor?: string; limit?: number }): RuntimePage<EventDoc> {
  return pageSlice(findInstance(instanceId).events, query)
}

export function dataCancelInstance(instanceId: string): InstanceDoc {
  const state = findInstance(instanceId)
  if (statusIsTerminal(state.doc.status)) {
    // 终态实例幂等回读：不重放取消，也不改历史。
    return materialize(state)
  }
  state.doc.cancelRequestedAt = stampNext()
  state.cancelPending = true
  state.doc.gateClosed = state.doc.languageVersion === 'workflow/v2'
  state.doc.revision += 1
  emitEvent(state, 'workflow/cancel-requested', '')
  return materialize(state)
}

function canonicalRecoveryInput(input: AgentWorkflowRecoveryInput): string {
  // 与服务端结构体序列化同口径：固定字段顺序，仅含声明字段。
  return JSON.stringify({
    nodeId: input.nodeId ?? '',
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    action: input.action,
    evidence: input.evidence ?? '',
    outputJson: input.outputJson ?? '',
  })
}

export function dataRecoverInstance(instanceId: string, input: AgentWorkflowRecoveryInput): { doc: InstanceDoc; duplicate: boolean } {
  const state = findInstance(instanceId)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) {
    throw new AgentHttpError('恢复请求标识无效', 'invalid-request-id')
  }
  const canonical = canonicalRecoveryInput(input)
  const prior = state.recoveries.get(input.requestId)
  if (prior !== undefined) {
    if (prior.canonical !== canonical) {
      throw new AgentHttpError('相同恢复请求标识对应不同输入', 'request-conflict')
    }
    const snapshot = state.recoverySnapshots.get(input.requestId)
    return { doc: snapshot === undefined ? materialize(state) : clone(snapshot), duplicate: true }
  }
  if ((input.evidence ?? '').trim() === '' || (input.evidence ?? '').length > 8_192) {
    throw new AgentHttpError('人工恢复必须提供 1 至 8192 字节的核实说明', 'invalid-evidence')
  }
  if (state.doc.revision !== input.expectedRevision) {
    throw new AgentHttpError('工作流状态版本已变化', 'revision-conflict')
  }
  if (state.doc.status !== 'recovery-required' || state.doc.cancelRequestedAt !== undefined) {
    throw new AgentHttpError('流程不处于可恢复状态', 'workflow-state')
  }
  if (barrierCount > 0) {
    throw new AgentHttpError('必须先核实全部未知执行屏障', 'execution-barrier')
  }
  const isV2 = state.doc.languageVersion === 'workflow/v2'
  const node = isV2 ? state.nodes.find((item) => item.id === input.nodeId) : state.nodes.find((item) => item.stepId === state.doc.currentStepId)
  if (isV2 && (input.nodeId === undefined || input.nodeId === '')) {
    throw new AgentHttpError('恢复 workflow/v2 必须指定 nodeId', 'workflow-node-required')
  }
  if (node === undefined) {
    throw new AgentHttpError('节点不属于该流程或不处于可恢复状态', 'workflow-node-state')
  }
  const allowed = isV2 ? nodeAllowedActions(state, node) : instanceAllowedActions(state)
  if (!allowed.includes(input.action)) {
    throw new AgentHttpError('流程不处于可恢复状态', 'workflow-state')
  }
  if (input.action === 'accept-result' && (input.outputJson === undefined || input.outputJson.trim() === '')) {
    throw new AgentHttpError('补录结果必须提供 outputJson', 'invalid-resolution')
  }
  if (input.action === 'accept-result') {
    try {
      parseStrictJson(input.outputJson ?? '')
    } catch {
      throw new AgentHttpError('补录结果必须是精确 JSON', 'workflow-json-invalid')
    }
  }
  applyRecovery(state, node, input)
  state.doc.revision += 1
  state.doc.updatedAt = stampNext()
  emitEvent(state, 'workflow/recovered', `${input.nodeId ?? ''}:${input.action}：${input.evidence ?? ''}`)
  state.recoveries.set(input.requestId, { canonical })
  state.recoverySnapshots.set(input.requestId, clone(state.doc))
  return { doc: materialize(state), duplicate: false }
}

function applyRecovery(state: InstanceState, target: NodeDoc, input: AgentWorkflowRecoveryInput): void {
  const doc = state.doc
  const isV2 = doc.languageVersion === 'workflow/v2'
  if (input.action === 'continue') {
    if (target.error?.code !== 'maintenance-recovery') {
      throw new AgentHttpError('只能继续维护冻结的已确认节点边界', 'unsafe-resume')
    }
    target.status = target.expanded ? 'running' : 'ready'
    target.error = undefined
  } else if (input.action === 'retry') {
    if (target.attempt >= doc.limits.attempts) {
      throw new AgentHttpError('节点尝试次数已耗尽', 'attempt-budget')
    }
    target.status = target.expanded ? 'running' : 'ready'
    target.runId = ''
    target.error = undefined
    target.endedAt = undefined
    if (target.expanded) target.attempt += 1
  } else if (input.action === 'renew-approval') {
    target.status = 'waiting-approval'
    target.error = undefined
  } else if (input.action === 'accept-result') {
    const attempt = state.attempts.find((item) => item.runId === target.runId)
    if (attempt === undefined || !runIsTerminal(attempt.status) || (target.kind !== 'agent' && target.kind !== 'operation')) {
      throw new AgentHttpError('只能补录已终止 Agent 或操作节点的外部结果', 'invalid-resolution')
    }
    if (attempt.status === 'succeeded') {
      throw new AgentHttpError('节点已经有完成凭据', 'already-completed')
    }
    attempt.status = 'succeeded'
    attempt.outputJson = input.outputJson
    attempt.completionSource = 'operator'
    attempt.evidence = input.evidence
    attempt.endedAt = stampNext()
    target.status = 'succeeded'
    target.outputJson = input.outputJson
    target.error = undefined
    target.endedAt = attempt.endedAt
    doc.usage.resultBytes += input.outputJson?.length ?? 0
    emitEvent(state, 'workflow/result-recorded', `evidence=${input.evidence ?? ''}`, target.stepId)
    const scope = state.scopes.find((item) => item.id === target.scopeId)
    const step = scope !== undefined ? findStep(scope.body, target.stepId) : undefined
    if (scope !== undefined && step !== undefined) advanceAfterNode(state, target, scope, step)
  }
  if (doc.status !== 'recovery-required') doc.error = undefined
  const pending = state.nodes.filter((item) => item.status === 'recovery-required')
  doc.gateClosed = isV2 && pending.length > 0
  if (pending.length > 0) {
    doc.status = 'recovery-required'
    doc.currentStepId = isV2 ? (pending[0]?.id ?? doc.currentStepId) : (pending[0]?.stepId ?? doc.currentStepId)
  } else {
    doc.status = 'ready'
    doc.readyAt = stampNext()
    doc.activeRunId = ''
    doc.currentStepId = isV2 ? (target.id ?? doc.currentStepId) : (target.stepId ?? doc.currentStepId)
  }
}

import type {
  RuntimeCall,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeJSONValue,
  RuntimeListQuery,
  RuntimePage,
  RuntimeRun,
  RuntimeRunStatus,
  RuntimeStep,
  RuntimeSubmitInput,
  RuntimeTask,
  RuntimeUsage,
} from '@elysian/contracts'
import { RUNTIME_RUN_STATUSES, RUNTIME_TOOL_NAMES } from '@elysian/contracts'
import type { AgentRunsAdapter } from '../../../contracts/adapters'
import { fetchAgentRuntime, parseAgentRuntimeLimits } from './agentRuntimeHttp'
import {
  agentPathPart,
  agentQueryString,
  assertDecimalCursor,
  assertRequestId,
  parseAgentPage,
  requestAgentJson,
} from './agentShared'

/*
 * 运行记录域 HTTP 适配器（agent-runs 模块）。runtime() 在地基即真实落地
 * （GET /runtime，内核不可用时也可读）；批次提交、Run 列表/详情/事件/调用
 * 与取消在此接线：查询参数只编定义过的键且各出现一次（服务端 runtimeQuery
 * 拒重复参数），seq/nextCursor/after 全程十进制字符串，argumentsJson 等
 * JSON 原文字段原样透传不重排。
 */

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Agent 运行记录响应无效')
  return value
}

function optionalInteger(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Agent 运行记录响应无效')
  return value
}

export function parseRuntimeFailure(value: unknown, label = '失败信息'): RuntimeFailure {
  const row = object(value, `Agent ${label}无效`)
  if (typeof row.code !== 'string' || typeof row.message !== 'string') throw new Error(`Agent ${label}无效`)
  return { code: row.code, message: row.message }
}

/** usage 的 actualTokens/cachedTokens 是可空整数：缺省保持未知，绝不补零。 */
export function parseRuntimeUsage(value: unknown): RuntimeUsage {
  const row = object(value, 'Agent 用量响应无效')
  for (const key of ['calls', 'resultBytes'] as const) {
    if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) {
      throw new Error('Agent 用量响应无效')
    }
  }
  for (const key of ['modelRequests', 'tokens', 'estimatedTokens'] as const) {
    const entry = row[key]
    if (entry === undefined) continue
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) throw new Error('Agent 用量响应无效')
  }
  return {
    calls: row.calls as number,
    resultBytes: row.resultBytes as number,
    ...(optionalInteger(row, 'modelRequests') === undefined ? {} : { modelRequests: optionalInteger(row, 'modelRequests') }),
    ...(optionalInteger(row, 'tokens') === undefined ? {} : { tokens: optionalInteger(row, 'tokens') }),
    ...(optionalInteger(row, 'estimatedTokens') === undefined ? {} : { estimatedTokens: optionalInteger(row, 'estimatedTokens') }),
    ...(optionalInteger(row, 'actualTokens') === undefined ? {} : { actualTokens: optionalInteger(row, 'actualTokens') }),
    ...(optionalInteger(row, 'cachedTokens') === undefined ? {} : { cachedTokens: optionalInteger(row, 'cachedTokens') }),
  }
}

function parseRunStatus(value: unknown): RuntimeRunStatus {
  if (typeof value !== 'string' || !(RUNTIME_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error('Agent 运行状态响应无效')
  }
  return value as RuntimeRunStatus
}

function parseRunStep(value: unknown): RuntimeStep {
  const row = object(value, 'Agent 任务步骤响应无效')
  if (typeof row.tool !== 'string' || row.args === undefined ||
    row.args === null || typeof row.args !== 'object' || Array.isArray(row.args)) {
    throw new Error('Agent 任务步骤响应无效')
  }
  return { tool: row.tool as RuntimeStep['tool'], args: row.args as RuntimeStep['args'] }
}

function parseRuntimeTask(value: unknown): RuntimeTask {
  const row = object(value, 'Agent 任务响应无效')
  if (typeof row.id !== 'string' || typeof row.requestId !== 'string' ||
    typeof row.driverVersion !== 'string' || typeof row.createdAt !== 'string' ||
    (row.kind !== 'tool-batch' && row.kind !== 'agent' && row.kind !== 'workflow')) {
    throw new Error('Agent 任务响应无效')
  }
  // 批次任务的 steps 恒为数组；agent/workflow 任务在服务端可为 null（Go nil 切片）。
  let steps: readonly RuntimeStep[] | null
  if (Array.isArray(row.steps)) {
    steps = row.steps.map(parseRunStep)
  } else if (row.steps === null || row.steps === undefined) {
    steps = null
  } else {
    throw new Error('Agent 任务响应无效')
  }
  if (row.kind === 'tool-batch' && steps === null) throw new Error('Agent 任务响应无效')
  const task = {
    id: row.id,
    requestId: row.requestId,
    driverVersion: row.driverVersion,
    createdAt: row.createdAt,
    kind: row.kind,
    steps,
    ...(optionalString(row, 'sessionId') === undefined ? {} : { sessionId: optionalString(row, 'sessionId') }),
    ...(optionalString(row, 'goal') === undefined ? {} : { goal: optionalString(row, 'goal') }),
    ...(row.latestRun === undefined ? {} : { latestRun: parseRuntimeRun(row.latestRun) }),
    ...(optionalString(row, 'memoryStatus') === undefined ? {} : { memoryStatus: optionalString(row, 'memoryStatus') }),
  }
  return task as RuntimeTask
}

/** Run 响应解析：lastSeq 必须是规范十进制字符串；task 嵌套 latestRun 递归解析。 */
export function parseRuntimeRun(value: unknown): RuntimeRun {
  const row = object(value, 'Agent Run 响应无效')
  if (typeof row.id !== 'string' || typeof row.taskId !== 'string' || typeof row.createdAt !== 'string' ||
    typeof row.lastSeq !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.lastSeq)) {
    throw new Error('Agent Run 响应无效')
  }
  const status = parseRunStatus(row.status)
  for (const key of ['startedAt', 'endedAt', 'cancelRequestedAt', 'endReason', 'driverVersion', 'sessionId',
    'requestId', 'input', 'historySeq', 'scopeId', 'nodeId', 'driver', 'workflowId', 'workflowStepId',
    'workflowOutputSchemaJson', 'workflowOutputJson', 'workflowOutputRequestId', 'workflowOutputCallId', 'workflowNext'] as const) {
    if (row[key] !== undefined && typeof row[key] !== 'string') throw new Error('Agent Run 响应无效')
  }
  const runNumber = optionalInteger(row, 'runNumber')
  const workflowAttempt = optionalInteger(row, 'workflowAttempt')
  const workflowActiveReserved = optionalInteger(row, 'workflowActiveReserved')
  const activeMilliseconds = optionalInteger(row, 'activeMilliseconds')
  const initialMemoryRevision = optionalInteger(row, 'initialMemoryRevision')
  const phase = optionalString(row, 'phase')
  const memoryStatus = optionalString(row, 'memoryStatus')
  const warning = row.warning === undefined ? undefined : parseRuntimeFailure(row.warning, '运行警告')
  const error = row.error === undefined ? undefined : parseRuntimeFailure(row.error)
  const frozenFrom = optionalString(row, 'workflowFrozenFrom')
  return {
    id: row.id,
    taskId: row.taskId,
    status,
    createdAt: row.createdAt,
    limits: parseAgentRuntimeLimits(row.limits),
    usage: parseRuntimeUsage(row.usage),
    lastSeq: row.lastSeq,
    ...(row.task === undefined ? {} : { task: parseRuntimeTask(row.task) }),
    ...(optionalString(row, 'startedAt') === undefined ? {} : { startedAt: optionalString(row, 'startedAt') }),
    ...(optionalString(row, 'endedAt') === undefined ? {} : { endedAt: optionalString(row, 'endedAt') }),
    ...(optionalString(row, 'cancelRequestedAt') === undefined ? {} : { cancelRequestedAt: optionalString(row, 'cancelRequestedAt') }),
    ...(optionalString(row, 'endReason') === undefined ? {} : { endReason: optionalString(row, 'endReason') }),
    ...(error === undefined ? {} : { error }),
    ...(warning === undefined ? {} : { warning }),
    ...(optionalString(row, 'driverVersion') === undefined ? {} : { driverVersion: optionalString(row, 'driverVersion') }),
    ...(optionalString(row, 'sessionId') === undefined ? {} : { sessionId: optionalString(row, 'sessionId') }),
    ...(optionalString(row, 'requestId') === undefined ? {} : { requestId: optionalString(row, 'requestId') }),
    ...(optionalString(row, 'input') === undefined ? {} : { input: optionalString(row, 'input') }),
    ...(optionalString(row, 'scopeId') === undefined ? {} : { scopeId: optionalString(row, 'scopeId') }),
    ...(optionalString(row, 'nodeId') === undefined ? {} : { nodeId: optionalString(row, 'nodeId') }),
    ...(optionalString(row, 'driver') === undefined ? {} : { driver: optionalString(row, 'driver') }),
    ...(optionalString(row, 'workflowId') === undefined ? {} : { workflowId: optionalString(row, 'workflowId') }),
    ...(optionalString(row, 'workflowStepId') === undefined ? {} : { workflowStepId: optionalString(row, 'workflowStepId') }),
    ...(workflowAttempt === undefined ? {} : { workflowAttempt }),
    ...(frozenFrom === undefined ? {} : { workflowFrozenFrom: parseRunStatus(frozenFrom) }),
    ...(optionalString(row, 'workflowOutputSchemaJson') === undefined ? {} : { workflowOutputSchemaJson: optionalString(row, 'workflowOutputSchemaJson') }),
    ...(optionalString(row, 'workflowOutputJson') === undefined ? {} : { workflowOutputJson: optionalString(row, 'workflowOutputJson') }),
    ...(optionalString(row, 'workflowOutputRequestId') === undefined ? {} : { workflowOutputRequestId: optionalString(row, 'workflowOutputRequestId') }),
    ...(optionalString(row, 'workflowOutputCallId') === undefined ? {} : { workflowOutputCallId: optionalString(row, 'workflowOutputCallId') }),
    ...(optionalString(row, 'workflowNext') === undefined ? {} : { workflowNext: optionalString(row, 'workflowNext') }),
    ...(workflowActiveReserved === undefined ? {} : { workflowActiveReserved }),
    ...(activeMilliseconds === undefined ? {} : { activeMilliseconds }),
    ...(runNumber === undefined ? {} : { runNumber }),
    ...(optionalString(row, 'historySeq') === undefined ? {} : { historySeq: optionalString(row, 'historySeq') }),
    ...(initialMemoryRevision === undefined ? {} : { initialMemoryRevision }),
    ...(phase === undefined ? {} : { phase: phase as RuntimeRun['phase'] }),
    ...(memoryStatus === undefined ? {} : { memoryStatus: memoryStatus as RuntimeRun['memoryStatus'] }),
  }
}

/** Call 响应解析：argumentsJson 是权威原文，字符串原样保留；args/result 为 JSON 值。 */
export function parseRuntimeCall(value: unknown): RuntimeCall {
  const row = object(value, 'Agent 工具调用响应无效')
  if (typeof row.id !== 'string' || typeof row.runId !== 'string' || typeof row.tool !== 'string' ||
    typeof row.stepIndex !== 'number' || !Number.isSafeInteger(row.stepIndex) || row.stepIndex < 0 ||
    row.args === undefined || row.args === null || typeof row.args !== 'object' || Array.isArray(row.args) ||
    typeof row.truncated !== 'boolean') {
    throw new Error('Agent 工具调用响应无效')
  }
  const status = parseRunStatus(row.status)
  const error = row.error === undefined ? undefined : parseRuntimeFailure(row.error)
  return {
    id: row.id,
    runId: row.runId,
    tool: row.tool,
    status,
    stepIndex: row.stepIndex,
    args: row.args as Readonly<Record<string, RuntimeJSONValue>>,
    truncated: row.truncated,
    ...(optionalString(row, 'startedAt') === undefined ? {} : { startedAt: optionalString(row, 'startedAt') }),
    ...(optionalString(row, 'endedAt') === undefined ? {} : { endedAt: optionalString(row, 'endedAt') }),
    ...(optionalString(row, 'argumentsJson') === undefined ? {} : { argumentsJson: optionalString(row, 'argumentsJson') }),
    ...(optionalString(row, 'operationId') === undefined ? {} : { operationId: optionalString(row, 'operationId') }),
    ...(row.result === undefined ? {} : { result: row.result as RuntimeJSONValue }),
    ...(error === undefined ? {} : { error }),
    ...(optionalString(row, 'modelRequestId') === undefined ? {} : { modelRequestId: optionalString(row, 'modelRequestId') }),
    ...(optionalString(row, 'modelCallId') === undefined ? {} : { modelCallId: optionalString(row, 'modelCallId') }),
  }
}

/** Event 响应解析：seq 必须是规范十进制字符串（比较与游标推进都不经 number）。 */
export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  const row = object(value, 'Agent 事件响应无效')
  if (typeof row.runId !== 'string' || typeof row.seq !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.seq) ||
    typeof row.type !== 'string' || typeof row.at !== 'string') {
    throw new Error('Agent 事件响应无效')
  }
  const stepIndex = optionalInteger(row, 'stepIndex')
  return {
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    at: row.at,
    ...(optionalString(row, 'callId') === undefined ? {} : { callId: optionalString(row, 'callId') }),
    ...(stepIndex === undefined ? {} : { stepIndex }),
    ...(row.data === undefined ? {} : { data: row.data as RuntimeJSONValue }),
  }
}

function validatedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('每页条数必须在 1 到 200 之间')
  }
  return limit
}

function checkedCursor(cursor: string | undefined, label: string): string | undefined {
  if (cursor === undefined || cursor === '') return undefined
  return assertDecimalCursor(cursor, label)
}

/** 列表过滤参数预检：status 单值枚举、游标规范十进制、limit 1..200；全部通过才发请求。 */
function checkedListQuery(query: RuntimeListQuery | undefined): RuntimeListQuery {
  const input = query ?? {}
  if (input.status !== undefined && !(RUNTIME_RUN_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error('运行状态无效')
  }
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.requestId === undefined || input.requestId === '' ? {} : { requestId: input.requestId }),
    ...(input.sessionId === undefined || input.sessionId === '' ? {} : { sessionId: input.sessionId }),
    ...(input.taskId === undefined || input.taskId === '' ? {} : { taskId: input.taskId }),
    ...(input.workflowId === undefined || input.workflowId === '' ? {} : { workflowId: input.workflowId }),
    ...(checkedCursor(input.cursor, '分页游标') === undefined ? {} : { cursor: checkedCursor(input.cursor, '分页游标') }),
    ...(validatedLimit(input.limit) === undefined ? {} : { limit: validatedLimit(input.limit) }),
  }
}

/** 批次提交输入预检：与服务端 normalize/validateSteps 同口径的中文错误，发出前拦截。 */
function checkedSubmitInput(input: RuntimeSubmitInput): RuntimeSubmitInput {
  assertRequestId(input.requestId)
  if (input.kind !== 'tool-batch') throw new Error('只支持 tool-batch 顺序工具任务')
  if (input.steps.length < 1 || input.steps.length > 16) throw new Error('任务步骤数必须在允许范围内')
  for (const step of input.steps) {
    if (!(RUNTIME_TOOL_NAMES as readonly string[]).includes(step.tool)) {
      throw new Error('任务包含未获准的工具')
    }
    if (Object.keys(step.args).length !== 0) throw new Error('首版只读工具不接受参数')
  }
  return input
}

export function createHttpAgentRunsAdapter(baseUrl = '/api/agent'): AgentRunsAdapter {
  return {
    runtime: (signal?: AbortSignal) => fetchAgentRuntime(baseUrl, signal),
    async submitBatch(input: RuntimeSubmitInput): Promise<RuntimeRun> {
      const checked = checkedSubmitInput(input)
      const body = JSON.stringify(checked)
      return parseRuntimeRun(await requestAgentJson(`${baseUrl}/runs`, { method: 'POST', body }))
    },
    async listRuns(query?: RuntimeListQuery, signal?: AbortSignal): Promise<RuntimePage<RuntimeRun>> {
      const params = agentQueryString(checkedListQuery(query))
      const suffix = params === '' ? '' : `?${params}`
      return parseAgentPage(await requestAgentJson(`${baseUrl}/runs${suffix}`, { signal }), parseRuntimeRun, 'Run 列表')
    },
    async getRun(runId: string, signal?: AbortSignal): Promise<RuntimeRun> {
      const path = `${baseUrl}/runs/${agentPathPart(runId, 'Run 标识')}`
      return parseRuntimeRun(await requestAgentJson(path, { signal }))
    },
    async listRunCalls(runId: string, query?: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<RuntimePage<RuntimeCall>> {
      const checked = {
        ...(checkedCursor(query?.cursor, '分页游标') === undefined ? {} : { cursor: checkedCursor(query?.cursor, '分页游标') }),
        ...(validatedLimit(query?.limit) === undefined ? {} : { limit: validatedLimit(query?.limit) }),
      }
      const params = agentQueryString(checked)
      const suffix = params === '' ? '' : `?${params}`
      const path = `${baseUrl}/runs/${agentPathPart(runId, 'Run 标识')}/calls${suffix}`
      return parseAgentPage(await requestAgentJson(path, { signal }), parseRuntimeCall, '工具调用')
    },
    async listRunEvents(runId: string, query?: { after?: string; limit?: number }, signal?: AbortSignal): Promise<RuntimePage<RuntimeEvent>> {
      const after = query?.after === undefined || query.after === '' ? undefined : assertDecimalCursor(query.after, '事件序号')
      const checked = {
        ...(after === undefined ? {} : { after }),
        ...(validatedLimit(query?.limit) === undefined ? {} : { limit: validatedLimit(query?.limit) }),
      }
      const params = agentQueryString(checked)
      const suffix = params === '' ? '' : `?${params}`
      const path = `${baseUrl}/runs/${agentPathPart(runId, 'Run 标识')}/events${suffix}`
      return parseAgentPage(await requestAgentJson(path, { signal }), parseRuntimeEvent, '事件')
    },
    async cancelRun(runId: string): Promise<RuntimeRun> {
      const path = `${baseUrl}/runs/${agentPathPart(runId, 'Run 标识')}/cancel`
      return parseRuntimeRun(await requestAgentJson(path, { method: 'POST' }))
    },
  }
}

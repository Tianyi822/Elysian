import type {
  AgentEnvironment,
  AgentMemorySpaceSelection,
  AgentMessage,
  AgentModelRequestRecord,
  AgentSession,
  AgentWikiRef,
  AgentModelUsage,
  RuntimeJSONValue,
  RuntimeRun,
  RuntimeRunStatus,
  RuntimeTask,
  RuntimeUsage,
  AgentWorkingMemory,
  AgentWorkspaceVersion,
  AgentWorkspaceView,
} from '@elysian/contracts'
import { RUNTIME_RUN_STATUSES, RUNTIME_TOOL_NAMES } from '@elysian/contracts'
import type { AgentPageQuery, AgentMessageQuery, AgentWorkbenchAdapter } from '../../../contracts/adapters'
import { parseAgentModelProfile, parseAgentRevisionRef } from './agentCatalogParse'
import { parseAgentRuntimeLimits } from './agentRuntimeHttp'
import {
  agentPathPart,
  agentQueryString,
  parseAgentPage,
  requestAgentJson,
  sendRawBytes,
} from './agentShared'

/*
 * Ely 工作台域 HTTP 适配器。端点与体形状以服务端为准：
 * - 会话/任务/消息/模型请求均为 JSON（Page 信封经 parseAgentPage）；
 * - 新建任务与续轮（AgentInput）是 requestId 白名单端点，202 新建 / 200 幂等回读；
 * - 会话创建/切模型/环境/记忆选择无 requestId，体只带服务端声明字段；
 * - PUT /tasks/{id}/environment 体为 {expectedRevision, environment}
 *   （capability_routes.go:34-45），PUT /sessions/{id}/memory 体为
 *   {spaceId, includeGlobal}（wiki_routes.go:72-86）；
 * - 工作区 PUT 体＝原始文件字节（绝不 JSON 包装），path 与 expectedRevision 走
 *   查询参数；GET 侧 content 是 base64——两侧各自正确处理，不做对称假设。
 */

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function optionalString(row: Record<string, unknown>, key: string, message: string): string | undefined {
  const value = row[key]
  if (value === undefined || value === null) return undefined
  return string(value, message)
}

function boolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function integer(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(message)
  return value
}

function nonNegativeInteger(value: unknown, message: string): number {
  const parsed = integer(value, message)
  if (parsed < 0) throw new Error(message)
  return parsed
}

function positiveInteger(value: unknown, message: string): number {
  const parsed = integer(value, message)
  if (parsed < 1) throw new Error(message)
  return parsed
}

function strings(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(message)
  return value as readonly string[]
}

function runStatus(value: unknown, message: string): RuntimeRunStatus {
  if (typeof value !== 'string' || !(RUNTIME_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(message)
  }
  return value as RuntimeRunStatus
}

function parseFailure(value: unknown, message: string): { code: string; message: string } {
  const row = object(value, message)
  return { code: string(row.code, message), message: string(row.message, message) }
}

function parseWikiRefs(value: unknown, message: string): readonly AgentWikiRef[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value.map((item) => {
    const row = object(item, message)
    return {
      pageId: string(row.pageId, message),
      revision: positiveInteger(row.revision, message),
      digest: string(row.digest, message),
    }
  })
}

/** 会话公开行：lastSeq 恒为十进制字符串，activeRunId/activeWorkflowId 缺省即空闲。 */
export function parseAgentSession(value: unknown): AgentSession {
  const message = 'Agent 会话响应无效'
  const row = object(value, message)
  const session: AgentSession = {
    id: string(row.id, message),
    title: string(row.title, message),
    createdAt: string(row.createdAt, message),
    lastActivityAt: string(row.lastActivityAt, message),
    modelProfileId: string(row.modelProfileId, message),
    modelRevision: positiveInteger(row.modelRevision, message),
    lastSeq: string(row.lastSeq, message),
  }
  const activeRunId = optionalString(row, 'activeRunId', message)
  if (activeRunId !== undefined) session.activeRunId = activeRunId
  const activeWorkflowId = optionalString(row, 'activeWorkflowId', message)
  if (activeWorkflowId !== undefined) session.activeWorkflowId = activeWorkflowId
  if (row.notices !== undefined && row.notices !== null) session.notices = strings(row.notices, message)
  if (row.modelChange !== undefined && row.modelChange !== null) {
    const change = object(row.modelChange, message)
    const modelChange: AgentSession['modelChange'] = {
      after: parseAgentModelProfile(change.after),
      differences: strings(change.differences, message),
      notices: strings(change.notices, message),
    }
    if (change.before !== undefined && change.before !== null) {
      modelChange.before = parseAgentModelProfile(change.before)
    }
    session.modelChange = modelChange
  }
  return session
}

/** 公开消息：quarantined 与 wikiSources 缺省即普通答复。 */
export function parseAgentMessage(value: unknown): AgentMessage {
  const message = 'Agent 会话消息响应无效'
  const row = object(value, message)
  if (row.role !== 'user' && row.role !== 'assistant') throw new Error(message)
  const parsed: AgentMessage = {
    id: string(row.id, message),
    sessionId: string(row.sessionId, message),
    taskId: string(row.taskId, message),
    runId: string(row.runId, message),
    seq: string(row.seq, message),
    role: row.role,
    content: string(row.content, message),
    createdAt: string(row.createdAt, message),
  }
  if (row.quarantined !== undefined && row.quarantined !== null) parsed.quarantined = boolean(row.quarantined, message)
  if (row.wikiSources !== undefined && row.wikiSources !== null) parsed.wikiSources = parseWikiRefs(row.wikiSources, message)
  const runStatusValue = optionalString(row, 'runStatus', message)
  if (runStatusValue !== undefined) parsed.runStatus = runStatus(runStatusValue, message)
  return parsed
}

function parseUsage(value: unknown): RuntimeUsage {
  const message = 'Agent 运行用量响应无效'
  const row = object(value, message)
  const usage: RuntimeUsage = {
    calls: nonNegativeInteger(row.calls, message),
    resultBytes: nonNegativeInteger(row.resultBytes, message),
  }
  for (const key of ['modelRequests', 'tokens', 'estimatedTokens', 'actualTokens', 'cachedTokens'] as const) {
    const entry = row[key]
    if (entry === undefined || entry === null) continue
    usage[key] = nonNegativeInteger(entry, message)
  }
  return usage
}

const RUN_OPTIONAL_STRING_KEYS = [
  'scopeId', 'nodeId', 'driver', 'workflowId', 'workflowStepId', 'workflowOutputSchemaJson',
  'workflowOutputJson', 'workflowOutputRequestId', 'workflowOutputCallId', 'workflowNext',
  'driverVersion', 'sessionId', 'requestId', 'input', 'historySeq', 'startedAt', 'endedAt',
  'cancelRequestedAt', 'endReason',
] as const

/** Run 公开行：cancelRequestedAt 只表示取消请求已落盘，不表示已停止。 */
export function parseAgentRun(value: unknown): RuntimeRun {
  const message = 'Agent 运行响应无效'
  const row = object(value, message)
  const run: RuntimeRun = {
    id: string(row.id, message),
    taskId: string(row.taskId, message),
    status: runStatus(row.status, message),
    createdAt: string(row.createdAt, message),
    limits: parseAgentRuntimeLimits(row.limits),
    usage: parseUsage(row.usage),
    lastSeq: string(row.lastSeq, message),
  }
  for (const key of RUN_OPTIONAL_STRING_KEYS) {
    const entry = optionalString(row, key, message)
    if (entry !== undefined) (run as Record<string, unknown>)[key] = entry
  }
  for (const key of ['workflowAttempt', 'workflowActiveReserved', 'activeMilliseconds', 'runNumber', 'initialMemoryRevision'] as const) {
    const entry = row[key]
    if (entry === undefined || entry === null) continue
    ;(run as Record<string, unknown>)[key] = nonNegativeInteger(entry, message)
  }
  if (row.workflowFrozenFrom !== undefined && row.workflowFrozenFrom !== null) {
    run.workflowFrozenFrom = runStatus(row.workflowFrozenFrom, message)
  }
  if (row.model !== undefined && row.model !== null) run.model = parseAgentModelProfile(row.model)
  if (row.task !== undefined && row.task !== null) run.task = parseAgentTask(row.task)
  if (row.phase !== undefined && row.phase !== null) {
    const phase = row.phase
    if (typeof phase !== 'string' || !['queued', 'inference', 'checkpoint', 'final-memory', 'workflow-output', 'waiting-approval', 'waiting-resource', 'completed'].includes(phase)) {
      throw new Error(message)
    }
    run.phase = phase as RuntimeRun['phase']
  }
  if (row.memoryStatus !== undefined && row.memoryStatus !== null) {
    const status = row.memoryStatus
    if (typeof status !== 'string' || !['unchanged', 'updated', 'stale', 'invalidated'].includes(status)) throw new Error(message)
    run.memoryStatus = status as RuntimeRun['memoryStatus']
  }
  if (row.error !== undefined && row.error !== null) run.error = parseFailure(row.error, message)
  if (row.warning !== undefined && row.warning !== null) run.warning = parseFailure(row.warning, message)
  return run
}

/** Task 公开行：kind 三分（batch / agent / workflow），工作台页面主要消费 agent。 */
export function parseAgentTask(value: unknown): RuntimeTask {
  const message = 'Agent 任务响应无效'
  const row = object(value, message)
  const id = string(row.id, message)
  const requestId = string(row.requestId, message)
  const kind = row.kind
  const driverVersion = string(row.driverVersion, message)
  const createdAt = string(row.createdAt, message)
  const parseSteps = (value: unknown): readonly { tool: (typeof RUNTIME_TOOL_NAMES)[number]; args: Readonly<Record<string, never>> }[] => {
    if (!Array.isArray(value)) throw new Error(message)
    return value.map((item) => {
      const step = object(item, message)
      const tool = string(step.tool, message)
      if (!(RUNTIME_TOOL_NAMES as readonly string[]).includes(tool)) throw new Error(message)
      return { tool: tool as (typeof RUNTIME_TOOL_NAMES)[number], args: {} as Readonly<Record<string, never>> }
    })
  }
  const steps = row.steps === undefined || row.steps === null ? null : parseSteps(row.steps)
  const latestRun = row.latestRun === undefined || row.latestRun === null ? undefined : parseAgentRun(row.latestRun)
  const memoryStatus = (() => {
    if (row.memoryStatus === undefined || row.memoryStatus === null) return undefined
    const status = row.memoryStatus
    if (typeof status !== 'string' || !['unchanged', 'updated', 'stale', 'invalidated'].includes(status)) throw new Error(message)
    return status as RuntimeTask['memoryStatus']
  })()
  if (kind === 'tool-batch') {
    return {
      id, requestId, kind, driverVersion, createdAt,
      steps: parseSteps(row.steps),
      ...(latestRun === undefined ? {} : { latestRun }),
      ...(memoryStatus === undefined ? {} : { memoryStatus }),
    }
  }
  if (kind !== 'agent' && kind !== 'workflow') throw new Error(message)
  return {
    id, requestId, kind, driverVersion, createdAt,
    sessionId: string(row.sessionId, message),
    goal: string(row.goal, message),
    steps,
    ...(latestRun === undefined ? {} : { latestRun }),
    ...(memoryStatus === undefined ? {} : { memoryStatus }),
  }
}

/** Task 工作记忆：coverage 游标按十进制字符串保留。 */
export function parseAgentWorkingMemory(value: unknown): AgentWorkingMemory {
  const message = 'Agent 工作记忆响应无效'
  const row = object(value, message)
  const coverageRow = object(row.coverage, message)
  const memory: AgentWorkingMemory = {
    taskId: string(row.taskId, message),
    revision: positiveInteger(row.revision, message),
    updatedAt: string(row.updatedAt, message),
    coverage: {
      runNumber: nonNegativeInteger(coverageRow.runNumber, message),
      eventSeq: string(coverageRow.eventSeq, message),
    },
    objective: string(row.objective ?? '', message),
    constraints: strings(row.constraints ?? [], message),
    facts: (Array.isArray(row.facts) ? row.facts : []).map((item) => {
      const fact = object(item, message)
      return {
        text: string(fact.text, message),
        sources: (Array.isArray(fact.sources) ? fact.sources : []).map((source) => {
          const ref = object(source, message)
          return { runId: string(ref.runId, message), eventSeq: string(ref.eventSeq, message) }
        }),
      }
    }),
    todos: strings(row.todos ?? [], message),
    openQuestions: strings(row.openQuestions ?? [], message),
    summary: string(row.summary ?? '', message),
  }
  if (row.memoryStatus !== undefined && row.memoryStatus !== null) {
    const status = row.memoryStatus
    if (typeof status !== 'string' || !['unchanged', 'updated', 'stale', 'invalidated'].includes(status)) throw new Error(message)
    memory.memoryStatus = status as AgentWorkingMemory['memoryStatus']
  }
  return memory
}

const MODEL_REQUEST_PURPOSES = ['inference', 'checkpoint', 'final-memory', 'workflow-output', 'input-material'] as const

/** 模型请求记录：response 与 error 互斥缺省；估算 token 与供应商报告分开。 */
export function parseAgentModelRequestRecord(value: unknown): AgentModelRequestRecord {
  const message = 'Agent 模型请求记录响应无效'
  const row = object(value, message)
  if (typeof row.purpose !== 'string' || !(MODEL_REQUEST_PURPOSES as readonly string[]).includes(row.purpose)) {
    throw new Error(message)
  }
  const record: AgentModelRequestRecord = {
    id: string(row.id, message),
    runId: string(row.runId, message),
    index: nonNegativeInteger(row.index, message),
    purpose: row.purpose as AgentModelRequestRecord['purpose'],
    status: runStatus(row.status, message),
    startedAt: string(row.startedAt, message),
    contextRefs: (Array.isArray(row.contextRefs) ? row.contextRefs : []).map((item) => {
      const ref = object(item, message)
      return { runId: string(ref.runId, message), eventSeq: string(ref.eventSeq, message) }
    }),
    memoryRevision: nonNegativeInteger(row.memoryRevision, message),
    estimatedTokens: nonNegativeInteger(row.estimatedTokens, message),
    historySeq: string(row.historySeq, message),
  }
  if (row.wikiSources !== undefined && row.wikiSources !== null) record.wikiSources = parseWikiRefs(row.wikiSources, message)
  if (row.contextItemIds !== undefined && row.contextItemIds !== null) record.contextItemIds = strings(row.contextItemIds, message)
  const endedAt = optionalString(row, 'endedAt', message)
  if (endedAt !== undefined) record.endedAt = endedAt
  const eventSeq = optionalString(row, 'eventSeq', message)
  if (eventSeq !== undefined) record.eventSeq = eventSeq
  if (row.response !== undefined && row.response !== null) {
    const responseRow = object(row.response, message)
    const response: AgentModelRequestRecord['response'] = {
      content: string(responseRow.content, message),
      finishReason: string(responseRow.finishReason, message),
      usage: parseModelUsage(responseRow.usage, message),
    }
    if (responseRow.toolCalls !== undefined && responseRow.toolCalls !== null) {
      if (!Array.isArray(responseRow.toolCalls)) throw new Error(message)
      response.toolCalls = responseRow.toolCalls.map((item) => {
        const call = object(item, message)
        return {
          id: string(call.id, message),
          name: string(call.name, message),
          arguments: (call.arguments ?? null) as RuntimeJSONValue,
        }
      })
    }
    record.response = response
  }
  if (row.error !== undefined && row.error !== null) record.error = parseFailure(row.error, message)
  return record
}

function parseModelUsage(value: unknown, message: string): AgentModelUsage {
  const row = object(value, message)
  const usage: AgentModelUsage = {}
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const) {
    const entry = row[key]
    if (entry === undefined || entry === null) continue
    usage[key] = nonNegativeInteger(entry, message)
  }
  return usage
}

/** 会话记忆空间选择（GET/PUT /sessions/{id}/memory 的同形读写体）。 */
export function parseAgentMemorySpaceSelection(value: unknown): AgentMemorySpaceSelection {
  const message = 'Agent 会话记忆空间选择响应无效'
  const row = object(value, message)
  return {
    spaceId: string(row.spaceId, message),
    includeGlobal: boolean(row.includeGlobal, message),
  }
}

/** 会话固定能力环境；resourceRules 为可选修订引用。 */
export function parseAgentEnvironment(value: unknown): AgentEnvironment {
  const message = 'Agent 会话环境响应无效'
  const row = object(value, message)
  const environment: AgentEnvironment = {
    sessionId: string(row.sessionId, message),
    revision: nonNegativeInteger(row.revision, message),
    skills: parseRevisionRefs(row.skills, message),
    servers: parseRevisionRefs(row.servers, message),
    tools: strings(row.tools ?? [], message),
    resources: (Array.isArray(row.resources) ? row.resources : []).map((item) => {
      const ref = object(item, message)
      return { serverId: string(ref.serverId, message), uri: string(ref.uri, message) }
    }),
    executionProfiles: parseRevisionRefs(row.executionProfiles, message),
    grants: parseRevisionRefs(row.grants, message),
    trustedReadOnly: strings(row.trustedReadOnly ?? [], message),
  }
  if (row.resourceRules !== undefined && row.resourceRules !== null) {
    environment.resourceRules = parseRevisionRefs(row.resourceRules, message)
  }
  return environment
}

function parseRevisionRefs(value: unknown, message: string) {
  if (!Array.isArray(value)) throw new Error(message)
  return value.map((item) => parseAgentRevisionRef(item, 'Agent 修订引用无效'))
}

function parseWorkspaceVersion(value: unknown): AgentWorkspaceVersion {
  const message = 'Agent 工作区版本响应无效'
  const row = object(value, message)
  return {
    taskId: string(row.taskId, message),
    revision: nonNegativeInteger(row.revision, message),
    baseRevision: nonNegativeInteger(row.baseRevision, message),
    bytes: nonNegativeInteger(row.bytes, message),
    fileCount: nonNegativeInteger(row.fileCount, message),
    digest: string(row.digest, message),
  }
}

/** 工作区视图：列表（files）与单文件（path+content base64）两种形态。 */
export function parseAgentWorkspaceView(value: unknown): AgentWorkspaceView {
  const message = 'Agent 工作区响应无效'
  const row = object(value, message)
  const view: AgentWorkspaceView = { version: parseWorkspaceVersion(row.version) }
  if (row.files !== undefined && row.files !== null) {
    if (!Array.isArray(row.files)) throw new Error(message)
    view.files = row.files.map((item) => {
      const file = object(item, message)
      return {
        path: string(file.path, message),
        size: nonNegativeInteger(file.size, message),
        digest: string(file.digest, message),
      }
    })
  }
  const path = optionalString(row, 'path', message)
  if (path !== undefined) view.path = path
  const content = optionalString(row, 'content', message)
  if (content !== undefined) view.content = content
  if (row.quarantined !== undefined && row.quarantined !== null) view.quarantined = boolean(row.quarantined, message)
  if (row.wikiSources !== undefined && row.wikiSources !== null) view.wikiSources = parseWikiRefs(row.wikiSources, message)
  return view
}

function pageQuery(query?: AgentPageQuery): string {
  const params = agentQueryString({ cursor: query?.cursor, limit: query?.limit })
  return params === '' ? '' : `?${params}`
}

function messageQuery(query?: AgentMessageQuery): string {
  const params = agentQueryString({ after: query?.after, limit: query?.limit })
  return params === '' ? '' : `?${params}`
}

function selectionBody(selection: AgentMemorySpaceSelection): string {
  return JSON.stringify({ spaceId: selection.spaceId, includeGlobal: selection.includeGlobal })
}

export function createHttpAgentWorkbenchAdapter(baseUrl = '/api/agent'): AgentWorkbenchAdapter {
  const sessionsBase = (sessionId: string) => `${baseUrl}/sessions/${agentPathPart(sessionId, '会话标识')}`
  const tasksBase = (taskId: string) => `${baseUrl}/tasks/${agentPathPart(taskId, '任务标识')}`
  return {
    async listSessions(query, signal) {
      return parseAgentPage(
        await requestAgentJson(`${baseUrl}/sessions${pageQuery(query)}`, { signal }),
        parseAgentSession,
        '会话分页',
      )
    },
    async getSession(sessionId, signal) {
      return parseAgentSession(await requestAgentJson(sessionsBase(sessionId), { signal }))
    },
    async createSession(input) {
      return parseAgentSession(await requestAgentJson(`${baseUrl}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          modelProfileId: input.modelProfileId,
          modelRevision: input.modelRevision,
        }),
      }))
    },
    async switchModel(sessionId, input) {
      return parseAgentSession(await requestAgentJson(`${sessionsBase(sessionId)}/model`, {
        method: 'PUT',
        body: JSON.stringify({
          modelProfileId: input.modelProfileId,
          modelRevision: input.modelRevision,
        }),
      }))
    },
    async listMessages(sessionId, query, signal) {
      return parseAgentPage(
        await requestAgentJson(`${sessionsBase(sessionId)}/messages${messageQuery(query)}`, { signal }),
        parseAgentMessage,
        '会话消息分页',
      )
    },
    async listTasks(sessionId, query, signal) {
      return parseAgentPage(
        await requestAgentJson(`${sessionsBase(sessionId)}/tasks${pageQuery(query)}`, { signal }),
        parseAgentTask,
        '任务分页',
      )
    },
    async createTask(sessionId, input) {
      return parseAgentRun(await requestAgentJson(`${sessionsBase(sessionId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(agentInputBody(input)),
      }))
    },
    async continueRun(taskId, input) {
      return parseAgentRun(await requestAgentJson(`${tasksBase(taskId)}/runs`, {
        method: 'POST',
        body: JSON.stringify(agentInputBody(input)),
      }))
    },
    async getTask(taskId, signal) {
      return parseAgentTask(await requestAgentJson(tasksBase(taskId), { signal }))
    },
    async getTaskWorkingMemory(taskId, revision, signal) {
      const params = agentQueryString({ revision })
      const suffix = params === '' ? '' : `?${params}`
      return parseAgentWorkingMemory(await requestAgentJson(`${tasksBase(taskId)}/memory${suffix}`, { signal }))
    },
    async readSessionMemorySelection(sessionId, signal) {
      return parseAgentMemorySpaceSelection(await requestAgentJson(`${sessionsBase(sessionId)}/memory`, { signal }))
    },
    async writeSessionMemorySelection(sessionId, selection) {
      return parseAgentMemorySpaceSelection(await requestAgentJson(`${sessionsBase(sessionId)}/memory`, {
        method: 'PUT',
        body: selectionBody(selection),
      }))
    },
    async listModelRequests(runId, query, signal) {
      return parseAgentPage(
        await requestAgentJson(`${baseUrl}/runs/${agentPathPart(runId, '运行标识')}/model-requests${pageQuery(query)}`, { signal }),
        parseAgentModelRequestRecord,
        '模型请求分页',
      )
    },
    async getSessionEnvironment(sessionId, signal) {
      return parseAgentEnvironment(await requestAgentJson(`${sessionsBase(sessionId)}/environment`, { signal }))
    },
    async updateSessionEnvironment(sessionId, expectedRevision, environment) {
      return parseAgentEnvironment(await requestAgentJson(`${sessionsBase(sessionId)}/environment`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision, environment }),
      }))
    },
    async listWorkspace(taskId, signal) {
      return parseAgentWorkspaceView(await requestAgentJson(`${tasksBase(taskId)}/workspace`, { signal }))
    },
    async readWorkspaceFile(taskId, path, signal) {
      const params = agentQueryString({ path })
      return parseAgentWorkspaceView(await requestAgentJson(`${tasksBase(taskId)}/workspace?${params}`, { signal }))
    },
    async writeWorkspaceFile(taskId, path, expectedRevision, bytes) {
      const params = agentQueryString({ path, expectedRevision })
      // 体＝原始文件字节：绝不 JSON 包装或 base64 编码，绝不设 Content-Type。
      const value = await sendRawBytes(`${tasksBase(taskId)}/workspace?${params}`, 'PUT', bytes)
      return parseWorkspaceVersion(value)
    },
    async deleteWorkspaceFile(taskId, path, expectedRevision) {
      const params = agentQueryString({ path, expectedRevision })
      const value = await sendRawBytes(`${tasksBase(taskId)}/workspace?${params}`, 'DELETE', new Uint8Array(0))
      return parseWorkspaceVersion(value)
    },
  }
}

/** AgentInput 体的字段序按服务端 agent_types.go:38-44；可选引用缺省不发。 */
function agentInputBody(input: {
  requestId: string
  content: string
  skills?: readonly { id: string; revision: number; digest?: string }[]
  resources?: readonly { serverId: string; uri: string }[]
  prompts?: readonly { serverId: string; name: string; arguments: Readonly<Record<string, string>> }[]
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    requestId: input.requestId,
    content: input.content,
  }
  if (input.skills !== undefined && input.skills.length > 0) {
    body.skills = input.skills.map((ref) => ({
      id: ref.id,
      revision: ref.revision,
      ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    }))
  }
  if (input.resources !== undefined && input.resources.length > 0) {
    body.resources = input.resources.map((ref) => ({ serverId: ref.serverId, uri: ref.uri }))
  }
  if (input.prompts !== undefined && input.prompts.length > 0) {
    body.prompts = input.prompts.map((ref) => ({ serverId: ref.serverId, name: ref.name, arguments: ref.arguments }))
  }
  return body
}

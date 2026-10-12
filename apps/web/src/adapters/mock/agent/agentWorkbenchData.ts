import type {
  AgentEnvironment,
  AgentMessage,
  AgentModelRequestRecord,
  AgentSession,
  AgentWikiRef,
  RuntimeLimits,
  RuntimeMemoryStatus,
  RuntimePage,
  RuntimeRun,
  RuntimeRunStatus,
  RuntimeTask,
  AgentWorkingMemory,
  AgentWorkspaceVersion,
  AgentWorkspaceView,
} from '@elysian/contracts'
import type { AgentMessageQuery, AgentPageQuery } from '../../../contracts/adapters'

/*
 * Ely 工作台域的确定性演示数据集与状态机（与 agentWorkbenchMockAdapter 配套）。
 * 约定：
 * - 种子相对注入基准时间生成（缺省取当前时钟），测试用 vi.setSystemTime 控制；
 * - Run 状态在读取时按相对时间推进：排队 1.5 秒、执行 4.5 秒后成功；取消请求
 *   只在排队/等待审批时立即终止，执行中的 Run 最快 2 秒后进入 cancelled，
 *   绝不把「取消请求已提交」画成已取消；
 * - requestId 幂等与 409 文案对齐服务端（session_store.go:118-146）：
 *   同 requestId 同输入回读原 Run，不同输入 409 request-conflict；
 * - 会话 busy（活动 Run）期间的新输入/切模型/环境/记忆选择/工作区写删全部
 *   按服务端中文文案拒绝；
 * - seq/lastSeq 全程十进制字符串，经 nextDecimalString 递增，不经 number。
 */

/** 演示限额：与共享 fixture 的 Agent 默认值一致。 */
export const WORKBENCH_DEMO_LIMITS: RuntimeLimits = {
  concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
  callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
  runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
  retentionDays: 30, cancelGraceSeconds: 5, maxModelRequests: 16,
  modelTimeoutSeconds: 60, outputTokens: 4096, tokenBudget: 128000,
  userBytes: 32768, memoryBytes: 16384, modelResponseBytes: 524288,
}

const QUEUED_MS = 1500
const RUN_MS = 6000
const MEMORY_PHASE_MS = 4500
const CANCEL_GRACE_MS = 2000
export const WORKSPACE_PREVIEW_LIMIT_BYTES = 4 * 1024 * 1024
const WORKSPACE_WRITE_LIMIT_BYTES = 128 * 1024 * 1024
const INPUT_LIMIT_BYTES = 32 * 1024

/** 十进制字符串加一：逐位进位，不经 number，大整数不丢精度。 */
export function nextDecimalString(value: string): string {
  let digits = value
  let index = digits.length - 1
  while (index >= 0 && digits.charAt(index) === '9') {
    digits = digits.slice(0, index) + '0' + digits.slice(index + 1)
    index -= 1
  }
  if (index < 0) return `1${digits}`
  return digits.slice(0, index) + String.fromCharCode(digits.charCodeAt(index) + 1) + digits.slice(index + 1)
}

/** 十进制字符串数值比较（先长后字典序）。 */
export function compareDecimalStrings(a: string, b: string): number {
  if (a === b) return 0
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : 1
}

/** 演示摘要：确定性伪摘要（非加密），仅供演示数据回显。 */
export function demoDigest(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let value = hash
  let hex = ''
  for (let round = 0; round < 8; round += 1) {
    value = Math.imul(value ^ (round + 1), 0x45d9f3b) >>> 0
    hex += value.toString(16).padStart(8, '0')
  }
  return hex
}

/** 演示模式的领域错误：code 与服务端家族对齐，message 为中文。 */
export class AgentWorkbenchMockError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentWorkbenchMockError'
    this.code = code
  }
}

export type MockRunMode = 'normal' | 'waiting-approval'

type MockRun = {
  id: string
  runNumber: number
  requestId: string
  /** 提交时的规范化输入（requestId/content/引用），幂等回读时比对。 */
  canonical: string
  input: string
  createdAtMs: number
  modelProfileId: string
  modelRevision: number
  mode: MockRunMode
  userSeq: string
  replySeq: string
  cancelRequestedAtMs?: number
}

type MockMessage = {
  id: string
  taskId: string
  runId: string
  seq: string
  role: 'user' | 'assistant'
  content: string
  createdAtMs: number
  quarantined?: boolean
  wikiSources?: readonly AgentWikiRef[]
}

type MockTask = {
  id: string
  sessionId: string
  requestId: string
  goal: string
  createdAtMs: number
  runs: MockRun[]
  workspace: Map<string, Uint8Array>
  workspaceRevision: number
  workspaceQuarantined: boolean
}

type MockEnvironmentDraft = {
  skills: readonly { id: string; revision: number; digest?: string }[]
  servers: readonly { id: string; revision: number; digest?: string }[]
  tools: readonly string[]
  resources: readonly { serverId: string; uri: string }[]
  executionProfiles: readonly { id: string; revision: number; digest?: string }[]
  grants: readonly { id: string; revision: number; digest?: string }[]
  trustedReadOnly: readonly string[]
  resourceRules?: readonly { id: string; revision: number; digest?: string }[]
}

type MockSession = {
  id: string
  title: string
  createdAtMs: number
  lastActivityMs: number
  modelProfileId: string
  modelRevision: number
  envRevision: number
  envDraft?: MockEnvironmentDraft
  memorySelection: { spaceId: string; includeGlobal: boolean }
  tasks: MockTask[]
  messages: MockMessage[]
  seqAllocated: string
}

type WorkbenchData = {
  sessions: MockSession[]
  sessionIdCounter: number
  taskIdCounter: number
  runIdCounter: number
  messageIdCounter: number
}

let data: WorkbenchData = createSeed(new Date())

function createSeed(now: Date): WorkbenchData {
  const base = now.getTime()
  // 种子已占用 session-1/2、task-1..3、run-1..3 与 msg-1..5，计数器从其后再出发。
  const seed: WorkbenchData = { sessions: [], sessionIdCounter: 3, taskIdCounter: 3, runIdCounter: 3, messageIdCounter: 5 }

  const first: MockSession = {
    id: 'session-1',
    title: '容器巡检演示',
    createdAtMs: base - 3_600_000,
    lastActivityMs: base - 1_700_000,
    modelProfileId: 'profile-1',
    modelRevision: 2,
    envRevision: 1,
    memorySelection: { spaceId: 'space-1', includeGlobal: true },
    tasks: [],
    messages: [],
    // 种子消息已占用 seq 1..4（task-1 与 task-2 各一对），游标从 4 再出发。
    seqAllocated: '4',
  }
  const firstTask: MockTask = {
    id: 'task-1',
    sessionId: 'session-1',
    requestId: 'seed-request-1',
    goal: '检查容器运行状态',
    createdAtMs: base - 3_500_000,
    runs: [{
      id: 'run-1',
      runNumber: 1,
      requestId: 'seed-request-1',
      canonical: JSON.stringify({ requestId: 'seed-request-1', content: '检查容器运行状态', skills: [], resources: [], prompts: [] }),
      input: '检查容器运行状态',
      createdAtMs: base - 3_500_000,
      modelProfileId: 'profile-1',
      modelRevision: 2,
      mode: 'normal',
      userSeq: '1',
      replySeq: '2',
    }],
    workspace: new Map([
      ['notes/summary.md', new TextEncoder().encode('# 巡检摘要\n\n容器列表为空，策略未变更。\n')],
      ['raw/containers.json', new TextEncoder().encode('{"containers":[]}\n')],
    ]),
    workspaceRevision: 1,
    workspaceQuarantined: false,
  }
  const secondTask: MockTask = {
    id: 'task-2',
    sessionId: 'session-1',
    requestId: 'seed-request-2',
    goal: '整理面板约定',
    createdAtMs: base - 1_800_000,
    runs: [{
      id: 'run-2',
      runNumber: 1,
      requestId: 'seed-request-2',
      canonical: JSON.stringify({ requestId: 'seed-request-2', content: '整理面板约定', skills: [], resources: [], prompts: [] }),
      input: '整理面板约定',
      createdAtMs: base - 1_800_000,
      modelProfileId: 'profile-1',
      modelRevision: 2,
      mode: 'normal',
      userSeq: '3',
      replySeq: '4',
    }],
    workspace: new Map([
      ['conventions.md', new TextEncoder().encode('# 约定\n\n演示工作区文件，来源页面已撤回。\n')],
    ]),
    workspaceRevision: 1,
    workspaceQuarantined: true,
  }
  first.tasks = [firstTask, secondTask]
  first.messages = [
    {
      id: 'msg-1', taskId: 'task-1', runId: 'run-1', seq: '1', role: 'user',
      content: '检查容器运行状态', createdAtMs: base - 3_500_000,
    },
    {
      id: 'msg-2', taskId: 'task-1', runId: 'run-1', seq: '2', role: 'assistant',
      content: '已按只读工具核对：当前容器列表为空，防火墙策略未发生变化。详细过程见运行记录。',
      createdAtMs: base - 3_494_000,
      wikiSources: [{ pageId: 'wiki-page-1', revision: 1, digest: demoDigest('wiki-page-1') }],
    },
    {
      id: 'msg-3', taskId: 'task-2', runId: 'run-2', seq: '3', role: 'user',
      content: '整理面板约定', createdAtMs: base - 1_800_000,
    },
    {
      id: 'msg-4', taskId: 'task-2', runId: 'run-2', seq: '4', role: 'assistant',
      content: '（该答复引用的来源已失效，内容不再展示。）',
      createdAtMs: base - 1_794_000,
      quarantined: true,
    },
  ]

  const second: MockSession = {
    id: 'session-2',
    title: '等待审批的演示会话',
    createdAtMs: base - 600_000,
    lastActivityMs: base - 60_000,
    modelProfileId: 'profile-1',
    modelRevision: 2,
    envRevision: 1,
    memorySelection: { spaceId: '', includeGlobal: false },
    tasks: [{
      id: 'task-3',
      sessionId: 'session-2',
      requestId: 'seed-request-3',
      goal: '演练等待审批状态',
      createdAtMs: base - 60_000,
      runs: [{
        id: 'run-3',
        runNumber: 1,
        requestId: 'seed-request-3',
        canonical: JSON.stringify({ requestId: 'seed-request-3', content: '演练等待审批状态', skills: [], resources: [], prompts: [] }),
        input: '演练等待审批状态',
        createdAtMs: base - 60_000,
        modelProfileId: 'profile-1',
        modelRevision: 2,
        mode: 'waiting-approval',
        userSeq: '1',
        replySeq: '2',
      }],
      workspace: new Map(),
      workspaceRevision: 0,
      workspaceQuarantined: false,
    }],
    messages: [{
      id: 'msg-5', taskId: 'task-3', runId: 'run-3', seq: '1', role: 'user',
      content: '演练等待审批状态', createdAtMs: base - 60_000,
    }],
    seqAllocated: '2',
  }

  seed.sessions = [second, first]
  return seed
}

/** 演示种子复位；now 供测试注入基准时间。 */
export function resetAgentWorkbenchData(now: Date = new Date()): void {
  data = createSeed(now)
}

function nowMs(): number {
  return Date.now()
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

type RunState = {
  status: RuntimeRunStatus
  phase?: RuntimeRun['phase']
  startedAtMs?: number
  endedAtMs?: number
}

/** 读取时按相对时间推导 Run 状态；等待审批的 Run 停在 waiting-approval 等待人工决定。 */
function runState(run: MockRun, atMs: number): RunState {
  if (run.cancelRequestedAtMs !== undefined) {
    if (run.mode === 'waiting-approval' || atMs < run.createdAtMs + QUEUED_MS) {
      return { status: 'cancelled', phase: undefined, startedAtMs: undefined, endedAtMs: run.cancelRequestedAtMs }
    }
    const stopAt = Math.min(run.createdAtMs + RUN_MS, run.cancelRequestedAtMs + CANCEL_GRACE_MS)
    if (atMs >= stopAt) return { status: 'cancelled', endedAtMs: stopAt }
  }
  if (run.mode === 'waiting-approval') {
    if (atMs < run.createdAtMs + QUEUED_MS) return { status: 'queued', phase: 'queued' }
    return { status: 'waiting-approval', phase: 'waiting-approval' }
  }
  const end = run.createdAtMs + RUN_MS
  if (atMs < run.createdAtMs + QUEUED_MS) return { status: 'queued', phase: 'queued' }
  if (atMs < end) {
    return {
      status: 'running',
      phase: atMs < run.createdAtMs + MEMORY_PHASE_MS ? 'inference' : 'final-memory',
      startedAtMs: run.createdAtMs + QUEUED_MS,
    }
  }
  return { status: 'succeeded', phase: 'completed', startedAtMs: run.createdAtMs + QUEUED_MS, endedAtMs: end }
}

function isTerminal(status: RuntimeRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

export function isRunStatusActive(status: RuntimeRunStatus): boolean {
  return !isTerminal(status)
}

function activeRun(session: MockSession): MockRun | undefined {
  for (const task of session.tasks) {
    for (const run of task.runs) {
      if (isRunStatusActive(runState(run, nowMs()).status)) return run
    }
  }
  return undefined
}

function sessionById(sessionId: string): MockSession {
  const session = data.sessions.find((item) => item.id === sessionId)
  if (session === undefined) throw new AgentWorkbenchMockError('not-found', `演示数据中不存在会话 ${sessionId}`)
  return session
}

function taskById(taskId: string): { session: MockSession; task: MockTask } {
  for (const session of data.sessions) {
    const task = session.tasks.find((item) => item.id === taskId)
    if (task !== undefined) return { session, task }
  }
  throw new AgentWorkbenchMockError('not-found', `演示数据中不存在任务 ${taskId}`)
}

function sessionLastSeq(session: MockSession): string {
  let last = '0'
  for (const message of session.messages) {
    if (compareDecimalStrings(message.seq, last) > 0) last = message.seq
  }
  return last
}

function materializeReply(session: MockSession, run: MockRun): void {
  if (session.messages.some((message) => message.seq === run.replySeq)) return
  const state = runState(run, nowMs())
  if (state.status !== 'succeeded') return
  session.messages.push({
    id: `msg-${(data.messageIdCounter += 1)}`,
    taskId: taskOfRun(session, run).id,
    runId: run.id,
    seq: run.replySeq,
    role: 'assistant',
    content: `已完成「${run.input}」：演示答复（实际答复以服务端模型返回为准）。`,
    createdAtMs: state.endedAtMs ?? nowMs(),
  })
  session.lastActivityMs = nowMs()
}

function taskOfRun(session: MockSession, run: MockRun): MockTask {
  const task = session.tasks.find((item) => item.runs.some((entry) => entry.id === run.id))
  if (task === undefined) throw new AgentWorkbenchMockError('not-found', `演示数据中不存在运行 ${run.id}`)
  return task
}

function toSession(session: MockSession): AgentSession {
  materializeSession(session)
  const active = activeRun(session)
  const value: AgentSession = {
    id: session.id,
    title: session.title,
    createdAt: iso(session.createdAtMs),
    lastActivityAt: iso(session.lastActivityMs),
    modelProfileId: session.modelProfileId,
    modelRevision: session.modelRevision,
    lastSeq: sessionLastSeq(session),
  }
  if (active !== undefined) value.activeRunId = active.id
  return value
}

function materializeSession(session: MockSession): void {
  for (const task of session.tasks) {
    for (const run of task.runs) materializeReply(session, run)
  }
}

function taskMemoryStatus(task: MockTask): RuntimeMemoryStatus {
  const latest = task.runs[task.runs.length - 1]
  if (latest === undefined) return 'unchanged'
  const state = runState(latest, nowMs())
  if (isRunStatusActive(state.status)) return 'stale'
  if (state.status === 'succeeded') return 'updated'
  return 'unchanged'
}

function toRun(session: MockSession, task: MockTask, run: MockRun): RuntimeRun {
  materializeReply(session, run)
  const state = runState(run, nowMs())
  const reply = session.messages.find((message) => message.seq === run.replySeq)
  const value: RuntimeRun = {
    id: run.id,
    taskId: task.id,
    status: state.status,
    createdAt: iso(run.createdAtMs),
    limits: WORKBENCH_DEMO_LIMITS,
    usage: {
      calls: 0,
      resultBytes: reply === undefined ? 0 : reply.content.length,
      modelRequests: state.status === 'queued' ? 0 : state.status === 'succeeded' ? 2 : 1,
      estimatedTokens: 128 + run.input.length * 2,
      ...(state.status === 'succeeded' ? { tokens: 96 + run.input.length, actualTokens: 96 + run.input.length } : {}),
    },
    lastSeq: sessionLastSeq(session),
    sessionId: session.id,
    runNumber: run.runNumber,
    requestId: run.requestId,
    input: run.input,
    ...(state.startedAtMs === undefined ? {} : { startedAt: iso(state.startedAtMs) }),
    ...(state.endedAtMs === undefined ? {} : { endedAt: iso(state.endedAtMs) }),
    ...(state.status === 'succeeded' ? { endReason: 'completed' } : {}),
    ...(run.cancelRequestedAtMs === undefined ? {} : { cancelRequestedAt: iso(run.cancelRequestedAtMs) }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
    memoryStatus: taskMemoryStatus(task),
    historySeq: sessionLastSeq(session),
  }
  return value
}

/** 运行记录域与工作台共用这份 Run 事实，避免请求核对读到另一套演示数据。 */
export function getWorkbenchRun(runId: string): RuntimeRun | undefined {
  for (const session of data.sessions) {
    for (const task of session.tasks) {
      const run = task.runs.find((item) => item.id === runId)
      if (run !== undefined) return toRun(session, task, run)
    }
  }
  return undefined
}

export function listWorkbenchRunRecords(): readonly { run: RuntimeRun; rowid: string }[] {
  return data.sessions.flatMap((session) => session.tasks.flatMap((task) => task.runs.map((run) => ({
    run: toRun(session, task, run),
    rowid: String(8_000_000_000_000 + Number(run.id.slice(4))),
  }))))
}

function toTask(session: MockSession, task: MockTask): RuntimeTask {
  materializeSession(session)
  const latestRun = task.runs[task.runs.length - 1]
  return {
    id: task.id,
    requestId: task.requestId,
    kind: 'agent',
    driverVersion: 'demo-v1',
    createdAt: iso(task.createdAtMs),
    sessionId: session.id,
    goal: task.goal,
    steps: null,
    ...(latestRun === undefined ? {} : { latestRun: toRun(session, task, latestRun) }),
    memoryStatus: taskMemoryStatus(task),
  }
}

function toMessage(session: MockSession, message: MockMessage): AgentMessage {
  const value: AgentMessage = {
    id: message.id,
    sessionId: session.id,
    taskId: message.taskId,
    runId: message.runId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    createdAt: iso(message.createdAtMs),
  }
  if (message.quarantined) value.quarantined = true
  if (message.wikiSources !== undefined) value.wikiSources = message.wikiSources
  const task = session.tasks.find((item) => item.id === message.taskId)
  const run = task?.runs.find((item) => item.id === message.runId)
  if (run !== undefined) value.runStatus = runState(run, nowMs()).status
  return value
}

function workspaceVersion(task: MockTask): AgentWorkspaceVersion {
  return {
    taskId: task.id,
    revision: task.workspaceRevision,
    baseRevision: Math.max(0, task.workspaceRevision - 1),
    bytes: [...task.workspace.values()].reduce((total, file) => total + file.byteLength, 0),
    fileCount: task.workspace.size,
    digest: demoDigest(`workspace:${task.id}:${task.workspaceRevision}`),
  }
}

function workspaceView(task: MockTask): AgentWorkspaceView {
  return {
    version: workspaceVersion(task),
    files: [...task.workspace.keys()].sort().map((path) => ({
      path,
      size: task.workspace.get(path)?.byteLength ?? 0,
      digest: demoDigest(`file:${task.id}:${path}`),
    })),
    ...(task.workspaceQuarantined ? { quarantined: true } : {}),
  }
}

function requireIdleForWorkspace(session: MockSession, task: MockTask): void {
  if (activeRun(session) !== undefined) {
    throw new AgentWorkbenchMockError('session-busy', '会话仍有任务排队、运行或等待审批，请结束后再修改工作区')
  }
  const latest = task.runs[task.runs.length - 1]
  if (latest !== undefined && isRunStatusActive(runState(latest, nowMs()).status)) {
    throw new AgentWorkbenchMockError('task-busy', '任务尚未结束，不能修改工作区')
  }
}

function acceptInput(input: { requestId: string; content: string }): void {
  if (!input.requestId) throw new AgentWorkbenchMockError('invalid-request', 'requestId 不能为空')
  if (new TextEncoder().encode(input.content).length > INPUT_LIMIT_BYTES) {
    throw new AgentWorkbenchMockError('input-too-large', '输入内容超过 32 KiB 上限')
  }
  if (!input.content.trim()) throw new AgentWorkbenchMockError('invalid-input', '输入内容不能为空')
}

function canonicalInput(input: { requestId: string; content: string; skills?: readonly unknown[]; resources?: readonly unknown[]; prompts?: readonly unknown[] }): string {
  return JSON.stringify({
    requestId: input.requestId,
    content: input.content,
    skills: input.skills ?? [],
    resources: input.resources ?? [],
    prompts: input.prompts ?? [],
  })
}

function findRunByRequestId(requestId: string): { session: MockSession; task: MockTask; run: MockRun } | undefined {
  for (const session of data.sessions) {
    for (const task of session.tasks) {
      const run = task.runs.find((item) => item.requestId === requestId)
      if (run !== undefined) return { session, task, run }
    }
  }
  return undefined
}

/** 提交新任务或续轮的共享语义：幂等回读、busy 与 model-changed 拒绝。 */
function acceptSubmission(sessionId: string, taskId: string | undefined, input: {
  requestId: string
  content: string
  skills?: readonly { id: string; revision: number; digest?: string }[]
  resources?: readonly { serverId: string; uri: string }[]
  prompts?: readonly { serverId: string; name: string; arguments: Readonly<Record<string, string>> }[]
}): { session: MockSession; task: MockTask; run: MockRun; duplicate: boolean } {
  acceptInput(input)
  const session = sessionById(sessionId)
  const prior = findRunByRequestId(input.requestId)
  if (prior !== undefined) {
    if (prior.run.canonical !== canonicalInput(input)) {
      throw new AgentWorkbenchMockError('request-conflict', '请求标识已用于不同的任务输入')
    }
    return { ...prior, duplicate: true }
  }
  if (activeRun(session) !== undefined) {
    throw new AgentWorkbenchMockError('session-busy', '会话仍有任务排队或运行，请结束后再输入')
  }
  let task: MockTask
  if (taskId === undefined) {
    task = {
      id: `task-${(data.taskIdCounter += 1)}`,
      sessionId: session.id,
      requestId: input.requestId,
      goal: input.content,
      createdAtMs: nowMs(),
      runs: [],
      workspace: new Map(),
      workspaceRevision: 0,
      workspaceQuarantined: false,
    }
    session.tasks.unshift(task)
  } else {
    const existing = session.tasks.find((item) => item.id === taskId)
    if (existing === undefined) throw new AgentWorkbenchMockError('not-found', `演示数据中不存在任务 ${taskId}`)
    task = existing
  }
  const lastRun = task.runs[task.runs.length - 1]
  if (lastRun !== undefined && (lastRun.modelProfileId !== session.modelProfileId || lastRun.modelRevision !== session.modelRevision)) {
    throw new AgentWorkbenchMockError('model-changed', '会话模型已变化，请重新提交')
  }
  const run: MockRun = {
    id: `run-${(data.runIdCounter += 1)}`,
    runNumber: task.runs.length + 1,
    requestId: input.requestId,
    canonical: canonicalInput(input),
    input: input.content,
    createdAtMs: nowMs(),
    modelProfileId: session.modelProfileId,
    modelRevision: session.modelRevision,
    mode: 'normal',
    userSeq: nextDecimalString(session.seqAllocated),
    replySeq: '',
  }
  run.replySeq = nextDecimalString(run.userSeq)
  session.seqAllocated = run.replySeq
  task.runs.push(run)
  session.messages.push({
    id: `msg-${(data.messageIdCounter += 1)}`,
    taskId: task.id,
    runId: run.id,
    seq: run.userSeq,
    role: 'user',
    content: input.content,
    createdAtMs: nowMs(),
  })
  session.lastActivityMs = nowMs()
  return { session, task, run, duplicate: false }
}

/** 演示列表分页的位移游标：逐位累积且封顶安全整数，不经 Number()/parseInt。 */
function cursorToOffset(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new AgentWorkbenchMockError('invalid-cursor', '分页游标必须为非负十进制字符串')
  }
  let result = 0
  for (const char of value) {
    result = result * 10 + (char.charCodeAt(0) - 48)
    if (result > Number.MAX_SAFE_INTEGER) {
      throw new AgentWorkbenchMockError('invalid-cursor', '分页游标超出范围')
    }
  }
  return result
}

function offsetToCursor(value: number): string {
  return value <= 0 ? '0' : String(value)
}

/** 数据集只读出口（供适配器与测试检视，不导出可变引用）。 */
export const workbenchDemoData = {
  sessionIds(): readonly string[] {
    return data.sessions.map((session) => session.id)
  },
  taskIds(sessionId: string): readonly string[] {
    return sessionById(sessionId).tasks.map((task) => task.id)
  },
}

/** 供 mock 适配器使用的内部出口（同目录文件间协作，不对外）。 */
export const workbenchInternals = {
  listSessionsPage(query?: AgentPageQuery): RuntimePage<AgentSession> {
    const limit = query?.limit ?? 50
    const start = cursorToOffset(query?.cursor)
    const items = data.sessions.slice(start, start + limit).map(toSession)
    const next = start + items.length
    return {
      items,
      nextCursor: offsetToCursor(next),
      hasMore: next < data.sessions.length,
    }
  },
  getSession(sessionId: string): AgentSession {
    return toSession(sessionById(sessionId))
  },
  createSession(input: { title: string; modelProfileId: string; modelRevision: number }): AgentSession {
    const title = input.title.trim()
    if (!title) throw new AgentWorkbenchMockError('invalid-input', '会话标题不能为空')
    const now = nowMs()
    const session: MockSession = {
      id: `session-${(data.sessionIdCounter += 1)}`,
      title,
      createdAtMs: now,
      lastActivityMs: now,
      modelProfileId: input.modelProfileId,
      modelRevision: input.modelRevision,
      envRevision: 1,
      memorySelection: { spaceId: '', includeGlobal: false },
      tasks: [],
      messages: [],
      seqAllocated: '0',
    }
    data.sessions.unshift(session)
    return toSession(session)
  },
  switchModel(sessionId: string, input: { modelProfileId: string; modelRevision: number }): AgentSession {
    const session = sessionById(sessionId)
    if (activeRun(session) !== undefined) {
      throw new AgentWorkbenchMockError('session-busy', '会话仍有任务排队或运行，请结束后再切换模型')
    }
    session.modelProfileId = input.modelProfileId
    session.modelRevision = input.modelRevision
    session.lastActivityMs = nowMs()
    return toSession(session)
  },
  listMessagesPage(sessionId: string, query?: AgentMessageQuery): RuntimePage<AgentMessage> {
    const session = sessionById(sessionId)
    materializeSession(session)
    const limit = query?.limit ?? 100
    const after = query?.after ?? '0'
    if (!/^(0|[1-9][0-9]*)$/.test(after)) {
      throw new AgentWorkbenchMockError('invalid-cursor', '消息游标必须为非负十进制字符串')
    }
    if (compareDecimalStrings(after, sessionLastSeq(session)) > 0) {
      throw new AgentWorkbenchMockError('future-cursor', '消息游标超过当前会话进度')
    }
    const sorted = [...session.messages].sort((left, right) => compareDecimalStrings(left.seq, right.seq))
    const from = sorted.findIndex((message) => compareDecimalStrings(message.seq, after) > 0)
    const start = from === -1 ? sorted.length : from
    const items = sorted.slice(start, start + limit).map((message) => toMessage(session, message))
    const lastItem = items.at(-1)
    return {
      items,
      nextCursor: lastItem === undefined ? after : lastItem.seq,
      hasMore: start + items.length < sorted.length,
    }
  },
  listTasksPage(sessionId: string, query?: AgentPageQuery): RuntimePage<RuntimeTask> {
    const session = sessionById(sessionId)
    const limit = query?.limit ?? 50
    const start = cursorToOffset(query?.cursor)
    const items = session.tasks.slice(start, start + limit).map((task) => toTask(session, task))
    const next = start + items.length
    return { items, nextCursor: offsetToCursor(next), hasMore: next < session.tasks.length }
  },
  createTask(sessionId: string, input: Parameters<typeof acceptSubmission>[2]): RuntimeRun {
    const { session, task, run } = acceptSubmission(sessionId, undefined, input)
    return toRun(session, task, run)
  },
  continueRun(taskId: string, input: Parameters<typeof acceptSubmission>[2]): RuntimeRun {
    const { session } = taskById(taskId)
    const accepted = acceptSubmission(session.id, taskId, input)
    return toRun(accepted.session, accepted.task, accepted.run)
  },
  getTask(taskId: string): RuntimeTask {
    const { session, task } = taskById(taskId)
    return toTask(session, task)
  },
  getWorkingMemory(taskId: string): AgentWorkingMemory {
    const { session, task } = taskById(taskId)
    materializeSession(session)
    const succeeded = task.runs.filter((run) => runState(run, nowMs()).status === 'succeeded').length
    const latest = task.runs[task.runs.length - 1]
    const lastTerminal = latest === undefined ? undefined : runState(latest, nowMs())
    const memory: AgentWorkingMemory = {
      taskId: task.id,
      revision: Math.max(1, succeeded),
      updatedAt: iso(lastTerminal?.endedAtMs ?? task.createdAtMs),
      coverage: {
        runNumber: latest?.runNumber ?? 0,
        eventSeq: sessionLastSeq(session),
      },
      objective: task.goal,
      constraints: ['仅执行只读查询，写操作须经审批'],
      facts: [
        { text: `目标「${task.goal}」已按演示数据登记`, sources: latest === undefined ? [] : [{ runId: latest.id, eventSeq: latest.userSeq }] },
      ],
      todos: [],
      openQuestions: [],
      summary: task.runs.length === 0 ? '任务尚未运行。' : '演示工作记忆摘要：过程事实以运行记录为准。',
      memoryStatus: taskMemoryStatus(task),
    }
    return memory
  },
  readMemorySelection(sessionId: string): { spaceId: string; includeGlobal: boolean } {
    const session = sessionById(sessionId)
    return { ...session.memorySelection }
  },
  writeMemorySelection(sessionId: string, selection: { spaceId: string; includeGlobal: boolean }): { spaceId: string; includeGlobal: boolean } {
    const session = sessionById(sessionId)
    if (activeRun(session) !== undefined) {
      throw new AgentWorkbenchMockError('session-busy', '会话忙碌时不能修改记忆空间')
    }
    session.memorySelection = { spaceId: selection.spaceId, includeGlobal: selection.includeGlobal }
    session.lastActivityMs = nowMs()
    return { ...session.memorySelection }
  },
  listModelRequestsPage(runId: string, query?: AgentPageQuery): RuntimePage<AgentModelRequestRecord> {
    let session: MockSession | undefined
    let task: MockTask | undefined
    let run: MockRun | undefined
    for (const candidate of data.sessions) {
      for (const candidateTask of candidate.tasks) {
        const found = candidateTask.runs.find((item) => item.id === runId)
        if (found !== undefined) {
          session = candidate
          task = candidateTask
          run = found
        }
      }
    }
    if (session === undefined || task === undefined || run === undefined) {
      throw new AgentWorkbenchMockError('not-found', `演示数据中不存在运行 ${runId}`)
    }
    materializeSession(session)
    const state = runState(run, nowMs())
    const records: AgentModelRequestRecord[] = []
    if (state.status !== 'queued') {
      records.push({
        id: `${run.id}-mr-1`,
        runId: run.id,
        index: 0,
        purpose: 'inference',
        status: isTerminal(state.status) ? 'succeeded' : 'running',
        startedAt: iso(run.createdAtMs + QUEUED_MS),
        contextRefs: [{ runId: run.id, eventSeq: run.userSeq }],
        memoryRevision: 1,
        estimatedTokens: 128 + run.input.length * 2,
        historySeq: run.userSeq,
        eventSeq: run.userSeq,
        ...(isTerminal(state.status)
          ? {
              endedAt: iso((state.startedAtMs ?? run.createdAtMs) + 2000),
              response: {
                content: '',
                finishReason: 'stop',
                usage: { promptTokens: 96, completionTokens: 32, totalTokens: 128 },
              },
            }
          : {}),
      })
    }
    if (state.status === 'succeeded') {
      records.push({
        id: `${run.id}-mr-2`,
        runId: run.id,
        index: 1,
        purpose: 'final-memory',
        status: 'succeeded',
        startedAt: iso(run.createdAtMs + MEMORY_PHASE_MS),
        endedAt: iso(run.createdAtMs + RUN_MS),
        contextRefs: [{ runId: run.id, eventSeq: run.replySeq }],
        memoryRevision: 2,
        estimatedTokens: 64,
        historySeq: run.replySeq,
        eventSeq: run.replySeq,
      })
    }
    const limit = query?.limit ?? 50
    const start = cursorToOffset(query?.cursor)
    const items = records.slice(start, start + limit)
    const next = start + items.length
    return { items, nextCursor: offsetToCursor(next), hasMore: next < records.length }
  },
  getEnvironment(sessionId: string): AgentEnvironment {
    const session = sessionById(sessionId)
    return environmentOf(session)
  },
  updateEnvironment(sessionId: string, expectedRevision: number, environment: AgentEnvironment): AgentEnvironment {
    const session = sessionById(sessionId)
    if (activeRun(session) !== undefined) {
      throw new AgentWorkbenchMockError('session-busy', '会话忙碌时不能修改环境')
    }
    if (expectedRevision !== session.envRevision) {
      throw new AgentWorkbenchMockError('revision-conflict', '会话环境已变化，请重新读取后再试')
    }
    session.envRevision += 1
    session.envDraft = {
      skills: [...environment.skills],
      servers: [...environment.servers],
      tools: [...environment.tools],
      resources: [...environment.resources],
      executionProfiles: [...environment.executionProfiles],
      grants: [...environment.grants],
      trustedReadOnly: [...environment.trustedReadOnly],
      resourceRules: environment.resourceRules === undefined ? undefined : [...environment.resourceRules],
    }
    session.lastActivityMs = nowMs()
    return environmentOf(session)
  },
  listWorkspace(taskId: string): AgentWorkspaceView {
    const { task } = taskById(taskId)
    return workspaceView(task)
  },
  readWorkspaceFile(taskId: string, path: string): AgentWorkspaceView {
    const { task } = taskById(taskId)
    const file = task.workspace.get(path)
    if (file === undefined) throw new AgentWorkbenchMockError('not-found', `演示工作区中不存在文件 ${path}`)
    if (file.byteLength > WORKSPACE_PREVIEW_LIMIT_BYTES) {
      throw new AgentWorkbenchMockError('workspace-file-too-large', '文件内容超过 4 MiB，无法预览')
    }
    const view: AgentWorkspaceView = {
      version: workspaceVersion(task),
      path,
      content: bytesToBase64(file),
      ...(task.workspaceQuarantined ? { quarantined: true } : {}),
    }
    return view
  },
  writeWorkspaceFile(taskId: string, path: string, expectedRevision: number, bytes: Uint8Array): AgentWorkspaceVersion {
    const { session, task } = taskById(taskId)
    if (!path) throw new AgentWorkbenchMockError('workspace-input', '必须提供要写入的文件路径')
    if (bytes.byteLength > WORKSPACE_WRITE_LIMIT_BYTES) {
      throw new AgentWorkbenchMockError('input-too-large', '文件超过 128 MiB 写入上限')
    }
    requireIdleForWorkspace(session, task)
    if (expectedRevision !== task.workspaceRevision) {
      throw new AgentWorkbenchMockError('workspace-revision-conflict', '任务工作区已变化，请重新读取后重试')
    }
    task.workspace.set(path, new Uint8Array(bytes))
    task.workspaceRevision += 1
    return workspaceVersion(task)
  },
  deleteWorkspaceFile(taskId: string, path: string, expectedRevision: number): AgentWorkspaceVersion {
    const { session, task } = taskById(taskId)
    requireIdleForWorkspace(session, task)
    if (expectedRevision !== task.workspaceRevision) {
      throw new AgentWorkbenchMockError('workspace-revision-conflict', '任务工作区已变化，请重新读取后重试')
    }
    if (!task.workspace.delete(path)) {
      throw new AgentWorkbenchMockError('not-found', `演示工作区中不存在文件 ${path}`)
    }
    task.workspaceRevision += 1
    return workspaceVersion(task)
  },
  /** 取消：排队/等待审批立即终止；执行中只登记请求，状态由 runState 推迟到终态。 */
  requestCancel(runId: string): RuntimeRun {
    for (const session of data.sessions) {
      for (const task of session.tasks) {
        const run = task.runs.find((item) => item.id === runId)
        if (run === undefined) continue
        const state = runState(run, nowMs())
        if (isTerminal(state.status)) {
          throw new AgentWorkbenchMockError('invalid-state', '运行已结束，不能重复取消')
        }
        if (run.cancelRequestedAtMs === undefined) run.cancelRequestedAtMs = nowMs()
        return toRun(session, task, run)
      }
    }
    throw new AgentWorkbenchMockError('not-found', `演示数据中不存在运行 ${runId}`)
  },
}

function environmentOf(session: MockSession): AgentEnvironment {
  const draft = session.envDraft
  return {
    sessionId: session.id,
    revision: session.envRevision,
    skills: draft?.skills ?? [],
    servers: draft?.servers ?? [],
    tools: draft?.tools ?? [],
    resources: draft?.resources ?? [],
    executionProfiles: draft?.executionProfiles ?? [],
    grants: draft?.grants ?? [],
    trustedReadOnly: draft?.trustedReadOnly ?? [],
    ...(draft?.resourceRules === undefined ? {} : { resourceRules: draft.resourceRules }),
  }
}

/** 浏览器环境 base64 编码（分块，避免 String.fromCharCode 参数上限）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** 浏览器环境 base64 解码为原始字节。 */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

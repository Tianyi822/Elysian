import { create } from 'zustand'
import type {
  AgentContextItem,
  AgentOperation,
  RuntimeCall,
  RuntimeEvent,
  AgentCreateSessionInput,
  AgentEnvironment,
  AgentInput,
  AgentMemorySpaceSelection,
  AgentMessage,
  AgentModelRequestRecord,
  AgentSession,
  AgentSwitchModelInput,
  AgentWorkingMemory,
  AgentWorkspaceView,
  RuntimeRun,
  RuntimeTask,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AGENT_REQUEST_ID_PATTERN, compareDecimalCursors } from '../adapters/http/agent/agentShared'

/*
 * Ely 工作台域 store：三栏（会话/任务/详情面板）共用的数据面。
 * 职责边界：
 * - 全部读写经 gateway.agentWorkbench（取消经 gateway.agentRuns，是服务端
 *   POST /runs/{id}/cancel 的唯一网关接缝）；
 * - 每个读取切片有独立闭包 sequence，丢弃过期响应；静默刷新保留旧内容；
 * - 消息按 seq 十进制字符串排序、按 id 去重，增量游标空页保留；
 * - 选择态只在本 store；写动作成功后主动回读受影响切片（服务端为权威）；
 * - busy（activeRunId/activeWorkflowId 非空）由页面从 sessionDetail 派生并禁用
 *   控件，409 的服务端中文文案经写动作抛错透传给调用方展示。
 */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export type WorkbenchDetailTab = 'run' | 'memory' | 'requests' | 'workspace' | 'facts'
type ReadOptions = { silent?: boolean; signal?: AbortSignal }
export type WorkbenchDraft = { content: string; skills: readonly string[]; resources: readonly string[]; prompts: readonly string[]; promptArguments: Record<string, string> }
export type PendingWorkbenchInput = { sessionId: string; taskId?: string; input: AgentInput; uncertain: boolean }

const RECOVERY_KEY = 'elysian.agent.workbench.recovery.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function readWorkbenchRecovery(): { drafts: Record<string, WorkbenchDraft>; pendingInputs: Record<string, PendingWorkbenchInput> } {
  const empty = { drafts: {}, pendingInputs: {} }
  try {
    if (typeof sessionStorage === 'undefined') return empty
    const root: unknown = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) ?? 'null')
    if (!isRecord(root)) return empty
    const drafts: Record<string, WorkbenchDraft> = {}
    const pendingInputs: Record<string, PendingWorkbenchInput> = {}
    if (isRecord(root.drafts)) {
      for (const [key, value] of Object.entries(root.drafts)) {
        if (!isRecord(value) || typeof value.content !== 'string' || !stringList(value.skills) || !stringList(value.resources) || !stringList(value.prompts) || !isRecord(value.promptArguments)) continue
        if (!Object.values(value.promptArguments).every((item) => typeof item === 'string')) continue
        drafts[key] = value as WorkbenchDraft
      }
    }
    if (isRecord(root.pendingInputs)) {
      for (const [key, value] of Object.entries(root.pendingInputs)) {
        if (!isRecord(value) || typeof value.sessionId !== 'string' || (value.taskId !== undefined && typeof value.taskId !== 'string') || value.uncertain !== true || !isRecord(value.input)) continue
        if (typeof value.input.requestId !== 'string' || !AGENT_REQUEST_ID_PATTERN.test(value.input.requestId) || typeof value.input.content !== 'string') continue
        pendingInputs[key] = value as PendingWorkbenchInput
      }
    }
    return { drafts, pendingInputs }
  } catch {
    return empty
  }
}

function saveWorkbenchRecovery(drafts: Record<string, WorkbenchDraft>, pendingInputs: Record<string, PendingWorkbenchInput>): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    if (Object.keys(drafts).length === 0 && Object.keys(pendingInputs).length === 0) sessionStorage.removeItem(RECOVERY_KEY)
    else sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ drafts, pendingInputs }))
  } catch {
    // Storage can be disabled or full; server facts remain authoritative.
  }
}

export type AgentWorkbenchState = {
  sessionsStatus: LoadStatus
  sessions: readonly AgentSession[]
  sessionsError?: string
  sessionsRefreshing: boolean
  sessionsCursor: string
  sessionsHasMore: boolean
  loadSessions(gateway: ElysianGateway, options?: ReadOptions & { more?: boolean }): Promise<void>

  selectedSessionId?: string
  sessionDetail?: AgentSession
  sessionStatus: LoadStatus
  sessionError?: string
  selectSession(sessionId: string | undefined): void
  /** 返回是否成功：poll 据此判定连接是否中断（degraded）。 */
  loadSessionDetail(gateway: ElysianGateway, options?: ReadOptions): Promise<boolean>

  tasksStatus: LoadStatus
  tasks: readonly RuntimeTask[]
  tasksError?: string
  tasksCursor: string
  tasksHasMore: boolean
  loadTasks(gateway: ElysianGateway, options?: ReadOptions & { more?: boolean }): Promise<boolean>

  selectedRunId?: string
  selectedRun?: RuntimeRun
  runFactsStatus: LoadStatus
  runFactsError?: string
  operations: readonly AgentOperation[]
  contextItems: readonly AgentContextItem[]
  runCalls: readonly RuntimeCall[]
  runEvents: readonly RuntimeEvent[]
  selectRun(runId: string | undefined): void
  loadRunFacts(gateway: ElysianGateway, options?: ReadOptions): Promise<void>
  drafts: Record<string, WorkbenchDraft>
  setDraft(key: string, draft: WorkbenchDraft): void
  pendingInputs: Record<string, PendingWorkbenchInput>
  setPendingInput(key: string, pending: PendingWorkbenchInput | undefined): void

  selectedTaskId?: string
  taskDetail?: RuntimeTask
  taskStatus: LoadStatus
  taskError?: string
  selectTask(taskId: string | undefined): void
  loadTaskDetail(gateway: ElysianGateway, options?: ReadOptions): Promise<boolean>

  messages: readonly AgentMessage[]
  messagesCursor?: string
  messagesStatus: LoadStatus
  messagesError?: string
  loadMessages(gateway: ElysianGateway, options?: ReadOptions & { incremental?: boolean }): Promise<boolean>

  detailTab: WorkbenchDetailTab
  setDetailTab(tab: WorkbenchDetailTab): void

  workingMemory?: AgentWorkingMemory
  workingMemoryStatus: LoadStatus
  loadWorkingMemory(gateway: ElysianGateway, options?: ReadOptions): Promise<void>

  modelRequests: readonly AgentModelRequestRecord[]
  modelRequestsCursor: string
  modelRequestsHasMore: boolean
  modelRequestsStatus: LoadStatus
  modelRequestsRunId?: string
  loadModelRequests(gateway: ElysianGateway, runId: string, options?: ReadOptions & { more?: boolean }): Promise<void>

  workspaceView?: AgentWorkspaceView
  workspaceStatus: LoadStatus
  workspaceError?: string
  workspaceFile?: AgentWorkspaceView
  workspaceFileStatus: LoadStatus
  workspaceFileError?: string
  loadWorkspace(gateway: ElysianGateway, options?: ReadOptions): Promise<void>
  openWorkspaceFile(gateway: ElysianGateway, path: string): Promise<void>
  closeWorkspaceFile(): void

  createSession(gateway: ElysianGateway, input: AgentCreateSessionInput): Promise<AgentSession>
  switchModel(gateway: ElysianGateway, sessionId: string, input: AgentSwitchModelInput): Promise<AgentSession>
  updateEnvironment(gateway: ElysianGateway, sessionId: string, expectedRevision: number, environment: AgentEnvironment): Promise<AgentEnvironment>
  saveMemorySelection(gateway: ElysianGateway, sessionId: string, selection: AgentMemorySpaceSelection): Promise<AgentMemorySpaceSelection>
  createTask(gateway: ElysianGateway, sessionId: string, input: AgentInput): Promise<RuntimeRun>
  continueRunTask(gateway: ElysianGateway, taskId: string, input: AgentInput): Promise<RuntimeRun>
  cancelRun(gateway: ElysianGateway, runId: string): Promise<RuntimeRun>
  writeWorkspace(gateway: ElysianGateway, taskId: string, path: string, expectedRevision: number, bytes: Uint8Array): Promise<void>
  removeWorkspaceFile(gateway: ElysianGateway, taskId: string, path: string, expectedRevision: number): Promise<void>

  /** 静默轮询：会话详情→（有活动 Run 时）任务详情与任务列表→消息增量；终态落定时补工作记忆。 */
  poll(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  /** 测试复位。 */
  reset(): void
}

function sortMessages(items: readonly AgentMessage[]): readonly AgentMessage[] {
  return [...items].sort((left, right) => compareDecimalCursors(left.seq, right.seq))
}

function mergeMessages(current: readonly AgentMessage[], incoming: readonly AgentMessage[]): readonly AgentMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return sortMessages([...byId.values()])
}

export const useAgentWorkbenchStore = create<AgentWorkbenchState>((set, get) => {
  const recovered = readWorkbenchRecovery()
  let runSequence = 0
  let sessionsSequence = 0
  let sessionSequence = 0
  let tasksSequence = 0
  let taskSequence = 0
  let messagesSequence = 0
  let memorySequence = 0
  let requestsSequence = 0
  let workspaceSequence = 0
  let workspaceFileSequence = 0

  return {
    sessionsStatus: 'idle',
    sessions: [],
    sessionsRefreshing: false,
    sessionsCursor: '',
    sessionsHasMore: false,
    runFactsStatus: 'idle', operations: [], contextItems: [], runCalls: [], runEvents: [], drafts: recovered.drafts, pendingInputs: recovered.pendingInputs,

    sessionStatus: 'idle',

    tasksStatus: 'idle',
    tasks: [],
    tasksCursor: '',
    tasksHasMore: false,

    taskStatus: 'idle',
    messages: [],
    messagesStatus: 'idle',
    detailTab: 'run',
    modelRequests: [],
    modelRequestsCursor: '',
    modelRequestsHasMore: false,
    modelRequestsStatus: 'idle',
    workingMemoryStatus: 'idle',
    workspaceStatus: 'idle',
    workspaceFileStatus: 'idle',

    async loadSessions(gateway, options) {
      const sequence = ++sessionsSequence
      const inPlace = get().sessionsStatus === 'ready'
      if (!options?.silent) {
        set(inPlace
          ? { sessionsRefreshing: true, sessionsError: undefined }
          : { sessionsStatus: 'loading', sessionsError: undefined })
      }
      try {
        const current = get()
        const page = await gateway.agentWorkbench.listSessions(options?.more && current.sessionsCursor ? { cursor: current.sessionsCursor } : undefined, options?.signal)
        if (sequence !== sessionsSequence || options?.signal?.aborted) return
        const merged = new Map((options?.more || options?.silent ? get().sessions : []).map(item => [item.id, item]))
        for (const item of page.items) merged.set(item.id, item)
        set({ sessionsStatus: 'ready', sessions: [...merged.values()], sessionsRefreshing: false, sessionsError: undefined, ...(!options?.silent || get().sessionsCursor === '' ? { sessionsCursor: page.nextCursor, sessionsHasMore: page.hasMore } : {}) })
      } catch (error) {
        if (sequence !== sessionsSequence || options?.signal?.aborted) return
        set({
          sessionsStatus: inPlace ? 'ready' : 'error',
          sessionsRefreshing: false,
          sessionsError: error instanceof Error ? error.message : '读取会话列表失败',
        })
        if (options?.silent && !options.signal?.aborted) throw error
      }
    },

    selectSession(sessionId) {
      if (get().selectedSessionId === sessionId) return
      runSequence += 1
      requestsSequence += 1
      sessionSequence += 1
      tasksSequence += 1
      taskSequence += 1
      messagesSequence += 1
      memorySequence += 1
      workspaceSequence += 1
      workspaceFileSequence += 1
      set({
        selectedSessionId: sessionId,
        sessionDetail: undefined,
        sessionStatus: sessionId === undefined ? 'idle' : 'loading',
        sessionError: undefined,
        tasks: [],
        tasksStatus: sessionId === undefined ? 'idle' : 'loading',
        tasksError: undefined,
        tasksCursor: '',
        tasksHasMore: false,
        selectedRunId: undefined, selectedRun: undefined, runFactsStatus: 'idle', runFactsError: undefined, operations: [], contextItems: [], runCalls: [], runEvents: [],
        selectedTaskId: undefined,
        taskDetail: undefined,
        taskStatus: 'idle',
        taskError: undefined,
        messages: [],
        messagesCursor: undefined,
        messagesStatus: 'idle',
        messagesError: undefined,
        detailTab: 'run',
        workingMemory: undefined,
        workingMemoryStatus: 'idle',
        modelRequests: [],
        modelRequestsCursor: '',
        modelRequestsHasMore: false,
        modelRequestsStatus: 'idle',
        modelRequestsRunId: undefined,
        workspaceView: undefined,
        workspaceStatus: 'idle',
        workspaceError: undefined,
        workspaceFile: undefined,
        workspaceFileStatus: 'idle',
        workspaceFileError: undefined,
      })
    },

    async loadSessionDetail(gateway, options) {
      const sessionId = get().selectedSessionId
      if (sessionId === undefined) return false
      const sequence = ++sessionSequence
      if (!options?.silent && get().sessionDetail === undefined) set({ sessionStatus: 'loading', sessionError: undefined })
      try {
        const session = await gateway.agentWorkbench.getSession(sessionId, options?.signal)
        if (sequence !== sessionSequence || options?.signal?.aborted) return false
        set({ sessionDetail: session, sessionStatus: 'ready', sessionError: undefined, sessions: get().sessions.map(item => item.id === session.id ? session : item) })
        return true
      } catch (error) {
        if (sequence !== sessionSequence || options?.signal?.aborted) return false
        set({
          sessionStatus: get().sessionDetail === undefined ? 'error' : 'ready',
          sessionError: error instanceof Error ? error.message : '读取会话详情失败',
        })
        return false
      }
    },

    async loadTasks(gateway, options) {
      const sessionId = get().selectedSessionId
      if (sessionId === undefined) return false
      const sequence = ++tasksSequence
      const more = options?.more === true
      if (!options?.silent && !more) set({ tasksStatus: 'loading', tasksError: undefined })
      try {
        const cursor = more ? get().tasksCursor : undefined
        const page = await gateway.agentWorkbench.listTasks(sessionId, cursor === undefined || cursor === '' ? undefined : { cursor }, options?.signal)
        if (sequence !== tasksSequence || options?.signal?.aborted) return false
        set({
          tasksStatus: 'ready',
          tasks: more || options?.silent ? [...new Map([...get().tasks, ...page.items].map(item => [item.id, item])).values()] : page.items,
          ...(!options?.silent || get().tasksCursor === '' ? { tasksCursor: page.nextCursor, tasksHasMore: page.hasMore } : {}),
          tasksError: undefined,
        })
        return true
      } catch (error) {
        if (sequence !== tasksSequence || options?.signal?.aborted) return false
        set({
          tasksStatus: get().tasks.length > 0 ? 'ready' : 'error',
          tasksError: error instanceof Error ? error.message : '读取任务列表失败',
        })
        return false
      }
    },

    selectTask(taskId) {
      if (get().selectedTaskId === taskId) return
      runSequence += 1
      taskSequence += 1
      memorySequence += 1
      requestsSequence += 1
      workspaceSequence += 1
      workspaceFileSequence += 1
      set({
        selectedRunId: undefined, selectedRun: undefined, runFactsStatus: 'idle', runFactsError: undefined, operations: [], contextItems: [], runCalls: [], runEvents: [],
        selectedTaskId: taskId,
        taskDetail: undefined,
        taskStatus: taskId === undefined ? 'idle' : 'loading',
        taskError: undefined,
        workingMemory: undefined,
        workingMemoryStatus: 'idle',
        modelRequests: [],
        modelRequestsCursor: '',
        modelRequestsHasMore: false,
        modelRequestsStatus: 'idle',
        modelRequestsRunId: undefined,
        workspaceView: undefined,
        workspaceStatus: 'idle',
        workspaceError: undefined,
        workspaceFile: undefined,
        workspaceFileStatus: 'idle',
        workspaceFileError: undefined,
      })
    },

    async loadTaskDetail(gateway, options) {
      const taskId = get().selectedTaskId
      if (taskId === undefined) return false
      const sequence = ++taskSequence
      if (!options?.silent && get().taskDetail === undefined) set({ taskStatus: 'loading' })
      try {
        const task = await gateway.agentWorkbench.getTask(taskId, options?.signal)
        if (sequence !== taskSequence || options?.signal?.aborted) return false
        set({ taskDetail: task, taskStatus: 'ready', taskError: undefined })
        return true
      } catch (error) {
        if (sequence !== taskSequence || options?.signal?.aborted) return false
        set({
          taskStatus: get().taskDetail === undefined ? 'error' : 'ready',
          taskError: error instanceof Error ? error.message : '读取任务详情失败',
        })
        return false
      }
    },

    async loadMessages(gateway, options) {
      const sessionId = get().selectedSessionId
      if (sessionId === undefined) return false
      const sequence = ++messagesSequence
      const incremental = options?.incremental === true
      const cursor = get().messagesCursor
      if (!options?.silent && !incremental) set({ messagesStatus: 'loading', messagesError: undefined })
      try {
        let after = incremental && cursor !== undefined ? cursor : undefined
        do {
          const page = await gateway.agentWorkbench.listMessages(sessionId, after === undefined ? undefined : { after }, options?.signal)
          if (sequence !== messagesSequence || options?.signal?.aborted) return false
          const nextCursor = page.items.length === 0 ? (after ?? '0') : page.nextCursor
          set({ messages: mergeMessages(incremental || after !== undefined ? get().messages : [], page.items), messagesCursor: nextCursor, messagesStatus: 'ready', messagesError: undefined })
          if (!page.hasMore) break
          if (nextCursor === after || page.items.length === 0) throw new Error('会话消息分页未前进，请刷新后重试')
          after = nextCursor
        } while (!options?.signal?.aborted)
        return true
      } catch (error) {
        if (sequence !== messagesSequence || options?.signal?.aborted) return false
        set({
          messagesStatus: get().messages.length > 0 ? 'ready' : 'error',
          messagesError: error instanceof Error ? error.message : '读取会话消息失败',
        })
        return false
      }
    },

    setDetailTab(tab) {
      set({ detailTab: tab })
    },

    async loadWorkingMemory(gateway, options) {
      const taskId = get().selectedTaskId
      if (taskId === undefined) return
      const sequence = ++memorySequence
      if (!options?.silent) set({ workingMemoryStatus: 'loading' })
      try {
        const memory = await gateway.agentWorkbench.getTaskWorkingMemory(taskId, undefined, options?.signal)
        if (sequence !== memorySequence || options?.signal?.aborted) return
        set({ workingMemory: memory, workingMemoryStatus: 'ready' })
      } catch (error) {
        if (sequence !== memorySequence || options?.signal?.aborted) return
        set({ workingMemoryStatus: get().workingMemory === undefined ? 'error' : 'ready' })
        if (options?.silent) throw error
      }
    },

    async loadModelRequests(gateway, runId, options) {
      const sequence = ++requestsSequence
      const more = options?.more === true
      if (!more && !options?.silent) set({ modelRequestsStatus: 'loading', modelRequestsRunId: runId })
      try {
        const cursor = more ? get().modelRequestsCursor : undefined
        const page = await gateway.agentWorkbench.listModelRequests(runId, cursor === undefined || cursor === '' ? undefined : { cursor }, options?.signal)
        if (sequence !== requestsSequence || options?.signal?.aborted) return
        set({
          modelRequests: more || options?.silent ? [...new Map([...get().modelRequests, ...page.items].map(item => [item.id, item])).values()] : page.items,
          ...(!options?.silent || get().modelRequestsCursor === '' ? { modelRequestsCursor: page.nextCursor, modelRequestsHasMore: page.hasMore } : {}),
          modelRequestsStatus: 'ready',
          modelRequestsRunId: runId,
        })
      } catch (error) {
        if (sequence !== requestsSequence || options?.signal?.aborted) return
        set({ modelRequestsStatus: get().modelRequests.length > 0 ? 'ready' : 'error' })
        if (options?.silent) throw error
      }
    },

    async loadWorkspace(gateway, options) {
      const taskId = get().selectedTaskId
      if (taskId === undefined) return
      const sequence = ++workspaceSequence
      if (!options?.silent) set({ workspaceStatus: 'loading', workspaceError: undefined })
      try {
        const view = await gateway.agentWorkbench.listWorkspace(taskId, options?.signal)
        if (sequence !== workspaceSequence || options?.signal?.aborted) return
        set({ workspaceView: view, workspaceStatus: 'ready', workspaceError: undefined })
      } catch (error) {
        if (sequence !== workspaceSequence || options?.signal?.aborted) return
        set({
          workspaceStatus: get().workspaceView === undefined ? 'error' : 'ready',
          workspaceError: error instanceof Error ? error.message : '读取任务工作区失败',
        })
        if (options?.silent) throw error
      }
    },

    async openWorkspaceFile(gateway, path) {
      const taskId = get().selectedTaskId
      if (taskId === undefined) return
      const sequence = ++workspaceFileSequence
      set({ workspaceFileStatus: 'loading', workspaceFileError: undefined, workspaceFile: undefined })
      try {
        const view = await gateway.agentWorkbench.readWorkspaceFile(taskId, path)
        if (sequence !== workspaceFileSequence) return
        set({ workspaceFile: view, workspaceFileStatus: 'ready', workspaceFileError: undefined })
      } catch (error) {
        if (sequence !== workspaceFileSequence) return
        set({
          workspaceFileStatus: 'error',
          workspaceFileError: error instanceof Error ? error.message : '读取工作区文件失败',
        })
      }
    },

    closeWorkspaceFile() {
      workspaceFileSequence += 1
      set({ workspaceFile: undefined, workspaceFileStatus: 'idle', workspaceFileError: undefined })
    },

    async createSession(gateway, input) {
      const session = await gateway.agentWorkbench.createSession(input)
      set((state) => ({ sessions: [session, ...state.sessions] }))
      return session
    },

    async switchModel(gateway, sessionId, input) {
      const session = await gateway.agentWorkbench.switchModel(sessionId, input)
      set((state) => ({
        sessionDetail: state.selectedSessionId === sessionId ? session : state.sessionDetail,
        sessions: state.sessions.map((item) => (item.id === sessionId ? session : item)),
      }))
      return session
    },

    async updateEnvironment(gateway, sessionId, expectedRevision, environment) {
      const updated = await gateway.agentWorkbench.updateSessionEnvironment(sessionId, expectedRevision, environment)
      await get().loadSessionDetail(gateway, { silent: true })
      return updated
    },

    async saveMemorySelection(gateway, sessionId, selection) {
      const saved = await gateway.agentWorkbench.writeSessionMemorySelection(sessionId, selection)
      return saved
    },

    async createTask(gateway, sessionId, input) {
      const run = await gateway.agentWorkbench.createTask(sessionId, input)
      if (get().selectedSessionId !== sessionId) return run
      get().selectTask(run.taskId)
      await Promise.all([
        get().loadSessionDetail(gateway, { silent: true }),
        get().loadTasks(gateway, { silent: true }),
        get().loadMessages(gateway, { incremental: true, silent: true }),
      ])
      return run
    },

    async continueRunTask(gateway, taskId, input) {
      const run = await gateway.agentWorkbench.continueRun(taskId, input)
      if (get().selectedTaskId !== taskId) return run
      get().selectRun(undefined)
      await Promise.all([
        get().loadSessionDetail(gateway, { silent: true }),
        get().loadTaskDetail(gateway, { silent: true }),
        get().loadTasks(gateway, { silent: true }),
        get().loadMessages(gateway, { incremental: true, silent: true }),
      ])
      return run
    },

    async cancelRun(gateway, runId) {
      // POST /runs/{id}/cancel 的网关接缝在运行记录域；「取消请求已提交」不等于「已停止」。
      const run = await gateway.agentRuns.cancelRun(runId)
      const sessionId = get().selectedSessionId
      await Promise.all([
        sessionId === undefined ? Promise.resolve() : get().loadSessionDetail(gateway, { silent: true }),
        get().loadTaskDetail(gateway, { silent: true }),
      ])
      return run
    },

    async writeWorkspace(gateway, taskId, path, expectedRevision, bytes) {
      await gateway.agentWorkbench.writeWorkspaceFile(taskId, path, expectedRevision, bytes)
      workspaceFileSequence += 1
      set({ workspaceFile: undefined, workspaceFileStatus: 'idle', workspaceFileError: undefined })
      await get().loadWorkspace(gateway, { silent: true })
    },

    async removeWorkspaceFile(gateway, taskId, path, expectedRevision) {
      await gateway.agentWorkbench.deleteWorkspaceFile(taskId, path, expectedRevision)
      workspaceFileSequence += 1
      set({ workspaceFile: undefined, workspaceFileStatus: 'idle', workspaceFileError: undefined })
      await get().loadWorkspace(gateway, { silent: true })
    },

    async poll(gateway, signal) {
      const options = { silent: true, signal }
      const sessionId = get().selectedSessionId
      if (sessionId === undefined) { await get().loadSessions(gateway, options); return }
      const wasActive = get().sessionDetail?.activeRunId !== undefined || get().sessionDetail?.activeWorkflowId !== undefined
      if (!await get().loadSessionDetail(gateway, options)) { if (!signal?.aborted) throw new Error('会话轮询失败'); return }
      if (get().selectedSessionId !== sessionId || signal?.aborted) return
      const results = await Promise.all([get().loadMessages(gateway, { ...options, incremental: true }), get().loadTasks(gateway, options), get().selectedTaskId === undefined ? Promise.resolve(true) : get().loadTaskDetail(gateway, options)])
      if (results.some(result => result === false) && !signal?.aborted) throw new Error('工作台轮询失败')
      if (wasActive && get().sessionDetail?.activeRunId === undefined && get().sessionDetail?.activeWorkflowId === undefined) await get().loadWorkingMemory(gateway, options)
      if (get().runFactsStatus !== 'idle') await get().loadRunFacts(gateway, options)
      if (get().detailTab === 'requests') {
        const runId = get().selectedRunId ?? get().taskDetail?.latestRun?.id
        if (runId) await get().loadModelRequests(gateway, runId, options)
      }
    },

    selectRun(runId) {
      runSequence += 1
      requestsSequence += 1
      set({ selectedRunId: runId, selectedRun: undefined, runFactsStatus: 'idle', runFactsError: undefined, operations: [], contextItems: [], runCalls: [], runEvents: [], modelRequests: [], modelRequestsCursor: '', modelRequestsHasMore: false, modelRequestsRunId: undefined, modelRequestsStatus: 'idle' })
    },
    async loadRunFacts(gateway, options) {
      const runId = get().selectedRunId ?? get().taskDetail?.latestRun?.id
      const taskId = get().selectedTaskId
      if (!runId || !taskId) return
      const sequence = ++runSequence
      if (!options?.silent) set({ runFactsStatus: 'loading', runFactsError: undefined })
      try {
        const [run, operations, contextItems] = await Promise.all([
          gateway.agentRuns.getRun(runId, options?.signal),
          gateway.agentApprovals.listOperations(runId, options?.signal),
          gateway.agentApprovals.listContextItems(runId, options?.signal),
        ])
        if (run.taskId !== taskId) throw new Error('所选运行不属于当前任务')
        const calls: RuntimeCall[] = []
        const events: RuntimeEvent[] = []
        let cursor: string | undefined
        do {
          const page = await gateway.agentRuns.listRunCalls(runId, cursor ? { cursor } : {}, options?.signal)
          calls.push(...page.items)
          if (!page.hasMore) break
          if (!page.nextCursor || page.nextCursor === cursor) throw new Error('调用分页未前进')
          cursor = page.nextCursor
        } while (!options?.signal?.aborted)
        let after = '0'
        do {
          const page = await gateway.agentRuns.listRunEvents(runId, { after }, options?.signal)
          events.push(...page.items)
          if (!page.hasMore) break
          if (compareDecimalCursors(page.nextCursor, after) <= 0) throw new Error('事件分页未前进')
          after = page.nextCursor
        } while (!options?.signal?.aborted)
        if (sequence !== runSequence || options?.signal?.aborted || get().selectedTaskId !== taskId || (get().selectedRunId ?? get().taskDetail?.latestRun?.id) !== runId) return
        set({ selectedRun: run, operations, contextItems, runCalls: calls, runEvents: events, runFactsStatus: 'ready', runFactsError: undefined })
      } catch (error) {
        if (sequence !== runSequence || options?.signal?.aborted) return
        set({ runFactsStatus: get().selectedRun ? 'ready' : 'error', runFactsError: error instanceof Error ? error.message : '读取执行事实失败' })
        if (options?.silent) throw error
      }
    },
    setDraft(key, draft) {
      const drafts = { ...get().drafts, [key]: draft }
      saveWorkbenchRecovery(drafts, get().pendingInputs)
      set({ drafts })
    },
    setPendingInput(key, pending) {
      const pendingInputs = { ...get().pendingInputs }
      if (pending) pendingInputs[key] = pending
      else delete pendingInputs[key]
      saveWorkbenchRecovery(get().drafts, pendingInputs)
      set({ pendingInputs })
    },

    reset() {
      saveWorkbenchRecovery({}, {})
      runSequence += 1
      sessionsSequence += 1
      sessionSequence += 1
      tasksSequence += 1
      taskSequence += 1
      messagesSequence += 1
      memorySequence += 1
      requestsSequence += 1
      workspaceSequence += 1
      workspaceFileSequence += 1
      set({
        sessionsStatus: 'idle',
        sessions: [], sessionsCursor: '', sessionsHasMore: false, drafts: {}, pendingInputs: {},
        sessionsError: undefined,
        sessionsRefreshing: false,
        selectedSessionId: undefined,
        sessionDetail: undefined,
        sessionStatus: 'idle',
        sessionError: undefined,
        tasksStatus: 'idle',
        tasks: [],
        tasksError: undefined,
        tasksCursor: '',
        tasksHasMore: false,
        selectedRunId: undefined, selectedRun: undefined, runFactsStatus: 'idle', runFactsError: undefined, operations: [], contextItems: [], runCalls: [], runEvents: [],
        selectedTaskId: undefined,
        taskDetail: undefined,
        taskStatus: 'idle',
        taskError: undefined,
        messages: [],
        messagesCursor: undefined,
        messagesStatus: 'idle',
        messagesError: undefined,
        detailTab: 'run',
        workingMemory: undefined,
        workingMemoryStatus: 'idle',
        modelRequests: [],
        modelRequestsCursor: '',
        modelRequestsHasMore: false,
        modelRequestsStatus: 'idle',
        modelRequestsRunId: undefined,
        workspaceView: undefined,
        workspaceStatus: 'idle',
        workspaceError: undefined,
        workspaceFile: undefined,
        workspaceFileStatus: 'idle',
        workspaceFileError: undefined,
      })
    },
  }
})


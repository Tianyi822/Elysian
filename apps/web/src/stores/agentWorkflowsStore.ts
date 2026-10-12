import { create } from 'zustand'
import type {
  AgentCreateWorkflowDefinitionInput,
  AgentCreateWorkflowInput,
  AgentWorkflowAttempt,
  AgentWorkflowDefinition,
  AgentWorkflowEvent,
  AgentWorkflowExecutionTree,
  AgentWorkflowInstance,
  AgentWorkflowRecoveryInput,
  AgentWorkflowStatus,
} from '@elysian/contracts'
import { workflowStatusIsTerminal } from '../adapters/agentWorkflowsFixtures'
import { compareDecimalCursors } from '../adapters/http/agent/agentShared'
import type { ElysianGateway } from '../contracts/adapters'

/*
 * 工作流域唯一 store：模板列表/详情、实例列表/详情（含执行树）、尝试与事件分页，
 * 以及创建/取消/恢复动作。读取用闭包 sequence 丢弃过期响应，切换实例即作废在途
 * 读取；静默轮询只刷新数据不置 loading（不白屏、不打断阅读）。事件按 seq 十进制
 * 字符串去重合并（乱序到达安全），游标一律保持字符串；空页保留当前游标。
 * 写方法把结果回写切片并把错误抛给调用方（页面在对话框内行内呈现并通知）。
 */

export type AgentLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 事件保留上限：按 seq 截断最旧的，长跑实例不会把内存读数撑爆。 */
const EVENT_KEEP_LIMIT = 300

type State = {
  definitions: {
    status: AgentLoadStatus
    items: readonly AgentWorkflowDefinition[]
    errorMessage?: string
    reloading: boolean
  }
  definitionDetail: {
    status: AgentLoadStatus
    definition?: AgentWorkflowDefinition
    errorMessage?: string
  }
  instances: {
    status: AgentLoadStatus
    items: readonly AgentWorkflowInstance[]
    nextCursor: string
    hasMore: boolean
    statusFilter?: AgentWorkflowStatus
    errorMessage?: string
    reloading: boolean
  }
  detail: {
    instanceId?: string
    status: AgentLoadStatus
    instance?: AgentWorkflowInstance
    tree?: AgentWorkflowExecutionTree
    errorMessage?: string
    reloading: boolean
  }
  attempts: {
    status: AgentLoadStatus
    items: readonly AgentWorkflowAttempt[]
    nextCursor: string
    hasMore: boolean
    errorMessage?: string
  }
  events: {
    status: AgentLoadStatus
    items: readonly AgentWorkflowEvent[]
    nextCursor: string
    hasMore: boolean
    errorMessage?: string
  }
  loadDefinitions(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadDefinitionDetail(gateway: ElysianGateway, definitionId: string, revision?: number): Promise<void>
  loadInstances(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  setStatusFilter(gateway: ElysianGateway, status: AgentWorkflowStatus | undefined): Promise<void>
  loadMoreInstances(gateway: ElysianGateway): Promise<void>
  selectInstance(gateway: ElysianGateway, instanceId: string): Promise<void>
  clearInstance(): void
  refreshInstance(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  refreshAttempts(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  loadMoreAttempts(gateway: ElysianGateway): Promise<void>
  fetchEventsPage(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  pollEvents(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  createInstance(gateway: ElysianGateway, input: AgentCreateWorkflowInput): Promise<AgentWorkflowInstance>
  cancelInstance(gateway: ElysianGateway, instanceId: string): Promise<AgentWorkflowInstance>
  recoverInstance(gateway: ElysianGateway, instanceId: string, input: AgentWorkflowRecoveryInput): Promise<AgentWorkflowInstance>
  createDefinition(gateway: ElysianGateway, input: AgentCreateWorkflowDefinitionInput): Promise<AgentWorkflowDefinition>
  updateDefinition(
    gateway: ElysianGateway,
    definitionId: string,
    input: { expectedRevision: number } & AgentCreateWorkflowDefinitionInput,
  ): Promise<AgentWorkflowDefinition>
  reset(): void
}

function sortEvents(items: readonly AgentWorkflowEvent[]): AgentWorkflowEvent[] {
  return [...items].sort((a, b) => compareDecimalCursors(a.seq, b.seq))
}

function mergeEvents(existing: readonly AgentWorkflowEvent[], incoming: readonly AgentWorkflowEvent[]): AgentWorkflowEvent[] {
  const bySeq = new Map<string, AgentWorkflowEvent>()
  for (const event of existing) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return sortEvents([...bySeq.values()]).slice(-EVENT_KEEP_LIMIT)
}

function mergeAttempts(existing: readonly AgentWorkflowAttempt[], incoming: readonly AgentWorkflowAttempt[]): AgentWorkflowAttempt[] {
  const byKey = new Map<string, AgentWorkflowAttempt>()
  for (const item of existing) byKey.set(`${item.runId}:${item.number}`, item)
  for (const item of incoming) byKey.set(`${item.runId}:${item.number}`, item)
  return [...byKey.values()]
}

export const useAgentWorkflowsStore = create<State>((set, get) => {
  let definitionsSeq = 0
  let definitionDetailSeq = 0
  let instancesSeq = 0
  let detailSeq = 0
  let attemptsSeq = 0
  let eventsSeq = 0

  const detailActive = (instanceId: string): boolean => get().detail.instanceId === instanceId

  const readInstance = async (gateway: ElysianGateway, instanceId: string, signal?: AbortSignal): Promise<{ instance: AgentWorkflowInstance; tree?: AgentWorkflowExecutionTree }> => {
    const instance = await gateway.agentWorkflows.getInstance(instanceId, signal)
    let tree = instance.executionTree
    if (tree === undefined && instance.languageVersion === 'workflow/v2') {
      tree = await gateway.agentWorkflows.getExecutionTree(instanceId, signal)
    }
    return { instance, tree }
  }

  const applyInstanceToDetail = (instance: AgentWorkflowInstance): void => {
    set((state) => ({
      detail: { ...state.detail, instance, tree: instance.executionTree ?? state.detail.tree },
    }))
  }

  return {
    definitions: { status: 'idle', items: [], reloading: false },
    definitionDetail: { status: 'idle' },
    instances: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined, reloading: false },
    detail: { status: 'idle', reloading: false },
    attempts: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
    events: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },

    async loadDefinitions(gateway, options) {
      const sequence = ++definitionsSeq
      const current = get().definitions
      if (!options?.silent) {
        set({ definitions: { ...current, ...(current.status === 'ready' ? { reloading: true } : { status: 'loading' as const }), errorMessage: undefined } })
      }
      try {
        const items = await gateway.agentWorkflows.listDefinitions()
        if (sequence !== definitionsSeq) return
        set({ definitions: { status: 'ready', items, reloading: false, errorMessage: undefined } })
      } catch (error) {
        if (sequence !== definitionsSeq) return
        const previous = get().definitions
        set({
          definitions: {
            ...previous,
            status: previous.items.length > 0 ? 'ready' : 'error',
            reloading: false,
            errorMessage: error instanceof Error ? error.message : '读取工作流模板失败',
          },
        })
      }
    },

    async loadDefinitionDetail(gateway, definitionId, revision) {
      const sequence = ++definitionDetailSeq
      set({ definitionDetail: { status: 'loading', errorMessage: undefined } })
      try {
        const definition = await gateway.agentWorkflows.getDefinition(definitionId, revision)
        if (sequence !== definitionDetailSeq) return
        set({ definitionDetail: { status: 'ready', definition, errorMessage: undefined } })
      } catch (error) {
        if (sequence !== definitionDetailSeq) return
        set({ definitionDetail: { status: 'error', errorMessage: error instanceof Error ? error.message : '读取工作流模板失败' } })
      }
    },

    async loadInstances(gateway, options) {
      const sequence = ++instancesSeq
      const current = get().instances
      if (!options?.silent) {
        set({ instances: { ...current, ...(current.status === 'ready' ? { reloading: true } : { status: 'loading' as const }), errorMessage: undefined } })
      }
      try {
        const filter = get().instances.statusFilter
        const page = await gateway.agentWorkflows.listInstances({ status: filter }, options?.signal)
        if (sequence !== instancesSeq || options?.signal?.aborted) return
        set({
          instances: { status: 'ready', items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, statusFilter: filter, reloading: false, errorMessage: undefined },
        })
      } catch (error) {
        if (sequence !== instancesSeq || options?.signal?.aborted) return
        const previous = get().instances
        if (options?.silent) throw error
        set({
          instances: {
            ...previous,
            status: previous.items.length > 0 ? 'ready' : 'error',
            reloading: false,
            errorMessage: error instanceof Error ? error.message : '读取工作流实例失败',
          },
        })
      }
    },

    async setStatusFilter(gateway, status) {
      set({ instances: { ...get().instances, statusFilter: status, items: [], nextCursor: '', hasMore: false } })
      await get().loadInstances(gateway)
    },

    async loadMoreInstances(gateway) {
      const current = get().instances
      if (!current.hasMore) return
      const sequence = ++instancesSeq
      try {
        const page = await gateway.agentWorkflows.listInstances({ status: current.statusFilter, cursor: current.nextCursor })
        if (sequence !== instancesSeq) return
        set({
          instances: {
            ...get().instances,
            items: [...current.items, ...page.items],
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            errorMessage: undefined,
          },
        })
      } catch (error) {
        if (sequence !== instancesSeq) return
        set({ instances: { ...get().instances, errorMessage: error instanceof Error ? error.message : '读取工作流实例失败' } })
      }
    },

    async selectInstance(gateway, instanceId) {
      const sequence = ++detailSeq
      const attemptSequence = ++attemptsSeq
      const eventSequence = ++eventsSeq
      set({
        detail: { instanceId, status: 'loading', instance: undefined, tree: undefined, errorMessage: undefined, reloading: false },
        attempts: { status: 'loading', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
        events: { status: 'loading', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
      })
      try {
        const { instance, tree } = await readInstance(gateway, instanceId)
        if (sequence !== detailSeq) return
        set({ detail: { instanceId, status: 'ready', instance, tree, errorMessage: undefined, reloading: false } })
        // 尝试与事件首页与详情并行装载；sequence 不匹配即已被切换作废。
        void gateway.agentWorkflows
          .listAttempts(instanceId)
          .then((page) => {
            if (attemptSequence !== attemptsSeq) return
            set({ attempts: { status: 'ready', items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, errorMessage: undefined } })
          })
          .catch((error: unknown) => {
            if (attemptSequence !== attemptsSeq) return
            set({ attempts: { status: 'error', items: [], nextCursor: '', hasMore: false, errorMessage: error instanceof Error ? error.message : '读取步骤尝试失败' } })
          })
        void gateway.agentWorkflows
          .listInstanceEvents(instanceId)
          .then((page) => {
            if (eventSequence !== eventsSeq) return
            set({ events: { status: 'ready', items: mergeEvents([], page.items), nextCursor: page.nextCursor, hasMore: page.hasMore, errorMessage: undefined } })
          })
          .catch((error: unknown) => {
            if (eventSequence !== eventsSeq) return
            set({ events: { status: 'error', items: [], nextCursor: '', hasMore: false, errorMessage: error instanceof Error ? error.message : '读取工作流事件失败' } })
          })
      } catch (error) {
        if (sequence !== detailSeq) return
        set({ detail: { instanceId, status: 'error', errorMessage: error instanceof Error ? error.message : '读取工作流实例失败', reloading: false } })
      }
    },

    clearInstance() {
      detailSeq += 1
      attemptsSeq += 1
      eventsSeq += 1
      set({
        detail: { status: 'idle', reloading: false },
        attempts: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
        events: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
      })
    },

    async refreshInstance(gateway, options) {
      const instanceId = get().detail.instanceId
      if (instanceId === undefined) return
      const sequence = ++detailSeq
      if (!options?.silent) set({ detail: { ...get().detail, reloading: true, errorMessage: undefined } })
      try {
        const { instance, tree } = await readInstance(gateway, instanceId, options?.signal)
        if (sequence !== detailSeq || options?.signal?.aborted) return
        set({ detail: { instanceId, status: 'ready', instance, tree, errorMessage: undefined, reloading: false } })
        await Promise.all([get().pollEvents(gateway, options?.signal), get().refreshAttempts(gateway, options?.signal)])
      } catch (error) {
        if (sequence !== detailSeq || options?.signal?.aborted) return
        const previous = get().detail
        if (options?.silent && previous.instance !== undefined) {
          // 静默轮询失败：保留旧内容，交由 useSilentPolling 的 degraded 提示。
          set({ detail: { ...previous, reloading: false } })
          throw error
        }
        set({
          detail: {
            ...previous,
            status: previous.instance !== undefined ? 'ready' : 'error',
            errorMessage: error instanceof Error ? error.message : '读取工作流实例失败',
            reloading: false,
          },
        })
      }
    },

    async refreshAttempts(gateway, signal) {
      const instanceId = get().detail.instanceId
      if (instanceId === undefined) return
      const sequence = ++attemptsSeq
      const current = get().attempts
      try {
        const query = current.hasMore && current.nextCursor !== '' ? { cursor: current.nextCursor } : {}
        const page = await gateway.agentWorkflows.listAttempts(instanceId, query, signal)
        if (sequence !== attemptsSeq || !detailActive(instanceId) || signal?.aborted) return
        set({ attempts: {
          status: 'ready', items: mergeAttempts(current.items, page.items),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          errorMessage: undefined,
        } })
      } catch (error) {
        if (sequence !== attemptsSeq || !detailActive(instanceId) || signal?.aborted) return
        set({ attempts: { ...get().attempts, errorMessage: error instanceof Error ? error.message : '读取步骤尝试失败' } })
        throw error
      }
    },

    async loadMoreAttempts(gateway) {
      const instanceId = get().detail.instanceId
      const current = get().attempts
      if (instanceId === undefined || !current.hasMore) return
      const sequence = ++attemptsSeq
      try {
        const page = await gateway.agentWorkflows.listAttempts(instanceId, { cursor: current.nextCursor })
        if (sequence !== attemptsSeq || !detailActive(instanceId)) return
        set({
          attempts: { status: 'ready', items: mergeAttempts(current.items, page.items), nextCursor: page.nextCursor, hasMore: page.hasMore, errorMessage: undefined },
        })
      } catch (error) {
        if (sequence !== attemptsSeq) return
        set({ attempts: { ...get().attempts, errorMessage: error instanceof Error ? error.message : '读取步骤尝试失败' } })
      }
    },

    async fetchEventsPage(gateway, signal) {
      const instanceId = get().detail.instanceId
      if (instanceId === undefined) return
      const sequence = ++eventsSeq
      const current = get().events
      try {
        // 服务端到末页不返回续读游标；下一轮从首页重新扫，按 seq 合并去重。
        const query = current.hasMore && current.nextCursor !== '' ? { cursor: current.nextCursor } : {}
        const page = await gateway.agentWorkflows.listInstanceEvents(instanceId, query, signal)
        if (sequence !== eventsSeq || !detailActive(instanceId) || signal?.aborted) return
        set({
          events: { status: 'ready', items: mergeEvents(current.items, page.items), nextCursor: page.nextCursor, hasMore: page.hasMore, errorMessage: undefined },
        })
      } catch (error) {
        if (sequence !== eventsSeq || signal?.aborted) return
        set({ events: { ...get().events, errorMessage: error instanceof Error ? error.message : '读取工作流事件失败' } })
        throw error
      }
    },

    async pollEvents(gateway, signal) {
      if (signal?.aborted) return
      await get().fetchEventsPage(gateway, signal)
    },

    async createInstance(gateway, input) {
      const instance = await gateway.agentWorkflows.createInstance(input)
      await get().loadInstances(gateway, { silent: get().instances.status === 'ready' })
      return instance
    },

    async cancelInstance(gateway, instanceId) {
      const instance = await gateway.agentWorkflows.cancelInstance(instanceId)
      if (detailActive(instanceId)) applyInstanceToDetail(instance)
      await get().loadInstances(gateway, { silent: get().instances.status === 'ready' })
      return instance
    },

    async recoverInstance(gateway, instanceId, input) {
      const instance = await gateway.agentWorkflows.recoverInstance(instanceId, input)
      if (detailActive(instanceId)) {
        applyInstanceToDetail(instance)
        await get().refreshInstance(gateway, { silent: true })
      }
      await get().loadInstances(gateway, { silent: get().instances.status === 'ready' })
      return instance
    },

    async createDefinition(gateway, input) {
      const definition = await gateway.agentWorkflows.createDefinition(input)
      await get().loadDefinitions(gateway, { silent: get().definitions.status === 'ready' })
      return definition
    },

    async updateDefinition(gateway, definitionId, input) {
      const definition = await gateway.agentWorkflows.updateDefinition(definitionId, input)
      await get().loadDefinitions(gateway, { silent: get().definitions.status === 'ready' })
      return definition
    },

    reset() {
      definitionsSeq += 1
      definitionDetailSeq += 1
      instancesSeq += 1
      detailSeq += 1
      attemptsSeq += 1
      eventsSeq += 1
      set({
        definitions: { status: 'idle', items: [], reloading: false },
        definitionDetail: { status: 'idle' },
        instances: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined, reloading: false },
        detail: { status: 'idle', reloading: false },
        attempts: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
        events: { status: 'idle', items: [], nextCursor: '', hasMore: false, errorMessage: undefined },
      })
    },
  }
})

/** 非终态判定（轮询节奏切换用）：succeeded/failed/cancelled 之外都算进行中。 */
export function selectInstancePolling(instance: AgentWorkflowInstance | undefined): boolean {
  return instance !== undefined && !workflowStatusIsTerminal(instance.status)
}

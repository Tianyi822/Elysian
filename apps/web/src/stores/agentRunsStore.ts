import { create } from 'zustand'
import type {
  RuntimeCall,
  RuntimeEvent,
  RuntimeListQuery,
  RuntimePage,
  RuntimeRun,
  RuntimeRunStatus,
  RuntimeSubmitInput,
} from '@elysian/contracts'
import { runtimeRunIsActive } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { compareDecimalCursors } from '../adapters/http/agent/agentShared'

/*
 * Ely 运行记录域 store：Run 列表（服务端单选过滤 + 游标分页）、Run 详情
 * （状态卡 + 事件流增量 + 调用列表）与旧版 tool-batch 提交/取消的唯一数据出口。
 * 铁律：seq/nextCursor/after 全程十进制字符串；事件按 seq 去重排序（乱序到达
 * 不产生重复或回退）；静默轮询不置 loading（不白屏、不打断阅读）；切换 Run 时
 * 旧请求的过期响应全部丢弃；写动作（提交/取消）不做自动重放。
 */

export type AgentRunsFilters = {
  status?: RuntimeRunStatus
  requestId?: string
  sessionId?: string
  taskId?: string
  workflowId?: string
}

export type AgentRunsListSlice = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: readonly RuntimeRun[]
  nextCursor: string
  hasMore: boolean
  loadingMore: boolean
  hasLoadedMore: boolean
  /** 手动刷新：盖 BusyVeil 并驱动 RefreshButton 旋转；静默轮询不置位。 */
  refreshing: boolean
  errorMessage?: string
  filters: AgentRunsFilters
}

export type AgentRunDetailSlice = {
  runId: string
  status: 'loading' | 'ready' | 'error'
  run?: RuntimeRun
  errorMessage?: string
  /** 手动刷新（BusyVeil）；静默轮询不置位。 */
  refreshing: boolean
  events: readonly RuntimeEvent[]
  /** 下一轮增量的 after 游标；空页保留当前游标。 */
  eventsCursor: string
  eventsHasMore: boolean
  eventsLoadingMore: boolean
  calls: readonly RuntimeCall[]
  callsCursor: string
  callsHasMore: boolean
  callsLoadingMore: boolean
  callsLoadedMore: boolean
  cancelling: boolean
}

export type AgentRunsState = {
  list: AgentRunsListSlice
  detail: AgentRunDetailSlice | undefined
  loadList(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  setFilters(gateway: ElysianGateway, filters: AgentRunsFilters, signal?: AbortSignal): Promise<void>
  loadMore(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  openRun(gateway: ElysianGateway, runId: string, signal?: AbortSignal): Promise<void>
  /** 详情回读：Run + 事件增量 + 调用首页合并；静默轮询与手动刷新共用。 */
  refreshRun(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  loadMoreEvents(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  loadMoreCalls(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  closeRun(): void
  submitBatch(gateway: ElysianGateway, input: RuntimeSubmitInput): Promise<RuntimeRun>
  cancelRun(gateway: ElysianGateway, runId: string): Promise<RuntimeRun>
  reset(): void
}

/** 运行是否已到终态（取消按钮可用性、轮询开关的判定基准）。 */
export function isRunTerminal(run: RuntimeRun | undefined): boolean {
  return run === undefined || !runtimeRunIsActive(run.status)
}

function emptyList(filters: AgentRunsFilters = {}): AgentRunsListSlice {
  return {
    status: 'idle', items: [], nextCursor: '', hasMore: false,
    loadingMore: false, hasLoadedMore: false, refreshing: false, filters,
  }
}

/** 事件合并：按 seq 去重、数值升序；乱序到达与重复投递都不改变最终顺序。 */
export function mergeEvents(current: readonly RuntimeEvent[], incoming: readonly RuntimeEvent[]): readonly RuntimeEvent[] {
  const bySeq = new Map<string, RuntimeEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => compareDecimalCursors(left.seq, right.seq))
}

/** 调用合并：按 id 替换旧条目（状态会从 running 变终态）、按 stepIndex 升序追加新步骤。 */
export function mergeCalls(current: readonly RuntimeCall[], incoming: readonly RuntimeCall[]): readonly RuntimeCall[] {
  const byId = new Map<string, RuntimeCall>()
  for (const call of current) byId.set(call.id, call)
  for (const call of incoming) byId.set(call.id, call)
  return [...byId.values()].sort((left, right) => left.stepIndex - right.stepIndex)
}

function listQueryOf(filters: AgentRunsFilters, cursor?: string, limit?: number): RuntimeListQuery {
  return {
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.requestId === undefined || filters.requestId === '' ? {} : { requestId: filters.requestId }),
    ...(filters.sessionId === undefined || filters.sessionId === '' ? {} : { sessionId: filters.sessionId }),
    ...(filters.taskId === undefined || filters.taskId === '' ? {} : { taskId: filters.taskId }),
    ...(filters.workflowId === undefined || filters.workflowId === '' ? {} : { workflowId: filters.workflowId }),
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function detailError(runId: string, message: string): AgentRunDetailSlice {
  return {
    runId, status: 'error', errorMessage: message, refreshing: false,
    events: [], eventsCursor: '0', eventsHasMore: false, eventsLoadingMore: false,
    calls: [], callsCursor: '0', callsHasMore: false, callsLoadingMore: false, cancelling: false,
    callsLoadedMore: false,
  }
}

function mergeRuns(current: readonly RuntimeRun[], incoming: readonly RuntimeRun[]): readonly RuntimeRun[] {
  const byId = new Map<string, RuntimeRun>()
  for (const run of incoming) byId.set(run.id, run)
  for (const run of current) if (!byId.has(run.id)) byId.set(run.id, run)
  return [...byId.values()]
}

function requestWasAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

export const useAgentRunsStore = create<AgentRunsState>((set, get) => {
  let listSequence = 0
  let listScopeSequence = 0
  let detailSequence = 0
  return {
    list: emptyList(),
    detail: undefined,

    async loadList(gateway, options) {
      const sequence = ++listSequence
      const previous = get().list
      const silent = options?.silent === true
      const signal = options?.signal
      if (!silent) {
        set({
          list: previous.status === 'ready'
            ? { ...previous, refreshing: true, errorMessage: undefined }
            : { ...emptyList(previous.filters), status: 'loading' },
        })
      }
      try {
        const page: RuntimePage<RuntimeRun> = await gateway.agentRuns.listRuns(listQueryOf(previous.filters), signal)
        if (sequence !== listSequence) return
        const current = get().list
        const expanded = current.status === 'ready' && current.hasLoadedMore
        set({ list: {
          ...current,
          status: 'ready', refreshing: false, errorMessage: undefined,
          items: expanded ? mergeRuns(current.items, page.items) : page.items,
          nextCursor: expanded ? current.nextCursor : page.nextCursor,
          hasMore: expanded ? current.hasMore : page.hasMore,
        } })
      } catch (error) {
        if (sequence !== listSequence) return
        if (requestWasAborted(error, signal)) {
          set({ list: { ...get().list, refreshing: false } })
          return
        }
        const current = get().list
        set({
          list: current.status === 'ready'
            ? { ...current, refreshing: false }
            : { ...emptyList(previous.filters), status: 'error', errorMessage: error instanceof Error ? error.message : '读取 Run 列表失败' },
        })
        if (silent) throw error
      }
    },

    async setFilters(gateway, filters, signal) {
      listSequence += 1
      listScopeSequence += 1
      set({ list: { ...emptyList(filters), status: 'loading' } })
      await get().loadList(gateway, { signal })
    },

    async loadMore(gateway, signal) {
      const current = get().list
      if (!current.hasMore || current.loadingMore) return
      const scopeSequence = listScopeSequence
      set({ list: { ...current, loadingMore: true } })
      try {
        const page = await gateway.agentRuns.listRuns(listQueryOf(current.filters, current.nextCursor), signal)
        if (scopeSequence !== listScopeSequence) return
        // Map 按插入序去重：已有条目保持服务端首页顺序，新页条目追加在后。
        const byId = new Map<string, RuntimeRun>()
        const latest = get().list
        for (const run of latest.items) byId.set(run.id, run)
        for (const run of page.items) byId.set(run.id, run)
        set({
          list: {
            ...latest,
            loadingMore: false,
            hasLoadedMore: true,
            items: [...byId.values()],
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          },
        })
      } catch (error) {
        if (scopeSequence !== listScopeSequence) return
        set({ list: { ...get().list, loadingMore: false } })
        throw error instanceof Error ? error : new Error('读取 Run 列表下一页失败')
      }
    },

    async openRun(gateway, runId, signal) {
      detailSequence += 1
      set({
        detail: {
          runId, status: 'loading', refreshing: false,
          events: [], eventsCursor: '0', eventsHasMore: false, eventsLoadingMore: false,
          calls: [], callsCursor: '0', callsHasMore: false, callsLoadingMore: false, cancelling: false,
          callsLoadedMore: false,
        },
      })
      await get().refreshRun(gateway, { signal })
    },

    async refreshRun(gateway, options) {
      const detail = get().detail
      if (detail === undefined) return
      const sequence = detailSequence
      const silent = options?.silent === true
      const signal = options?.signal
      if (!silent && detail.status === 'ready') {
        set({ detail: { ...detail, refreshing: true } })
      }
      try {
        const run = await gateway.agentRuns.getRun(detail.runId, signal)
        if (sequence !== detailSequence) return
        const afterMerge: AgentRunDetailSlice = { ...get().detail!, run, status: 'ready', errorMessage: undefined }
        set({ detail: afterMerge })
        // 事件增量：只有 lastSeq 领先于本地游标才读；空页保留当前游标。
        const current = get().detail!
        if (compareDecimalCursors(run.lastSeq, current.eventsCursor) > 0) {
          const events = await gateway.agentRuns.listRunEvents(detail.runId, { after: current.eventsCursor }, signal)
          if (sequence !== detailSequence) return
          const merged = mergeEvents(current.events, events.items)
          const cursor = events.nextCursor === '' ? current.eventsCursor : events.nextCursor
          set({ detail: { ...get().detail!, events: merged, eventsCursor: compareDecimalCursors(cursor, current.eventsCursor) > 0 ? cursor : current.eventsCursor, eventsHasMore: events.hasMore } })
        }
        // 调用首页回读合并：running 调用的状态迁移只有整页回读才可见。
        const afterCalls = get().detail!
        if (!isRunTerminal(run) || afterCalls.calls.length === 0 || afterCalls.calls.some((call) => call.status === 'queued' || call.status === 'running')) {
          const calls = await gateway.agentRuns.listRunCalls(detail.runId, {}, signal)
          if (sequence !== detailSequence) return
          const latest = get().detail!
          const mergedCalls = mergeCalls(latest.calls, calls.items)
          set({ detail: {
            ...latest,
            calls: mergedCalls,
            callsCursor: latest.callsLoadedMore ? latest.callsCursor : calls.nextCursor,
            callsHasMore: latest.callsLoadedMore ? latest.callsHasMore : calls.hasMore,
          } })
        }
        const final = get().detail
        if (final !== undefined && !silent) set({ detail: { ...final, refreshing: false } })
      } catch (error) {
        if (sequence !== detailSequence) return
        const current = get().detail
        if (current === undefined || current.runId !== detail.runId) return
        if (requestWasAborted(error, signal)) {
          set({ detail: { ...current, refreshing: false } })
          return
        }
        // 静默轮询失败不覆盖已有内容；首次加载失败才进错误态。
        if (!silent && current.status === 'loading') {
          set({ detail: detailError(detail.runId, error instanceof Error ? error.message : '读取 Run 详情失败') })
        } else {
          set({ detail: { ...current, refreshing: false } })
        }
        if (silent || current.status !== 'loading') throw error
      }
    },

    async loadMoreEvents(gateway, signal) {
      const detail = get().detail
      if (detail === undefined || detail.eventsLoadingMore || !detail.eventsHasMore) return
      const sequence = detailSequence
      set({ detail: { ...detail, eventsLoadingMore: true } })
      try {
        const page = await gateway.agentRuns.listRunEvents(detail.runId, { after: detail.eventsCursor }, signal)
        if (sequence !== detailSequence) return
        const current = get().detail!
        set({
          detail: {
            ...current,
            eventsLoadingMore: false,
            events: mergeEvents(current.events, page.items),
            eventsCursor: page.nextCursor === '' ? current.eventsCursor : page.nextCursor,
            eventsHasMore: page.hasMore,
          },
        })
      } catch {
        const current = get().detail
        if (sequence !== detailSequence || current === undefined) return
        set({ detail: { ...current, eventsLoadingMore: false } })
      }
    },

    async loadMoreCalls(gateway, signal) {
      const detail = get().detail
      if (detail === undefined || detail.callsLoadingMore || !detail.callsHasMore) return
      const sequence = detailSequence
      set({ detail: { ...detail, callsLoadingMore: true } })
      try {
        const page = await gateway.agentRuns.listRunCalls(detail.runId, { cursor: detail.callsCursor }, signal)
        if (sequence !== detailSequence) return
        const current = get().detail!
        set({
          detail: {
            ...current,
            callsLoadingMore: false,
            callsLoadedMore: true,
            calls: mergeCalls(current.calls, page.items),
            callsCursor: page.nextCursor === '' ? current.callsCursor : page.nextCursor,
            callsHasMore: page.hasMore,
          },
        })
      } catch {
        const current = get().detail
        if (sequence !== detailSequence || current === undefined) return
        set({ detail: { ...current, callsLoadingMore: false } })
      }
    },

    closeRun() {
      detailSequence += 1
      set({ detail: undefined })
    },

    async submitBatch(gateway, input) {
      const run = await gateway.agentRuns.submitBatch(input)
      return run
    },

    async cancelRun(gateway, runId) {
      const detail = get().detail
      if (detail !== undefined && detail.runId === runId) {
        set({ detail: { ...detail, cancelling: true } })
      }
      try {
        const run = await gateway.agentRuns.cancelRun(runId)
        const current = get().detail
        if (current !== undefined && current.runId === runId) {
          set({ detail: { ...current, run, cancelling: false } })
        }
        return run
      } catch (error) {
        const current = get().detail
        if (current !== undefined && current.runId === runId) {
          set({ detail: { ...current, cancelling: false } })
        }
        throw error
      }
    },

    reset() {
      listSequence += 1
      listScopeSequence += 1
      detailSequence += 1
      set({ list: emptyList(), detail: undefined })
    },
  }
})

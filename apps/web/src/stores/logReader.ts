import { logNumericSortKey } from '@elysian/contracts'
import type { LogListQuery, LogStorageStats } from '@elysian/contracts'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { ElysianGateway } from '../contracts/adapters'

type LogPage<Entry> = {
  entries: readonly Entry[]
  total: number
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  storage?: LogStorageStats
}

type ReadState<Entry> = Omit<LogPage<Entry>, 'storage'> & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string | undefined
  refreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  manualRefreshing?: boolean
  storage?: LogStorageStats | undefined
}

type ReadScope<Entry> = {
  gateway: ElysianGateway
  key: string
  auth: number
  snapshot: readonly Entry[]
}

function sameScope<Entry>(previous: ReadScope<Entry> | undefined, next: ReadScope<Entry>) {
  return previous?.gateway === next.gateway && previous.key === next.key && previous.auth === next.auth && previous.snapshot === next.snapshot
}

/** 三类平台日志共用读取时序；查询、游标字段与写操作由各 store 决定。 */
export function createLogReader<Entry extends { id: string }, Query extends LogListQuery, State extends ReadState<Entry>>({
  get, set, queryFor, read, timeOf, blocked, trackManualRefresh, trackStorage,
}: {
  get: () => State
  set: (patch: Partial<ReadState<Entry>>) => void
  queryFor: (state: State) => Query
  read: (gateway: ElysianGateway, query: Query) => Promise<LogPage<Entry>>
  timeOf: (entry: Entry) => string
  blocked?: (state: State) => boolean
  trackManualRefresh?: boolean
  trackStorage?: boolean
}) {
  let loaded: ReadScope<Entry> | undefined
  let pendingLoad: (ReadScope<Entry> & { promise: Promise<void> }) | undefined
  let pendingOlder: ReadScope<Entry> | undefined

  const makeScope = (gateway: ElysianGateway, query: Query, snapshot: readonly Entry[]): ReadScope<Entry> =>
    ({ gateway, key: JSON.stringify(query), auth: captureAuthGeneration(), snapshot })
  const currentQuery = (scope: ReadScope<Entry>) =>
    scope.auth === captureAuthGeneration() && scope.key === JSON.stringify(queryFor(get()))
  const manualRefresh = (value: boolean) => trackManualRefresh ? { manualRefreshing: value } : {}

  function invalidateReads({ dropSnapshot = false } = {}) {
    pendingLoad = undefined
    pendingOlder = undefined
    if (dropSnapshot) loaded = undefined
    return { refreshing: false, ...manualRefresh(false), loadingOlder: false, olderError: undefined }
  }

  function load(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void> {
    const state = get()
    if (blocked?.(state)) return Promise.resolve()
    const query = queryFor(state)
    const scope = makeScope(gateway, query, state.entries)
    if (pendingLoad && sameScope(pendingLoad, scope)) {
      if (trackManualRefresh && !options?.silent) set({ manualRefreshing: true })
      return pendingLoad.promise
    }
    const first = state.status !== 'ready'
    const operation = { ...scope, promise: Promise.resolve() }
    pendingLoad = operation
    pendingOlder = undefined
    const current = () => pendingLoad === operation && currentQuery(scope)
    const acceptsResult = () => current() && scope.snapshot === get().entries
    set({ refreshing: true, ...manualRefresh(!options?.silent), status: first ? 'loading' : 'ready', errorMessage: undefined, loadingOlder: false, olderError: undefined })
    operation.promise = (async () => {
      try {
        const report = await read(gateway, query)
        if (!acceptsResult()) return
        loaded = { ...scope, snapshot: report.entries }
        set({
          status: 'ready', entries: report.entries, total: report.total, truncated: report.truncated,
          skippedLines: report.skippedLines, skippedFiles: report.skippedFiles,
          ...(trackStorage ? { storage: report.storage } : {}),
        })
      } catch (error) {
        if (acceptsResult()) set({ status: first ? 'error' : 'ready', errorMessage: error instanceof Error ? error.message : '日志读取失败' })
      } finally {
        if (pendingLoad === operation) {
          const ownsBusy = current()
          pendingLoad = undefined
          if (ownsBusy) set({ refreshing: false, ...manualRefresh(false) })
        }
      }
    })()
    return operation.promise
  }

  async function loadOlder(gateway: ElysianGateway): Promise<void> {
    const state = get()
    const { truncated, entries, loadingOlder, refreshing } = state
    if (!truncated || entries.length === 0 || loadingOlder || refreshing || blocked?.(state)) return
    const query = queryFor(state)
    const scope = makeScope(gateway, query, entries)
    // 搜索防抖或刷新失败时可能仍展示上一份快照，不能用它的末行给新查询翻页。
    if (!sameScope(loaded, scope)) return
    const last = entries[entries.length - 1]!
    pendingOlder = scope
    const current = () => pendingOlder === scope && currentQuery(scope)
    const acceptsResult = () => current() && scope.snapshot === get().entries
    set({ loadingOlder: true, olderError: undefined })
    try {
      const report = await read(gateway, { ...query, before: timeOf(last), beforeId: logNumericSortKey(last.id) })
      if (!acceptsResult()) return
      const snapshot = [...entries, ...report.entries]
      loaded = { ...scope, snapshot }
      set({ entries: snapshot, truncated: report.truncated })
    } catch (error) {
      if (acceptsResult()) set({ olderError: error instanceof Error ? error.message : '更早的记录加载失败' })
    } finally {
      if (pendingOlder === scope) {
        const ownsBusy = current()
        pendingOlder = undefined
        if (ownsBusy) set({ loadingOlder: false })
      }
    }
  }

  return { load, loadOlder, invalidateReads }
}

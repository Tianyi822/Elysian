import type { LogClearReport } from '@elysian/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportUnauthorizedStatus } from '../adapters/http/unauthorized'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway } from '../contracts/adapters'
import { useLoginLogStore } from './loginLogStore'
import { useMessageStore, type FeedbackMessage } from './messageStore'
import { useOperationLogStore } from './operationLogStore'
import { useRuntimeLogStore } from './runtimeLogStore'
import { useSessionStore } from './sessionStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const history: FeedbackMessage = { id: 'kept', tone: 'info', message: '已有消息', occurredAt: '2026-10-01T00:00:00Z', read: true }
const stores = [useRuntimeLogStore, useOperationLogStore, useLoginLogStore]

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState(useSessionStore.getInitialState())
  useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState())
  useOperationLogStore.setState(useOperationLogStore.getInitialState())
  useLoginLogStore.setState(useLoginLogStore.getInitialState())
  useMessageStore.setState({ messages: [history] })
})

afterEach(() => { useMessageStore.setState(useMessageStore.getInitialState()) })

describe('日志会话重置', () => {
  it.each(['probe', 'revalidate'] as const)('%s 确认失效前保留列表，确认失效后只重置会话内数据', async (check) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const status = vi.spyOn(gateway.session, 'status')
      .mockResolvedValueOnce({ mode: 'real', authenticated: true, devAccount: false })
      .mockRejectedValueOnce(new Error('网络暂时离线'))
      .mockResolvedValueOnce({ mode: 'real', authenticated: false, devAccount: false })
    const session = useSessionStore.getState()
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    await Promise.all(stores.map(store => store.getState().load(gateway)))
    const snapshots = stores.map(store => store.getState().entries)
    expect(snapshots.every(entries => entries.length > 0)).toBe(true)
    for (const store of stores) store.getState().setSearch('仅本会话的关键词')
    useOperationLogStore.getState().setCategoryFilter('security')
    useOperationLogStore.getState().setResultFilter('failure')
    useLoginLogStore.getState().setStatusFilter('success')
    useRuntimeLogStore.getState().openClear('runtime')

    await session.probe(gateway)
    await session.revalidate(gateway)
    stores.forEach((store, i) => expect(store.getState().entries).toBe(snapshots[i]))
    await session[check](gateway)

    expect(useSessionStore.getState().phase).toBe('anonymous')
    for (const store of stores) {
      expect(store.getState()).toMatchObject({
        status: 'idle', entries: [], search: '', total: 0, truncated: false, skippedFiles: 0, skippedLines: 0,
        refreshing: false, loadingOlder: false, errorMessage: undefined, olderError: undefined,
      })
    }
    expect(useRuntimeLogStore.getState()).toMatchObject({ storage: undefined, manualRefreshing: false, clearTarget: null, clearing: false })
    expect(useOperationLogStore.getState()).toMatchObject({ storage: undefined, categoryFilter: 'security', resultFilter: 'failure' })
    expect(useLoginLogStore.getState().statusFilter).toBe('success')
    expect(useMessageStore.getState().messages).toEqual([history])
    expect(status).toHaveBeenCalledTimes(3)
  })

  it('演示会话收到同源 HTTP 的 401 时保留演示日志', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().mode).toBe('demo')
    await Promise.all(stores.map(store => store.getState().load(gateway)))
    const snapshots = stores.map(store => store.getState().entries)

    reportUnauthorizedStatus(401)

    stores.forEach((store, i) => {
      expect(store.getState().status).toBe('ready')
      expect(store.getState().entries).toBe(snapshots[i])
    })
  })
})

describe.each([
  { category: 'runtime' as const, store: useRuntimeLogStore },
  { category: 'operation' as const, store: useOperationLogStore },
])('$category 的清空回执', ({ category, store }) => {
  it.each(['成功', '失败'] as const)('旧会话迟到%s不影响新会话的清空', async outcome => {
    const oldClear = deferred<LogClearReport>()
    const newClear = deferred<LogClearReport>()
    const clearLogs = vi.fn<ElysianGateway['logs']['clearLogs']>()
      .mockReturnValueOnce(oldClear.promise).mockReturnValueOnce(newClear.promise)
    const base = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(base.session, 'login').mockResolvedValue(undefined)
    vi.spyOn(base.session, 'logout').mockResolvedValue(undefined)
    const runtimeLog = vi.fn(base.logs.runtimeLog.bind(base.logs))
    const operationLogs = vi.fn(base.logs.operationLogs.bind(base.logs))
    const gateway = {
      ...base,
      logs: { runtimeLog, operationLogs, loginLogs: base.logs.loginLogs.bind(base.logs), clearLogs },
    } satisfies ElysianGateway
    useSessionStore.setState({ mode: 'real', phase: 'authed' })
    await store.getState().load(gateway)
    store.getState().openClear(category)
    const clearingOld = store.getState().clear(gateway)

    await useSessionStore.getState().logout(gateway)
    await useSessionStore.getState().login(gateway, 'admin', 'example')
    await store.getState().load(gateway)
    store.getState().openClear(category)
    const clearingNew = store.getState().clear(gateway)
    const newSnapshot = store.getState().entries
    const read = category === 'runtime' ? runtimeLog : operationLogs
    const readCount = read.mock.calls.length

    const report = { category, rowCount: 4, totalBytes: 100, oldestAt: null, clearedAt: '2026-10-01T00:00:00Z' }
    if (outcome === '成功') oldClear.resolve(report)
    else oldClear.reject(new Error('旧会话清空失败'))
    await clearingOld

    expect(useMessageStore.getState().messages).toEqual([history])
    expect(store.getState()).toMatchObject({ clearTarget: category, clearing: true })
    expect(store.getState().entries).toBe(newSnapshot)
    expect(read).toHaveBeenCalledTimes(readCount)
    expect(clearLogs).toHaveBeenCalledTimes(2)

    newClear.resolve(report)
    await clearingNew
    expect(store.getState()).toMatchObject({ clearTarget: null, clearing: false })
    expect(read).toHaveBeenCalledTimes(readCount + 1)
    expect(useMessageStore.getState().messages).toHaveLength(2)
  })
})

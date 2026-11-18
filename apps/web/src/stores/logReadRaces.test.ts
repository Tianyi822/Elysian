import type { LogClearReport, LogListQuery, PlatformLogCategory } from '@elysian/contracts'
import { describe, expect, it, vi } from 'vitest'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway } from '../contracts/adapters'
import { useLoginLogStore } from './loginLogStore'
import { useOperationLogStore } from './operationLogStore'
import { useRuntimeLogStore } from './runtimeLogStore'
import { useSessionStore } from './sessionStore'

type LogReads = {
  entries: readonly { id: string }[]
  refreshing: boolean
  loadingOlder: boolean
  olderError: string | undefined
  errorMessage: string | undefined
  load(gateway: ElysianGateway): Promise<void>
  loadOlder(gateway: ElysianGateway): Promise<void>
  setSearch(search: string): void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function logReadSuite<R extends { entries: readonly { id: string }[]; truncated: boolean }>(
  title: string,
  state: () => LogReads,
  reset: () => void,
  getReport: (gateway: ElysianGateway) => Promise<R>,
  replaceRead: (gateway: ElysianGateway, read: (query?: LogListQuery) => Promise<R>) => void,
  clear?: {
    category: PlatformLogCategory
    state: () => { openClear(category: PlatformLogCategory): void; clear(gateway: ElysianGateway): Promise<void> }
  },
) {
  async function fixture() {
    reset()
    const gateway = createMockGateway({ eventStream: 'memory' })
    const report = await getReport(gateway)
    const page = (index: number): R => ({ ...report, entries: report.entries.slice(index, index + 1), truncated: true })
    expect(page(2).entries).toHaveLength(1)
    const read = vi.fn<(query?: LogListQuery) => Promise<R>>(() => Promise.resolve(page(0)))
    replaceRead(gateway, read)
    return { gateway, read, page }
  }

  describe(`${title}读取竞态`, () => {
    it('搜索变化在防抖发出新查询前就拒绝旧页，不拿旧游标查新词', async () => {
      const { gateway, page, read } = await fixture()
      await state().load(gateway)
      const old = deferred<R>()
      read.mockReturnValueOnce(old.promise)
      const loading = state().loadOlder(gateway)
      state().setSearch('下一组')
      old.resolve(page(1))
      await loading
      expect(state().entries).toEqual(page(0).entries)
      expect(state().loadingOlder).toBe(false)
      await state().loadOlder(gateway)
      expect(read).toHaveBeenCalledTimes(2)
      read.mockImplementationOnce(async () => page(2))
      await state().load(gateway)
      expect(read).toHaveBeenLastCalledWith({ q: '下一组' })
      expect(state().entries).toEqual(page(2).entries)
    })

    it('新刷新取代旧页，旧失败不能写提示或清除新页的忙碌状态', async () => {
      const { gateway, page, read } = await fixture()
      await state().load(gateway)
      const old = deferred<R>(), next = deferred<R>()
      read.mockReturnValueOnce(old.promise).mockImplementationOnce(async () => page(1)).mockReturnValueOnce(next.promise)
      const oldLoading = state().loadOlder(gateway)
      await state().load(gateway)
      const nextLoading = state().loadOlder(gateway)
      old.reject(new Error('旧页失败'))
      await oldLoading
      expect(state().olderError).toBeUndefined()
      expect(state().loadingOlder).toBe(true)
      next.resolve(page(2))
      await nextLoading
      expect(state().entries).toEqual([...page(1).entries, ...page(2).entries])
      expect(state().loadingOlder).toBe(false)
    })

    it('规范化查询未变时首载继续去重，实际变化立即拒绝旧首载', async () => {
      const { gateway, page, read } = await fixture()
      state().setSearch('旧词')
      const old = deferred<R>()
      read.mockReturnValueOnce(old.promise)
      const first = state().load(gateway)
      state().setSearch(' 旧词 ')
      expect(state().load(gateway)).toBe(first)
      state().setSearch('新词')
      old.resolve(page(1))
      await first
      expect(state().entries).toEqual([])
      expect(state().refreshing).toBe(false)
    })

    it('其他 Gateway 和新登录代次都不能使用旧快照继续分页', async () => {
      const { gateway, page, read } = await fixture()
      await state().load(gateway)
      await state().loadOlder({ ...gateway })
      expect(read).toHaveBeenCalledTimes(1)

      const old = deferred<R>()
      read.mockReturnValueOnce(old.promise)
      const loading = state().loadOlder(gateway)
      advanceAuthGeneration()
      read.mockImplementationOnce(async () => page(2))
      await state().load(gateway)
      old.resolve(page(1))
      await loading
      expect(state().entries).toEqual(page(2).entries)
      expect(state().loadingOlder).toBe(false)

      advanceAuthGeneration()
      await state().loadOlder(gateway)
      expect(read).toHaveBeenCalledTimes(3)
    })

    it.each(['首载成功', '分页失败'] as const)('旧会话迟到的%s不改变新会话首载', async (outcome) => {
      const { gateway, page, read } = await fixture()
      const session = useSessionStore.getState()
      useSessionStore.setState({ phase: 'authed', mode: 'real' })
      if (outcome === '分页失败') await state().load(gateway)
      const old = deferred<R>(), next = deferred<R>()
      read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
      const loadingOld = outcome === '首载成功' ? state().load(gateway) : state().loadOlder(gateway)
      expect(state().refreshing || state().loadingOlder).toBe(true)

      session.expire()
      await session.login(gateway, 'admin', 'example')
      const loadingNew = state().load(gateway)
      if (outcome === '首载成功') old.resolve(page(1))
      else old.reject(new Error('旧会话分页失败'))
      await loadingOld

      expect(state()).toMatchObject({ entries: [], refreshing: true, loadingOlder: false, olderError: undefined, errorMessage: undefined })
      next.resolve(page(2))
      await loadingNew
      expect(state()).toMatchObject({ entries: page(2).entries, refreshing: false })
    })

    if (clear) it('清空开始即废弃在途分页，成功后读取新的首屏', async () => {
      const { gateway, page, read } = await fixture()
      await state().load(gateway)
      const old = deferred<R>(), deletion = deferred<LogClearReport>()
      read.mockReturnValueOnce(old.promise)
      vi.spyOn(gateway.logs, 'clearLogs').mockReturnValueOnce(deletion.promise)
      const loading = state().loadOlder(gateway)
      clear.state().openClear(clear.category)
      const clearing = clear.state().clear(gateway)
      old.resolve(page(1))
      await loading
      expect(state().entries).toEqual(page(0).entries)
      expect(state().loadingOlder).toBe(false)
      await state().loadOlder(gateway)
      expect(read).toHaveBeenCalledTimes(2)
      read.mockImplementationOnce(async () => page(2))
      deletion.resolve({ category: clear.category, oldestAt: null, rowCount: 0, totalBytes: 0, clearedAt: '2026-11-18T00:00:00Z' })
      await clearing
      expect(read).toHaveBeenLastCalledWith({})
      expect(state().entries).toEqual(page(2).entries)
    })
  })
}

logReadSuite('运行日志', useRuntimeLogStore.getState,
  () => useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState()),
  gateway => gateway.logs.runtimeLog(), (gateway, read) => { gateway.logs.runtimeLog = read },
  { category: 'runtime', state: useRuntimeLogStore.getState })
logReadSuite('操作日志', useOperationLogStore.getState,
  () => useOperationLogStore.setState(useOperationLogStore.getInitialState()),
  gateway => gateway.logs.operationLogs(), (gateway, read) => { gateway.logs.operationLogs = read },
  { category: 'operation', state: useOperationLogStore.getState })
logReadSuite('登录日志', useLoginLogStore.getState,
  () => useLoginLogStore.setState(useLoginLogStore.getInitialState()),
  gateway => gateway.logs.loginLogs(), (gateway, read) => { gateway.logs.loginLogs = read })

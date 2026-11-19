import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseContainerInstance, DatabaseInstance } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import type { DatabaseCreateInput, DatabaseCreateResult } from '../contracts/adapters'
import { useDatabaseStore } from './databaseStore'
import { useMessageStore } from './messageStore'
import { useSessionStore } from './sessionStore'

const file: DatabaseInstance = { id: 'sqlite-notes', engine: 'SQLite', name: 'notes', status: 'running', version: '3.46.1', updatedAt: '2026-11-18T00:00:00Z' }
const container: DatabaseContainerInstance = {
  id: 'mysql-1', containerId: 'mysql-1', name: 'mysql', engine: 'MySQL', version: '8.4', status: 'running',
  image: 'mysql:8.4', versionTag: '8.4', ports: [], networks: [], credentialsVerified: false,
  needsAttention: false, updatedAt: file.updatedAt,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  useDatabaseStore.setState({ ...useDatabaseStore.getInitialState(), status: 'ready', sqliteStatus: 'ready' }, true)
  await useMessageStore.getState().clear()
})

describe('数据库反馈', () => {
  it('持续的轮询错误仅通知一次，恢复后再次失败可以重新通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const list = vi.spyOn(gateway.databases, 'list').mockRejectedValue(new Error('引擎连接中断'))
    vi.spyOn(gateway.databases, 'listSqlite').mockResolvedValue([])
    await useDatabaseStore.getState().load(gateway, { silent: true })
    await useDatabaseStore.getState().load(gateway, { silent: true })
    expect(useMessageStore.getState().messages).toHaveLength(1)
    list.mockResolvedValueOnce([])
    await useDatabaseStore.getState().load(gateway, { silent: true })
    await useDatabaseStore.getState().load(gateway, { silent: true })
    expect(useMessageStore.getState().messages).toHaveLength(2)
  })

  it('SQLite 列表失败时保留独立的容器读取结果', async () => {
    useDatabaseStore.setState({ status: 'idle', sqliteStatus: 'idle' })
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.databases, 'list').mockResolvedValue([])
    vi.spyOn(gateway.databases, 'listSqlite').mockRejectedValue(new Error('文件服务不可用'))
    await useDatabaseStore.getState().load(gateway, { silent: true })
    expect(useDatabaseStore.getState()).toMatchObject({ status: 'ready', databases: [], sqliteStatus: 'error', sqliteErrorMessage: '文件服务不可用' })
  })

  it('删除必须发起新的读取，写入前的迟到响应不会恢复已删除的行', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    useDatabaseStore.setState({ sqliteFiles: [file] })
    let finishOldRead!: (rows: readonly DatabaseInstance[]) => void
    const oldRead = new Promise<readonly DatabaseInstance[]>((resolve) => { finishOldRead = resolve })
    const listSqlite = vi.spyOn(gateway.databases, 'listSqlite').mockReturnValueOnce(oldRead).mockResolvedValue([])
    vi.spyOn(gateway.databases, 'list').mockResolvedValue([])
    vi.spyOn(gateway.databases, 'removeSqlite').mockResolvedValue(undefined)
    const poll = useDatabaseStore.getState().load(gateway, { silent: true })
    const removal = useDatabaseStore.getState().removeSqliteFile(gateway, file.id)
    await vi.waitFor(() => expect(listSqlite).toHaveBeenCalledTimes(2))
    await removal
    expect(useDatabaseStore.getState().sqliteFiles).toEqual([])
    finishOldRead([file])
    await poll
    expect(useDatabaseStore.getState().sqliteFiles).toEqual([])
  })
})

describe('数据库会话边界', () => {
  beforeEach(() => useSessionStore.setState({ phase: 'authed', mode: 'real', username: 'admin' }))

  it('会话失效立即清空数据库快照和弹窗，保留选中的引擎', () => {
    useDatabaseStore.setState({ engine: 'MySQL', databases: [container], sqliteFiles: [file], createOpen: true, createError: '上传失败' })

    useSessionStore.getState().expire()

    expect(useDatabaseStore.getState()).toMatchObject({
      engine: 'MySQL', databases: [], sqliteFiles: [], status: 'idle', sqliteStatus: 'idle', createOpen: false, createError: undefined,
    })
  })

  it.each(['成功', '失败'] as const)('旧上传%s不污染重新登录后的新上传', async (result) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const old = deferred<DatabaseCreateResult>()
    const next = deferred<DatabaseCreateResult>()
    const create = vi.spyOn(gateway.databases, 'create').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const list = vi.spyOn(gateway.databases, 'listSqlite').mockResolvedValue([])
    const input: DatabaseCreateInput = { kind: 'file', engine: 'SQLite', name: file.name, origin: 'uploaded', file: new File([], 'notes.db') }
    const store = useDatabaseStore.getState()
    const session = useSessionStore.getState()
    store.openCreate('file')
    const first = store.createDatabase(gateway, input)
    await session.logout(gateway)
    await session.login(gateway, 'admin', 'password')
    store.openCreate('file')
    const second = store.createDatabase(gateway, input)
    create.mock.calls[1]![1]?.(25)

    create.mock.calls[0]![1]?.(90)
    if (result === '成功') old.resolve({ instance: file, firewallPort: null })
    else old.reject(new Error('旧上传失败'))
    await first

    const current = useDatabaseStore.getState()
    const notifications = useMessageStore.getState().messages.slice()
    const refreshes = list.mock.calls.length
    next.resolve({ instance: file, firewallPort: null })
    await second

    expect(current).toMatchObject({ createOpen: true, creating: true, uploadPercent: 25, createError: undefined, sqliteFiles: [] })
    expect(notifications).toEqual([])
    expect(refreshes).toBe(0)
  })

  it.each([
    { label: '数据库容器', action: 'removeContainer', adapter: 'removeContainer', busy: 'removingContainerIds', id: container.id },
    { label: 'SQLite 文件', action: 'removeSqliteFile', adapter: 'removeSqlite', busy: 'removingSqliteIds', id: file.id },
  ] as const)('旧 $label 删除回执不刷新列表或释放新会话的同行操作', async ({ action, adapter, busy, id }) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const old = deferred<void>()
    const next = deferred<void>()
    vi.spyOn(gateway.databases, adapter).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const list = vi.spyOn(gateway.databases, 'list').mockResolvedValue([container])
    const listSqlite = vi.spyOn(gateway.databases, 'listSqlite').mockResolvedValue([file])
    const store = useDatabaseStore.getState()
    const session = useSessionStore.getState()
    await store.load(gateway)
    const first = store[action](gateway, id)
    await session.logout(gateway)
    await session.login(gateway, 'admin', 'password')
    await store.load(gateway)
    const second = store[action](gateway, id)
    list.mockClear()
    listSqlite.mockClear()
    old.resolve(undefined)
    await first

    const removing = useDatabaseStore.getState()[busy]
    const notifications = useMessageStore.getState().messages.slice()
    const reads = list.mock.calls.length + listSqlite.mock.calls.length
    next.resolve(undefined)
    await second

    expect(removing).toEqual([id])
    expect(notifications).toEqual([])
    expect(reads).toBe(0)
    expect(useDatabaseStore.getState()[busy]).toEqual([])
  })
})

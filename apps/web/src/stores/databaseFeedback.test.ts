import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { useDatabaseStore } from './databaseStore'
import { useMessageStore } from './messageStore'

const file: DatabaseInstance = { id: 'sqlite-notes', engine: 'SQLite', name: 'notes', status: 'running', version: '3.46.1', updatedAt: '2026-11-18T00:00:00Z' }

beforeEach(async () => {
  useDatabaseStore.setState({ ...useDatabaseStore.getInitialState(), status: 'ready', sqliteStatus: 'ready' }, true)
  await useMessageStore.getState().clear()
})

describe('数据库反馈', () => {
  it('持续的轮询错误仅通知一次，恢复后再次失败可以重新通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const list = vi.spyOn(gateway.databases, 'list').mockRejectedValue(new Error('引擎连接中断'))
    vi.spyOn(gateway.databases, 'listSqlite').mockResolvedValue([])
    await useDatabaseStore.getState().refresh(gateway)
    await useDatabaseStore.getState().refresh(gateway)
    expect(useMessageStore.getState().messages).toHaveLength(1)
    list.mockResolvedValueOnce([])
    await useDatabaseStore.getState().refresh(gateway)
    await useDatabaseStore.getState().refresh(gateway)
    expect(useMessageStore.getState().messages).toHaveLength(2)
  })

  it('SQLite 列表失败时保留独立的容器读取结果', async () => {
    useDatabaseStore.setState({ status: 'idle', sqliteStatus: 'idle' })
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.databases, 'list').mockResolvedValue([])
    vi.spyOn(gateway.databases, 'listSqlite').mockRejectedValue(new Error('文件服务不可用'))
    await useDatabaseStore.getState().refresh(gateway)
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
    const poll = useDatabaseStore.getState().refresh(gateway)
    const removal = useDatabaseStore.getState().removeSqliteFile(gateway, file.id)
    await vi.waitFor(() => expect(listSqlite).toHaveBeenCalledTimes(2))
    await removal
    expect(useDatabaseStore.getState().sqliteFiles).toEqual([])
    finishOldRead([file])
    await poll
    expect(useDatabaseStore.getState().sqliteFiles).toEqual([])
  })
})

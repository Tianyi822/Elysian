import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { createMockGateway } from '../adapters/mock/gateway'
import { useDatabaseStore } from './databaseStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const connection = () => ({ execute: vi.fn(async (_statement: string): Promise<readonly string[]> => ['ok']), close: vi.fn() })
beforeEach(() => useDatabaseStore.getState().closeSession())
afterEach(() => useDatabaseStore.getState().closeSession())

describe('数据库终端连接代次', () => {
  it('连接期间不允许提交，连接完成后仅通过原有受限协议发送完整语句', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const waiting = deferred<ReturnType<typeof connection>>()
    gateway.databases.openTerminal = () => waiting.promise
    useDatabaseStore.getState().openSession('db-1', gateway)
    await expect(useDatabaseStore.getState().submitStatement(gateway, 'SELECT 1')).rejects.toThrow('数据库连接尚未建立')
    const live = connection()
    waiting.resolve(live)
    await waitFor(() => expect(useDatabaseStore.getState().session?.status).toBe('connected'))
    await expect(useDatabaseStore.getState().submitStatement(gateway, ' SELECT 1; ')).resolves.toEqual(['ok'])
    expect(live.execute).toHaveBeenCalledExactlyOnceWith(' SELECT 1; ')
    expect(useDatabaseStore.getState().session).not.toHaveProperty('history')
    expect(useDatabaseStore.getState().session).not.toHaveProperty('lines')
  })

  it('关闭并重开同一数据库时，旧连接不能覆盖新连接', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const old = deferred<ReturnType<typeof connection>>()
    const newer = connection()
    gateway.databases.openTerminal = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(newer)
    useDatabaseStore.getState().openSession('same', gateway)
    const first = useDatabaseStore.getState().session!.id
    useDatabaseStore.getState().closeSession()
    useDatabaseStore.getState().openSession('same', gateway)
    await waitFor(() => expect(useDatabaseStore.getState().session?.status).toBe('connected'))
    const stale = connection()
    old.resolve(stale)
    await waitFor(() => expect(stale.close).toHaveBeenCalledOnce())
    expect(useDatabaseStore.getState().session!.id).not.toBe(first)
    await useDatabaseStore.getState().submitStatement(gateway, 'SELECT 2')
    expect(newer.execute).toHaveBeenCalledWith('SELECT 2')
    expect(stale.execute).not.toHaveBeenCalled()
  })

  it('Ctrl+C 重连后，旧执行成功或失败均不污染新会话', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const old = connection()
    const newer = connection()
    const query = deferred<readonly string[]>()
    old.execute.mockReturnValue(query.promise)
    gateway.databases.openTerminal = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(newer)
    useDatabaseStore.getState().openSession('db-1', gateway)
    await waitFor(() => expect(useDatabaseStore.getState().session?.status).toBe('connected'))
    const pending = useDatabaseStore.getState().submitStatement(gateway, 'slow')
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await useDatabaseStore.getState().interruptSession(gateway)
    expect(old.close).toHaveBeenCalledOnce()
    query.resolve(['stale result'])
    await result
    await expect(useDatabaseStore.getState().submitStatement(gateway, 'SELECT 2')).resolves.toEqual(['ok'])
    expect(newer.execute).toHaveBeenCalledWith('SELECT 2')
  })

  it('关闭期间迟到的重连也会立即关闭', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const live = connection()
    const reconnect = deferred<ReturnType<typeof connection>>()
    gateway.databases.openTerminal = vi.fn().mockResolvedValueOnce(live).mockReturnValueOnce(reconnect.promise)
    useDatabaseStore.getState().openSession('db-1', gateway)
    await waitFor(() => expect(useDatabaseStore.getState().session?.status).toBe('connected'))
    const pending = useDatabaseStore.getState().interruptSession(gateway)
    useDatabaseStore.getState().closeSession()
    const late = connection()
    reconnect.resolve(late)
    await pending
    expect(late.close).toHaveBeenCalledOnce()
    expect(useDatabaseStore.getState().session).toBeUndefined()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { createMockGateway } from '../adapters/mock/gateway'
import { useDatabaseStore } from './databaseStore'
import { useNotificationStore } from './notificationStore'

beforeEach(() => {
  useDatabaseStore.getState().closeSession()
  useDatabaseStore.setState({ status: 'ready', databases: [], containers: [], images: [], errorMessage: undefined, refreshing: false })
  useNotificationStore.getState().clear()
})

describe('数据库反馈', () => {
  it('持续的轮询错误仅通知一次，恢复后再次失败可以重新通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const list = vi.spyOn(gateway.databases, 'list').mockRejectedValue(new Error('引擎连接中断'))
    await useDatabaseStore.getState().refresh(gateway)
    await useDatabaseStore.getState().refresh(gateway)
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    list.mockResolvedValueOnce([])
    await useDatabaseStore.getState().refresh(gateway)
    await useDatabaseStore.getState().refresh(gateway)
    expect(useNotificationStore.getState().notifications).toHaveLength(2)
  })

  it('已关闭会话的迟到连接错误不污染新会话或弹通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    let rejectConnection: (error: Error) => void = () => {}
    gateway.databases.openTerminal = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectConnection = reject }))
    useDatabaseStore.getState().openSession('old', gateway)
    useDatabaseStore.getState().closeSession()
    useDatabaseStore.getState().openSession('new')
    rejectConnection(new Error('旧连接失败'))
    await waitFor(() => expect(gateway.databases.openTerminal).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(useDatabaseStore.getState().session?.lines).toEqual([])
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })
})

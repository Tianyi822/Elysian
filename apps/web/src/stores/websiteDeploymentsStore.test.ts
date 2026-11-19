import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { useMessageStore } from './messageStore'
import { useSessionStore } from './sessionStore'
import { useWebsiteDeploymentsStore } from './websiteDeploymentsStore'

const task: WebsiteDeploymentTask = {
  id: 'deploy-1', sourceId: 'source-1', name: '演示站点', state: 'building', stage: '构建中',
  createdAt: '2026-10-04T07:30:00Z', updatedAt: '2026-10-04T07:30:00Z',
  config: { candidateId: 'candidate-1', target: 'static', command: '', skipTests: false },
  testResult: 'pending',
}

beforeEach(async () => {
  await useMessageStore.getState().clear()
  useWebsiteDeploymentsStore.getState().clearDisplay()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

describe('部署任务登录会话边界', () => {
  beforeEach(() => useSessionStore.setState({ phase: 'authed', mode: 'real', username: 'admin' }))

  it.each(['成功', '失败'] as const)('旧任务清单%s不读取详情或结束新会话的刷新', async (outcome) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const api = gateway.websites.deployment!
    const old = deferred<readonly WebsiteDeploymentTask[]>()
    const next = deferred<readonly WebsiteDeploymentTask[]>()
    const list = vi.spyOn(api, 'list').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const readTask = vi.spyOn(api, 'task').mockResolvedValue(task)
    const store = useWebsiteDeploymentsStore.getState()
    const session = useSessionStore.getState()
    store.put(task)
    const first = store.refresh(gateway)
    session.expire()
    const cleared = useWebsiteDeploymentsStore.getState()
    await session.login(gateway, 'admin', 'password')
    const second = store.refresh(gateway)
    if (outcome === '成功') old.resolve([task])
    else old.reject(new Error('旧清单读取失败'))
    await first
    const pending = useWebsiteDeploymentsStore.getState()
    const completed: WebsiteDeploymentTask = { ...task, id: 'new-task', state: 'succeeded' }
    next.resolve([completed])
    await second

    expect(cleared).toMatchObject({ tasks: [], status: 'idle', errorMessage: undefined })
    expect(list).toHaveBeenCalledTimes(2)
    expect(readTask).not.toHaveBeenCalled()
    expect(pending).toMatchObject({ tasks: [], status: 'loading', errorMessage: undefined })
    expect(useWebsiteDeploymentsStore.getState()).toMatchObject({ tasks: [completed], status: 'ready', errorMessage: undefined })
    expect(useMessageStore.getState().messages).toEqual([])
  })

  it('登出时在途的任务详情不恢复任务或发终态通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const api = gateway.websites.deployment!
    const detail = deferred<WebsiteDeploymentTask>()
    vi.spyOn(api, 'list').mockResolvedValue([task])
    const readTask = vi.spyOn(api, 'task').mockReturnValueOnce(detail.promise)
    const store = useWebsiteDeploymentsStore.getState()
    store.put(task)
    const pending = store.refresh(gateway)
    await vi.waitFor(() => expect(readTask).toHaveBeenCalledExactlyOnceWith(task.id))
    await useSessionStore.getState().logout(gateway)
    detail.resolve({ ...task, state: 'failed', error: '旧部署失败' })
    await pending

    expect(useWebsiteDeploymentsStore.getState()).toMatchObject({ tasks: [], status: 'idle', errorMessage: undefined })
    expect(useMessageStore.getState().messages).toEqual([])
  })
})

it('部署任务刷新失败保留快照，重试时合并在途刷新并清除旧提示', async () => {
  const gateway = createMockGateway({ eventStream: 'memory' })
  const completed: WebsiteDeploymentTask = { ...task, state: 'succeeded' }
  const retry = deferred<readonly WebsiteDeploymentTask[]>()
  const list = vi.spyOn(gateway.websites.deployment!, 'list')
    .mockResolvedValueOnce([completed])
    .mockRejectedValueOnce(new Error('部署任务暂时不可用'))
    .mockReturnValueOnce(retry.promise)
  const store = useWebsiteDeploymentsStore.getState()

  await store.refresh(gateway)
  await store.refresh(gateway)
  expect(useWebsiteDeploymentsStore.getState()).toMatchObject({ tasks: [completed], status: 'error', errorMessage: '部署任务暂时不可用' })

  const pending = store.refresh(gateway)
  await store.refresh(gateway)
  expect(list).toHaveBeenCalledTimes(3)
  expect(useWebsiteDeploymentsStore.getState()).toMatchObject({ tasks: [completed], status: 'loading', errorMessage: '部署任务暂时不可用' })
  retry.resolve([])
  await pending
  expect(useWebsiteDeploymentsStore.getState()).toMatchObject({ tasks: [], status: 'ready', errorMessage: undefined })
})

describe('网站部署通知', () => {
  it('对话框与列表交替回读同一终态时只通知一次', async () => {
    const failed: WebsiteDeploymentTask = { ...task, state: 'failed', error: '构建脚本退出 1' }
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.websites.deployment!, 'list').mockResolvedValue([failed])
    useWebsiteDeploymentsStore.getState().put(task)
    useWebsiteDeploymentsStore.getState().put(failed)
    await useWebsiteDeploymentsStore.getState().refresh(gateway)
    useWebsiteDeploymentsStore.getState().put(failed)
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ tone: 'danger', message: '项目 演示站点：部署失败，构建脚本退出 1' }),
    ])
  })

  it('初次读取历史任务不弹通知，运行任务等待配置时通知警告', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.websites.deployment!, 'list').mockResolvedValue([{ ...task, state: 'succeeded' }])
    await useWebsiteDeploymentsStore.getState().refresh(gateway)
    expect(useMessageStore.getState().messages).toHaveLength(0)
    useWebsiteDeploymentsStore.getState().put(task)
    useWebsiteDeploymentsStore.getState().put({ ...task, state: 'awaiting-config', error: '请选择构建产物' })
    expect(useMessageStore.getState().messages[0]).toMatchObject({ tone: 'warning', message: expect.stringContaining('请选择构建产物') })
  })
})

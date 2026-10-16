import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { useNotificationStore } from './notificationStore'
import { useWebsiteDeploymentsStore } from './websiteDeploymentsStore'

const task: WebsiteDeploymentTask = {
  id: 'deploy-1', sourceId: 'source-1', name: '演示站点', state: 'building', stage: '构建中',
  createdAt: '2026-10-04T07:30:00Z', updatedAt: '2026-10-04T07:30:00Z',
  config: { candidateId: 'candidate-1', target: 'static', command: '', skipTests: false },
  testResult: 'pending',
}

beforeEach(() => {
  useNotificationStore.getState().clear()
  useWebsiteDeploymentsStore.setState({ tasks: [], loading: false, error: undefined })
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
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ tone: 'danger', message: '项目 演示站点：部署失败，构建脚本退出 1' }),
    ])
  })

  it('初次读取历史任务不弹通知，运行任务等待配置时通知警告', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.websites.deployment!, 'list').mockResolvedValue([{ ...task, state: 'succeeded' }])
    await useWebsiteDeploymentsStore.getState().refresh(gateway)
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
    useWebsiteDeploymentsStore.getState().put(task)
    useWebsiteDeploymentsStore.getState().put({ ...task, state: 'awaiting-config', error: '请选择构建产物' })
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({ tone: 'warning', message: expect.stringContaining('请选择构建产物') })
  })
})

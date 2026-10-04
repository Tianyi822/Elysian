import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerBuildTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { createMockGateway } from '../adapters/mock/gateway'
import {
  newBuildRequestId,
  useContainerAppsStore,
} from './containerAppsStore'
import { useNotificationStore } from './notificationStore'

/**
 * 构建任务区的 store 行为：提交入列、取消后的静默回读、日志增量与 requestId 生成。
 * adapter 层走 mock 演示实现（注入零延迟与时钟由契约测试覆盖，这里只看 store 编排）。
 */

function resetStore() {
  useContainerAppsStore.setState({
    status: 'idle',
    apps: [],
    errorMessage: undefined,
    refreshing: false,
    creating: false,
    createError: null,
    writing: null,
    check: null,
    buildsBySlug: {},
    buildsLoading: {},
    buildsRefreshing: {},
    buildsError: {},
    buildPreview: null,
    buildLogs: {},
  })
}

async function seedWorkspace(gateway: ElysianGateway) {
  await gateway.containers.createApp({ slug: 'demo-app', displayName: '演示' })
  await gateway.containers.uploadAppFile('demo-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
}

beforeEach(() => {
  useNotificationStore.getState().clear()
  resetStore()
})

describe('应用工作区构建状态', () => {
  it('submitBuild 成功后任务入列并通知「已提交构建任务」', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await seedWorkspace(gateway)
    resetStore()
    const ok = await useContainerAppsStore.getState().submitBuild(gateway, 'demo-app', {
      mode: 'dockerfile',
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
      dockerfile: 'Dockerfile',
    })
    expect(ok).toBe(true)
    const builds = useContainerAppsStore.getState().buildsBySlug['demo-app']
    expect(builds).toHaveLength(1)
    expect(builds![0]!.state).toBe('queued')
    expect(useNotificationStore.getState().notifications[0]?.message).toBe('已提交构建任务')
  })

  it('submitBuild 失败把服务端错误留在弹窗状态里，notifyOnError 时走通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await seedWorkspace(gateway)
    await gateway.containers.uploadAppFile(
      'demo-app',
      'compose.yml',
      new Blob(['services:\n  web:\n    build:\n      context: ./web\n']),
    )
    resetStore()
    await useContainerAppsStore.getState().previewBuild(gateway, 'demo-app', {
      mode: 'dockerfile',
      dockerfile: 'Dockerfile',
    })
    const ok = await useContainerAppsStore.getState().submitBuild(gateway, 'demo-app', {
      mode: 'compose',
      requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
      compose: 'compose.yml',
      services: ['nope'],
    })
    expect(ok).toBe(false)
    expect(useContainerAppsStore.getState().buildPreview?.submitError).toContain('服务不存在')
    expect(useNotificationStore.getState().notifications).toHaveLength(0)

    const okAgain = await useContainerAppsStore.getState().submitBuild(
      gateway,
      'demo-app',
      {
        mode: 'compose',
        requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5c',
        compose: 'compose.yml',
        services: ['nope'],
      },
      { notifyOnError: true },
    )
    expect(okAgain).toBe(false)
    expect(useNotificationStore.getState().notifications[0]?.tone).toBe('danger')
  })

  it('cancelBuild 取消后静默回读任务清单', async () => {
    const listAppBuilds = vi.fn(async () => [
      {
        id: '1001b1d5-build-1',
        slug: 'demo-app',
        mode: 'dockerfile',
        requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b',
        state: 'cancelled',
        stage: '已取消',
        createdAt: '2026-10-04T07:30:00Z',
        updatedAt: '2026-10-04T07:30:05Z',
        input: { mode: 'dockerfile', requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b', dockerfile: 'Dockerfile' },
        results: [],
        error: '构建已取消',
      } satisfies ContainerBuildTask,
    ])
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const patched: ElysianGateway = {
      ...gateway,
      containers: Object.assign(Object.create(gateway.containers), {
        cancelAppBuild: vi.fn(async () => undefined),
        listAppBuilds,
      }),
    }
    await useContainerAppsStore.getState().cancelBuild(patched, 'demo-app', '1001b1d5-build-1')
    const builds = useContainerAppsStore.getState().buildsBySlug['demo-app']
    expect(builds).toHaveLength(1)
    expect(builds![0]!.state).toBe('cancelled')
    // 静默回读不置刷新遮罩（false 不驱动 BusyVeil）。
    expect(useContainerAppsStore.getState().buildsRefreshing['demo-app']).toBeFalsy()
    expect(listAppBuilds).toHaveBeenCalledWith('demo-app')
    expect(useNotificationStore.getState().notifications[0]?.message).toBe('已取消构建任务')
  })

  it('openBuildLogs 拉全量，loadBuildLogs 按已读字节增量追加', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const logs = vi.fn()
      .mockResolvedValueOnce({ lines: ['任务已提交，等待构建资源'], next: 40, total: 90 })
      .mockResolvedValueOnce({ lines: ['构建成功'], next: 90, total: 90 })
    const patched: ElysianGateway = {
      ...gateway,
      containers: Object.assign(Object.create(gateway.containers), { getAppBuildLogs: logs }),
    }
    await useContainerAppsStore.getState().openBuildLogs(patched, 'demo-app', '1001b1d5-build-1')
    let state = useContainerAppsStore.getState().buildLogs['1001b1d5-build-1']!
    expect(state.lines).toEqual(['任务已提交，等待构建资源'])
    expect(state.next).toBe(40)
    await useContainerAppsStore.getState().loadBuildLogs(patched, 'demo-app', '1001b1d5-build-1')
    state = useContainerAppsStore.getState().buildLogs['1001b1d5-build-1']!
    expect(state.lines).toEqual(['任务已提交，等待构建资源', '构建成功'])
    expect(state.next).toBe(90)
    expect(logs).toHaveBeenNthCalledWith(1, 'demo-app', '1001b1d5-build-1', 0)
    expect(logs).toHaveBeenNthCalledWith(2, 'demo-app', '1001b1d5-build-1', 40)
    useContainerAppsStore.getState().closeBuildLogs('1001b1d5-build-1')
    expect(useContainerAppsStore.getState().buildLogs['1001b1d5-build-1']).toBeUndefined()
  })

  it('newBuildRequestId 生成 uuid 形状且两次不同', () => {
    const first = newBuildRequestId()
    const second = newBuildRequestId()
    expect(first).toMatch(/^[a-f0-9-]{36}$/)
    expect(second).toMatch(/^[a-f0-9-]{36}$/)
    expect(first).not.toBe(second)
  })

  it('refreshBuilds 静默失败不清空旧清单也不置错误，手动失败保留中文错误', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    useContainerAppsStore.setState({
      buildsBySlug: { 'demo-app': [{ id: 't1', slug: 'demo-app', mode: 'dockerfile', requestId: 'r', state: 'succeeded', stage: '构建成功', createdAt: '2026-10-04T07:30:00Z', updatedAt: '2026-10-04T07:31:00Z', input: { mode: 'dockerfile', requestId: 'r', dockerfile: 'Dockerfile' }, results: [], error: '' }] },
    })
    const failing: ElysianGateway = {
      ...gateway,
      containers: Object.assign(Object.create(gateway.containers), {
        listAppBuilds: async () => {
          throw new Error('构建任务读取失败')
        },
      }),
    }
    await useContainerAppsStore.getState().refreshBuilds(failing, 'demo-app', { silent: true })
    expect(useContainerAppsStore.getState().buildsBySlug['demo-app']).toHaveLength(1)
    expect(useContainerAppsStore.getState().buildsError['demo-app']).toBeUndefined()

    await useContainerAppsStore.getState().refreshBuilds(failing, 'demo-app')
    expect(useContainerAppsStore.getState().buildsError['demo-app']).toBe('构建任务读取失败')
    expect(useContainerAppsStore.getState().buildsBySlug['demo-app']).toHaveLength(1)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerAppFile, ContainerBuildTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { createMockGateway } from '../adapters/mock/gateway'
import {
  newBuildRequestId,
  useContainerAppsStore,
} from './containerAppsStore'
import { useMessageStore } from './messageStore'
import { useSessionStore } from './sessionStore'

/**
 * 构建任务区的 store 行为：提交入列、取消后的静默回读、日志增量与 requestId 生成。
 * adapter 层走 mock 演示实现（注入零延迟与时钟由契约测试覆盖，这里只看 store 编排）。
 */

function resetStore() {
  useContainerAppsStore.getState().clearDisplay()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

async function seedWorkspace(gateway: ElysianGateway) {
  await gateway.containers.createApp({ slug: 'demo-app', displayName: '演示' })
  await gateway.containers.uploadAppFile('demo-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
}

beforeEach(async () => {
  await useMessageStore.getState().clear()
  resetStore()
})

describe('工作区登录会话边界', () => {
  beforeEach(() => useSessionStore.setState({ phase: 'authed', mode: 'real', username: 'admin' }))

  const buildInput = { mode: 'dockerfile', requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b', dockerfile: 'Dockerfile' } as const

  it('登出后旧批量上传不发送下一份文件、不回读也不通知', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await gateway.containers.createApp({ slug: 'demo-app', displayName: '演示' })
    const file = await gateway.containers.uploadAppFile('demo-app', 'compose.yml', new Blob(['services: {}']))
    const old = deferred<ContainerAppFile>()
    const upload = vi.spyOn(gateway.containers, 'uploadAppFile').mockReturnValueOnce(old.promise)
    const list = vi.spyOn(gateway.containers, 'listApps')
    const check = vi.spyOn(gateway.containers, 'checkCompose')
    const store = useContainerAppsStore.getState()
    await store.load(gateway, { silent: true })
    const pending = store.upload(gateway, 'demo-app', [new File([], 'compose.yml'), new File([], 'second.txt')])
    expect(upload).toHaveBeenCalledTimes(1)
    await useSessionStore.getState().logout(gateway)
    const afterLogout = useContainerAppsStore.getState()
    list.mockClear()
    old.resolve(file)
    await pending

    expect(upload).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
    expect(useMessageStore.getState().messages).toEqual([])
    expect(afterLogout).toMatchObject({ status: 'idle', apps: [], writing: null })
  })

  it.each(['成功', '失败'] as const)('旧保存%s不释放新登录的同一文件保存', async (outcome) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await seedWorkspace(gateway)
    const file = (await gateway.containers.listApps())[0]!.files[0]!
    const old = deferred<ContainerAppFile>()
    const next = deferred<ContainerAppFile>()
    vi.spyOn(gateway.containers, 'writeAppContent').mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const list = vi.spyOn(gateway.containers, 'listApps')
    const store = useContainerAppsStore.getState()
    const session = useSessionStore.getState()
    const first = store.save(gateway, 'demo-app', 'Dockerfile', '旧内容')
    await session.logout(gateway)
    await session.login(gateway, 'admin', 'password')
    const second = store.save(gateway, 'demo-app', 'Dockerfile', '新内容')
    if (outcome === '成功') old.resolve(file)
    else old.reject(new Error('旧保存失败'))
    const result = await first
    const writing = useContainerAppsStore.getState().writing
    const messages = useMessageStore.getState().messages.slice()
    const reads = list.mock.calls.length
    next.resolve(file)

    expect(await second).toBe(true)
    expect(result).toBe(false)
    expect(writing).toBe('demo-app/Dockerfile')
    expect(messages).toEqual([])
    expect(reads).toBe(0)
  })

  it('会话失效清空构建列表、预览和日志，迟到回执不恢复状态', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await seedWorkspace(gateway)
    const task = await gateway.containers.submitAppBuild('demo-app', buildInput)
    const store = useContainerAppsStore.getState()
    await store.loadBuilds(gateway, 'demo-app')
    await store.previewBuild(gateway, 'demo-app', buildInput)
    const oldBuild = deferred<ContainerBuildTask>()
    const oldLogs = deferred<Awaited<ReturnType<typeof gateway.containers.getAppBuildLogs>>>()
    vi.spyOn(gateway.containers, 'submitAppBuild').mockReturnValueOnce(oldBuild.promise)
    vi.spyOn(gateway.containers, 'getAppBuildLogs').mockReturnValueOnce(oldLogs.promise)
    const build = store.submitBuild(gateway, 'demo-app', buildInput)
    const logs = store.openBuildLogs(gateway, 'demo-app', task.id)
    useSessionStore.getState().expire()
    const cleared = useContainerAppsStore.getState()
    oldBuild.resolve(task)
    oldLogs.resolve({ lines: ['旧日志'], next: 9, total: 9 })
    await logs

    expect(await build).toBe(false)
    expect(cleared).toEqual(useContainerAppsStore.getInitialState())
    expect(useContainerAppsStore.getState()).toBe(cleared)
    expect(useMessageStore.getState().messages).toEqual([])
  })
})

describe('工作区文件状态', () => {
  it('批量上传中途失败仍回读已成功落盘的文件，回读不驱动刷新按钮', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await gateway.containers.createApp({ slug: 'demo-app', displayName: '演示' })
    await useContainerAppsStore.getState().load(gateway, { silent: true })
    const listApps = vi.fn(async () => {
      expect(useContainerAppsStore.getState().refreshing).toBe(false)
      return gateway.containers.listApps()
    })
    const patched: ElysianGateway = {
      ...gateway,
      containers: Object.assign(Object.create(gateway.containers), {
        listApps,
        uploadAppFile: async (slug: string, path: string, file: Blob) => {
          if (path === 'second.txt') throw new Error('上传连接中断')
          return gateway.containers.uploadAppFile(slug, path, file)
        },
      }),
    }
    await useContainerAppsStore.getState().upload(patched, 'demo-app', [
      new File(['first'], 'first.txt'), new File(['second'], 'second.txt'),
    ])
    const state = useContainerAppsStore.getState()
    expect(listApps).toHaveBeenCalledTimes(1)
    expect(state.apps[0]?.files.map((file) => file.path)).toEqual(['first.txt'])
    expect(state.writing).toBeNull()
    expect(useMessageStore.getState().messages[0]?.message)
      .toBe('上传文件失败：上传连接中断（已有 1 个文件上传成功）')
  })

  it('空清单再次加载保留就绪态，刷新成功清除上次错误', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await useContainerAppsStore.getState().load(gateway, { silent: true })
    useContainerAppsStore.setState({ errorMessage: '上次读取失败' })
    const patched: ElysianGateway = {
      ...gateway,
      containers: Object.assign(Object.create(gateway.containers), {
        listApps: async () => {
          expect(useContainerAppsStore.getState().status).toBe('ready')
          expect(useContainerAppsStore.getState().refreshing).toBe(false)
          return []
        },
      }),
    }
    await useContainerAppsStore.getState().load(patched, { silent: true })
    expect(useContainerAppsStore.getState().errorMessage).toBeUndefined()
    expect(useContainerAppsStore.getState().refreshing).toBe(false)
  })
})

describe('工作区构建状态', () => {
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
    const builds = useContainerAppsStore.getState().buildsBySlug['demo-app']?.tasks
    expect(builds).toHaveLength(1)
    expect(builds![0]!.state).toBe('queued')
    expect(useMessageStore.getState().messages[0]?.message).toBe('已提交构建任务')
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
    expect(useMessageStore.getState().messages).toHaveLength(0)

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
    expect(useMessageStore.getState().messages[0]?.tone).toBe('danger')
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
    const builds = useContainerAppsStore.getState().buildsBySlug['demo-app']?.tasks
    expect(builds).toHaveLength(1)
    expect(builds![0]!.state).toBe('cancelled')
    // 静默回读不驱动手动刷新按钮。
    expect(useContainerAppsStore.getState().buildsBySlug['demo-app']?.refreshing).toBe(false)
    expect(listAppBuilds).toHaveBeenCalledWith('demo-app')
    expect(useMessageStore.getState().messages[0]?.message).toBe('已提交取消构建请求')
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

  it('轮询失败保留旧任务清单并记录中文错误，恢复后清除', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    await seedWorkspace(gateway)
    const task = await gateway.containers.submitAppBuild('demo-app', {
      mode: 'dockerfile', requestId: '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b', dockerfile: 'Dockerfile',
    })
    const list = vi.spyOn(gateway.containers, 'listAppBuilds')
      .mockResolvedValueOnce([task])
      .mockRejectedValueOnce(new Error('构建任务读取失败'))
      .mockRejectedValueOnce(new Error('构建任务读取失败'))
      .mockResolvedValueOnce([])
    const { loadBuilds } = useContainerAppsStore.getState()
    const builds = () => useContainerAppsStore.getState().buildsBySlug['demo-app']
    await loadBuilds(gateway, 'demo-app', { silent: true })
    await loadBuilds(gateway, 'demo-app', { silent: true })
    expect(builds()).toMatchObject({ status: 'error', tasks: [task], refreshing: false, errorMessage: '构建任务读取失败' })
    await loadBuilds(gateway, 'demo-app')
    expect(builds()).toMatchObject({ status: 'error', tasks: [task], refreshing: false, errorMessage: '构建任务读取失败' })
    await loadBuilds(gateway, 'demo-app', { silent: true })
    expect(builds()).toMatchObject({ status: 'ready', tasks: [], refreshing: false })
    expect(builds()?.errorMessage).toBeUndefined()
    expect(list).toHaveBeenCalledTimes(4)
  })

  it('成功空任务清单不退回首载，手动刷新加入在途轮询', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const first = deferred<ContainerBuildTask[]>()
    const next = deferred<ContainerBuildTask[]>()
    const list = vi.spyOn(gateway.containers, 'listAppBuilds').mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    const { loadBuilds } = useContainerAppsStore.getState()
    const builds = () => useContainerAppsStore.getState().buildsBySlug['demo-app']

    const initial = loadBuilds(gateway, 'demo-app', { silent: true })
    expect(builds()).toMatchObject({ status: 'loading', refreshing: false })
    expect(builds()?.tasks).toBeUndefined()
    first.resolve([])
    await initial

    const refresh = loadBuilds(gateway, 'demo-app', { silent: true })
    expect(builds()).toMatchObject({ status: 'ready', tasks: [], refreshing: false })
    const manual = loadBuilds(gateway, 'demo-app')
    expect(builds()).toMatchObject({ status: 'ready', tasks: [], refreshing: true })
    expect(list).toHaveBeenCalledTimes(2)
    next.resolve([])
    await Promise.all([refresh, manual])
    expect(builds()).toMatchObject({ status: 'ready', tasks: [], refreshing: false })
  })

  it('已提交的任务不被在途首读清单覆盖', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    await seedWorkspace(gateway)
    const old = deferred<ContainerBuildTask[]>()
    vi.spyOn(gateway.containers, 'listAppBuilds').mockReturnValueOnce(old.promise)
    const store = useContainerAppsStore.getState()
    const load = store.loadBuilds(gateway, 'demo-app')
    const requestId = newBuildRequestId()
    expect(await store.submitBuild(gateway, 'demo-app', { mode: 'dockerfile', requestId, dockerfile: 'Dockerfile' })).toBe(true)
    old.resolve([])
    await load
    expect(useContainerAppsStore.getState().buildsBySlug['demo-app']).toMatchObject({
      status: 'ready', tasks: [expect.objectContaining({ requestId })], refreshing: false,
    })
  })

  it('运行中的构建失败只通知一次，再次轮询和历史初次载入不重复通知', async () => {
    const task: ContainerBuildTask = {
      id: 'build-1', slug: 'demo-app', mode: 'dockerfile', requestId: 'request-1',
      state: 'building', stage: '构建中', createdAt: '2026-10-04T07:30:00Z', updatedAt: '2026-10-04T07:30:00Z',
      input: { mode: 'dockerfile', requestId: 'request-1', dockerfile: 'Dockerfile' }, results: [], error: '',
    }
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    vi.spyOn(gateway.containers, 'listAppBuilds')
      .mockResolvedValueOnce([task])
      .mockResolvedValue([{ ...task, state: 'failed', error: '镜像下载失败' }])
    const { loadBuilds } = useContainerAppsStore.getState()
    await loadBuilds(gateway, 'demo-app', { silent: true })
    await loadBuilds(gateway, 'demo-app', { silent: true })
    await loadBuilds(gateway, 'demo-app', { silent: true })
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ tone: 'danger', message: 'demo-app：镜像构建失败，镜像下载失败' }),
    ])
    await useMessageStore.getState().clear()
    resetStore()
    await loadBuilds(gateway, 'demo-app', { silent: true })
    expect(useMessageStore.getState().messages).toHaveLength(0)
  })
})

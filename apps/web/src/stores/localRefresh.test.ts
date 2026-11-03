import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { createMockGateway } from '../adapters/mock/gateway'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'
import type { ElysianGateway } from '../contracts/adapters'
import { useUsersStore } from './usersStore'
import { useFirewallStore } from './firewallStore'
import { useContainersStore } from './containersStore'
import { useContainerAppsStore } from './containerAppsStore'
import { useWebsitesStore } from './websitesStore'
import { useDatabaseStore } from './databaseStore'
import { useFilesStore } from './filesStore'
import { useModelSettingsStore } from './modelSettingsStore'
import { useAgentExtensionsStore } from './agentExtensionsStore'
import { useDashboardStore } from './dashboardStore'
import { useRuntimeLogStore } from './runtimeLogStore'
import { useLoginLogStore } from './loginLogStore'
import { useOperationLogStore } from './operationLogStore'

afterEach(() => vi.restoreAllMocks())

function adapter<T extends object>(base: T, patch: Partial<T>): T {
  return Object.assign(Object.create(base), patch) as T
}

function refreshCase<S, T>(options: {
  name: string
  store: StoreApi<S>
  empty: T
  gateway(base: ElysianGateway, read: () => Promise<T>): ElysianGateway
  load(state: S, gateway: ElysianGateway): Promise<void>
  select(state: S): { status: string; snapshot: unknown; error?: string }
}) {
  return {
    name: options.name,
    create() {
      const { store } = options
      const reset = () => store.setState(store.getInitialState(), true)
      reset()
      let result: () => Promise<T> = async () => options.empty
      const read = vi.fn(() => result())
      const base = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
      const gateway = options.gateway(base, read)
      return {
        load: () => options.load(store.getState(), gateway),
        state: () => options.select(store.getState()),
        reset,
        calls: () => read.mock.calls.length,
        recover: () => { result = () => Promise.resolve(options.empty) },
        hold() {
          let resolve!: (value: T) => void
          let reject!: (error: Error) => void
          const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
          result = () => promise
          return { finish: () => resolve(options.empty), fail: () => reject(new Error('暂时离线')) }
        },
      }
    },
  }
}

const cases = [
  refreshCase({ name: '主机账号', store: useUsersStore, empty: [],
    gateway: (base, read) => ({ ...base, users: adapter(base.users, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.users, error: state.errorMessage }) }),
  refreshCase({ name: '防火墙', store: useFirewallStore, empty: [],
    gateway: (base, read) => ({ ...base, firewall: adapter(base.firewall, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.rules, error: state.errorMessage }) }),
  refreshCase({ name: '容器', store: useContainersStore, empty: [],
    gateway: (base, read) => ({ ...base, containers: adapter(base.containers, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.containers, error: state.errorMessage }) }),
  refreshCase({ name: '工作区', store: useContainerAppsStore, empty: [],
    gateway: (base, read) => ({ ...base, containers: adapter(base.containers, { listApps: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.apps, error: state.errorMessage }) }),
  refreshCase({ name: '网站', store: useWebsitesStore, empty: { projects: [], proxy: { state: 'active' as const, detail: null } },
    gateway: (base, read) => ({ ...base, websites: adapter(base.websites, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.projects, error: state.errorMessage }) }),
  refreshCase({ name: '数据库', store: useDatabaseStore, empty: [],
    gateway: (base, read) => ({ ...base, databases: adapter(base.databases, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.databases, error: state.errorMessage }) }),
  refreshCase({ name: '文件目录', store: useFilesStore, empty: [],
    gateway: (base, read) => ({ ...base, files: adapter(base.files, { list: read }) }),
    load: (state, gateway) => state.load(gateway, '/tmp'),
    select: state => ({ status: state.status, snapshot: state.entries, error: state.errorMessage }) }),
  refreshCase({ name: '模型配置', store: useModelSettingsStore, empty: [],
    gateway: (base, read) => ({ ...base, modelSettings: adapter(base.modelSettings, { listModelServices: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.models, error: state.errorMessage }) }),
  refreshCase({ name: 'Skill', store: useAgentExtensionsStore, empty: [],
    gateway: (base, read) => ({ ...base, agentExtensions: adapter(base.agentExtensions, { listSkills: read }) }),
    load: (state, gateway) => state.loadSkills(gateway, { silent: true }),
    select: state => ({ status: state.skillsStatus, snapshot: state.skills, error: state.skillsErrorMessage }) }),
  refreshCase({ name: 'MCP', store: useAgentExtensionsStore, empty: [],
    gateway: (base, read) => ({ ...base, agentExtensions: adapter(base.agentExtensions, { listMcpServers: read }) }),
    load: (state, gateway) => state.loadMcpServers(gateway, { silent: true }),
    select: state => ({ status: state.mcpStatus, snapshot: state.mcpServers, error: state.mcpErrorMessage }) }),
  refreshCase({ name: '仪表盘', store: useDashboardStore, empty: [],
    gateway: (base, read) => ({ ...base, resources: adapter(base.resources, { list: read }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.resources, error: state.errorMessage }) }),
  refreshCase({ name: '运行日志', store: useRuntimeLogStore, empty: undefined,
    gateway: (base, read) => ({ ...base, logs: adapter(base.logs, { runtimeLog: async query => { await read(); return { ...await base.logs.runtimeLog(query), entries: [], total: 0, truncated: false } } }) }),
    load: (state, gateway) => state.load(gateway, { silent: true }),
    select: state => ({ status: state.status, snapshot: state.entries, error: state.errorMessage }) }),
  refreshCase({ name: '登录日志', store: useLoginLogStore, empty: undefined,
    gateway: (base, read) => ({ ...base, logs: adapter(base.logs, { loginLogs: async query => { await read(); return { ...await base.logs.loginLogs(query), entries: [], total: 0, truncated: false } } }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.entries, error: state.errorMessage }) }),
  refreshCase({ name: '操作日志', store: useOperationLogStore, empty: undefined,
    gateway: (base, read) => ({ ...base, logs: adapter(base.logs, { operationLogs: async query => { await read(); return { ...await base.logs.operationLogs(query), entries: [], total: 0, truncated: false } } }) }),
    load: (state, gateway) => state.load(gateway),
    select: state => ({ status: state.status, snapshot: state.entries, error: state.errorMessage }) }),
]

describe.each(cases)('$name 原位刷新', fixture => {
  it('空结果也保留就绪态，合并在途读取，失败可恢复', async () => {
    const test = fixture.create()
    await test.load()
    const snapshot = test.state().snapshot
    const request = test.hold()
    const first = test.load(), second = test.load()
    expect(test.state().status).toBe('ready')
    expect(test.state().snapshot).toBe(snapshot)
    expect(test.calls()).toBe(2)
    request.fail()
    await Promise.all([first, second])
    expect(test.state()).toMatchObject({ status: 'ready', error: '暂时离线' })
    expect(test.state().snapshot).toBe(snapshot)
    test.recover()
    await test.load()
    expect(test.state().error).toBeUndefined()
  })

  it('身份代次变化后，迟到读取不能恢复已清除的数据', async () => {
    const test = fixture.create()
    await test.load()
    const request = test.hold()
    const pending = test.load()
    advanceAuthGeneration()
    test.reset()
    const cleared = test.state()
    request.finish()
    await pending
    expect(test.state()).toEqual(cleared)
  })
})

describe('刷新与业务结果的隔离', () => {
  it('文件自动回读保持静默，手动刷新可复用在途请求并转动按钮', async () => {
    useFilesStore.setState(useFilesStore.getInitialState(), true)
    const gateway = createMockGateway({ eventStream: 'memory' })
    await useFilesStore.getState().load(gateway, '/')
    const entries = useFilesStore.getState().entries
    let release!: () => void
    const list = vi.spyOn(gateway.files, 'list').mockReturnValueOnce(new Promise(resolve => { release = () => resolve(entries) }))
    const automatic = useFilesStore.getState().load(gateway, '/', { silent: true })
    expect(useFilesStore.getState().reloading).toBe(false)
    const manual = useFilesStore.getState().load(gateway, '/')
    expect(useFilesStore.getState().reloading).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([automatic, manual])
    expect(useFilesStore.getState().reloading).toBe(false)
  })

  it('旧防火墙读取不能覆盖刚确认的开关', async () => {
    useFirewallStore.setState(useFirewallStore.getInitialState(), true)
    const gateway = createMockGateway({ eventStream: 'memory' })
    await useFirewallStore.getState().load(gateway)
    const old = useFirewallStore.getState().toggles
    let release!: (value: typeof old) => void
    vi.spyOn(gateway.firewall, 'toggles').mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const pending = useFirewallStore.getState().load(gateway)
    const next = { ...old, pingBlocked: !old.pingBlocked }
    await useFirewallStore.getState().toggle(gateway, next)
    release(old)
    await pending
    expect(useFirewallStore.getState().toggles).toEqual(next)
  })

  it('代理配置确认后重新读取，旧网站请求不能覆盖新通道状态', async () => {
    useWebsitesStore.setState(useWebsitesStore.getInitialState(), true)
    const gateway = createMockGateway({ eventStream: 'memory' })
    await useWebsitesStore.getState().load(gateway)
    const old = { projects: useWebsitesStore.getState().projects, proxy: useWebsitesStore.getState().proxyStatus }
    const proxy = { state: 'active' as const, detail: '新的通道状态' }
    let release!: (value: typeof old) => void
    const read = vi.spyOn(gateway.websites, 'list').mockReturnValueOnce(new Promise(resolve => { release = resolve })).mockResolvedValueOnce({ ...old, proxy })
    vi.spyOn(gateway.websites, 'reconcileProxy').mockResolvedValue(proxy)
    const pending = useWebsitesStore.getState().load(gateway)
    await useWebsitesStore.getState().reconcileProxy(gateway)
    expect(read).toHaveBeenCalledTimes(2)
    release(old)
    await pending
    expect(useWebsitesStore.getState().proxyStatus).toEqual(proxy)
  })

  it('同目录失败保留非空列表，新目录只显示新目标的加载状态', async () => {
    useFilesStore.setState(useFilesStore.getInitialState(), true)
    const gateway = createMockGateway({ eventStream: 'memory' })
    const list = vi.spyOn(gateway.files, 'list')
    await useFilesStore.getState().load(gateway, '/')
    const old = useFilesStore.getState().entries
    expect(old.length).toBeGreaterThan(0)
    list.mockRejectedValueOnce(new Error('读取失败'))
    await useFilesStore.getState().load(gateway, '/')
    expect(useFilesStore.getState()).toMatchObject({ status: 'ready', errorMessage: '读取失败' })
    expect(useFilesStore.getState().entries).toBe(old)
    let release!: () => void
    list.mockReturnValueOnce(new Promise(resolve => { release = () => resolve([]) }))
    const pending = useFilesStore.getState().load(gateway, '/new-target')
    expect(useFilesStore.getState()).toMatchObject({ status: 'loading', path: '/new-target', entries: [] })
    release()
    await pending
    expect(useFilesStore.getState()).toMatchObject({ status: 'ready', path: '/new-target', entries: [] })
  })

  it('镜像自动读取不转按钮，手动刷新合并同一请求并显示在途状态', async () => {
    useContainersStore.setState(useContainersStore.getInitialState(), true)
    const gateway = createMockGateway({ eventStream: 'memory' })
    await useContainersStore.getState().load(gateway)
    const images = useContainersStore.getState().images
    let release!: () => void
    const list = vi.spyOn(gateway.containers, 'listImages').mockReturnValueOnce(new Promise(resolve => { release = () => resolve(images) }))
    const automatic = useContainersStore.getState().refreshImages(gateway, { notify: false })
    expect(useContainersStore.getState().imageRefreshStatus).toBe('idle')
    const manual = useContainersStore.getState().refreshImages(gateway)
    expect(useContainersStore.getState().imageRefreshStatus).toBe('loading')
    expect(list).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([automatic, manual])
    expect(useContainersStore.getState().imageRefreshStatus).toBe('idle')
  })
})

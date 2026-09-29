import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WebsiteProject,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProjectUpdateInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'
import { useWebsitesStore, websiteNoticeSuffix } from './websitesStore'

/*
 * 网站区 store 的行为测试。网关全部用手写 stub 注入，
 * 不依赖 mock 实现，只依赖 adapter 接口形状。
 */

function project(overrides: Partial<WebsiteProject>): WebsiteProject {
  return {
    id: 'p',
    kind: 'java',
    name: 'app',
    pid: null,
    containerId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    port: 8080,
    runtimeVersion: '17',
    rootDir: '/www/wwwroot/app',
    runState: 'stopped',
    domain: null,
    expiryAt: null,
    note: null,
    cert: 'none',
    category: 'production',
    deployCommand: null,
    gitUrl: null,
    traffic: { todayMb: 0, totalGb: 0 },
    ...overrides,
  }
}

/** 四个夹具覆盖：Java 运行中、Node 已停止、HTML 静态站、Go 常驻。 */
const FIXTURES: readonly WebsiteProject[] = [
  project({
    id: 'web-java-api',
    kind: 'java',
    name: '订单中心-api',
    pid: 3001,
    port: 8080,
    runState: 'running',
    note: '商城核心',
    category: 'production',
    deployCommand: 'java -jar order-api.jar',
    traffic: { todayMb: 120, totalGb: 88 },
  }),
  project({
    id: 'web-node-site',
    kind: 'node',
    name: 'marketing-site',
    runtimeVersion: '20.11.1',
    port: 3000,
    note: '官网与落地页',
    category: 'testing',
    rootDir: '/www/wwwroot/marketing-site',
  }),
  project({
    id: 'web-html-portal',
    kind: 'html',
    name: 'company-portal',
    runtimeVersion: null,
    port: 8088,
    note: '静态门户',
    category: 'development',
    rootDir: '/www/wwwroot/company-portal',
  }),
  project({
    id: 'web-go-agent',
    kind: 'go',
    name: 'backup-agent',
    pid: 4410,
    port: 9100,
    runtimeVersion: '1.22.4',
    runState: 'running',
    category: 'production',
    deployCommand: './backup-agent -c etc/agent.toml',
    rootDir: '/www/wwwroot/backup-agent',
  }),
]

function gatewayWith(overrides: Partial<ElysianGateway['websites']> = {}): ElysianGateway {
  return {
    websites: {
      list: async () => ({ projects: [...FIXTURES], proxy: { state: 'active', detail: null } }),
      create: async (kind: WebsiteProjectKind, input: WebsiteProjectCreateInput) =>
        project({
          id: `web-${kind}-new`,
          kind,
          name: input.name,
          port: input.port,
          runtimeVersion: kind === 'html' ? null : (input.runtimeVersion ?? '17'),
          gitUrl: input.gitUrl ?? null,
        }),
      update: async (projectId: string, input: WebsiteProjectUpdateInput) => {
        const target = FIXTURES.find((item) => item.id === projectId)!
        return { ...target, note: input.note ?? target.note, expiryAt: input.expiryAt ?? target.expiryAt }
      },
      remove: async () => {},
      setRunning: async (projectId: string, running: boolean) => {
        const target = FIXTURES.find((item) => item.id === projectId)!
        return { ...target, runState: running ? 'running' : 'stopped', pid: running ? target.pid : null }
      },
      logs: async (projectId: string) => [`[${projectId}] 日志行一`, `[${projectId}] 日志行二`],
      reconcileProxy: async () => ({ state: 'active', detail: null }),
      ...overrides,
    },
  } as unknown as ElysianGateway
}

beforeEach(() => {
  useWebsitesStore.setState({
    status: 'idle',
    errorMessage: undefined,
    projects: [],
    proxyStatus: { state: 'active', detail: null },
    search: '',
    category: 'all',
    refreshing: false,
    reconciling: false,
    saving: false,
    createDialogOpen: false,
    settingsTarget: undefined,
    removeTarget: undefined,
    detailTarget: undefined,
    detailLogs: undefined,
    detailLogsLoading: false,
    busyProjectIds: [],
  })
  useNotificationStore.setState({ notifications: [] })
})

describe('加载与刷新', () => {
  it('load 成功进入 ready 并带上项目列表', async () => {
    await useWebsitesStore.getState().load(gatewayWith())
    const state = useWebsitesStore.getState()
    expect(state.status).toBe('ready')
    expect(state.projects).toHaveLength(4)
  })

  it('load 失败进入 error：错误文案优先取 adapter 的中文 Error.message', async () => {
    await useWebsitesStore.getState().load(gatewayWith({ list: async () => { throw new Error('网站数据源不可用') } }))
    expect(useWebsitesStore.getState().status).toBe('error')
    expect(useWebsitesStore.getState().errorMessage).toBe('网站数据源不可用')
  })

  it('load 失败且错误不是 Error 时回落固定中文文案', async () => {
    await useWebsitesStore.getState().load(gatewayWith({ list: async () => { throw 'boom' } }))
    expect(useWebsitesStore.getState().status).toBe('error')
    expect(useWebsitesStore.getState().errorMessage).toBe('网站数据加载失败')
  })

  it('refresh 静默重载：失败只发危险通知，不把整页打成 error', async () => {
    const gateway = gatewayWith()
    await useWebsitesStore.getState().load(gateway)
    await useWebsitesStore.getState().refresh(gatewayWith({ list: async () => { throw new Error('刷新失败：会话中断') } }))
    const state = useWebsitesStore.getState()
    expect(state.status).toBe('ready')
    expect(state.projects).toHaveLength(4)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '刷新失败：会话中断',
    })
  })

  it('refresh 成功更新列表并清掉刷新锁', async () => {
    await useWebsitesStore.getState().load(gatewayWith())
    await useWebsitesStore.getState().refresh(gatewayWith())
    const state = useWebsitesStore.getState()
    expect(state.refreshing).toBe(false)
    expect(state.projects).toHaveLength(4)
  })
})

describe('筛选', () => {
  it('setSearch 与 setCategory 只改筛选字段', () => {
    useWebsitesStore.getState().setSearch('订单')
    useWebsitesStore.getState().setCategory('testing')
    const state = useWebsitesStore.getState()
    expect(state.search).toBe('订单')
    expect(state.category).toBe('testing')
  })
})

describe('新建项目', () => {
  it('openCreate 与 closeCreate 控制弹窗开关', () => {
    useWebsitesStore.getState().openCreate()
    expect(useWebsitesStore.getState().createDialogOpen).toBe(true)
    useWebsitesStore.getState().closeCreate()
    expect(useWebsitesStore.getState().createDialogOpen).toBe(false)
  })

  it('createProject 把表单选择的类型传给 adapter，成功后追加列表并通知', async () => {
    const create = vi.fn(async (kind: WebsiteProjectKind, input: WebsiteProjectCreateInput) =>
      project({
        id: 'web-node-new',
        kind,
        name: input.name,
        port: input.port,
        runtimeVersion: input.runtimeVersion ?? null,
      }),
    )
    const gateway = gatewayWith({ create })
    await useWebsitesStore.getState().load(gateway)
    useWebsitesStore.getState().openCreate()

    const ok = await useWebsitesStore.getState().createProject(gateway, 'node', {
      name: '新站点',
      port: 3000,
      runtimeVersion: '20.11.1',
    })

    expect(ok).toBe(true)
    expect(create).toHaveBeenCalledWith('node', {
      name: '新站点',
      port: 3000,
      runtimeVersion: '20.11.1',
    })
    const state = useWebsitesStore.getState()
    expect(state.projects.map((item) => item.id)).toContain('web-node-new')
    expect(state.createDialogOpen).toBe(false)
    expect(state.saving).toBe(false)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '项目 新站点 已添加（演示数据，刷新后还原）',
    })
  })

  it('createProject 失败：弹窗保留、危险通知、saving 复位', async () => {
    await useWebsitesStore.getState().load(gatewayWith())
    useWebsitesStore.getState().openCreate()
    const ok = await useWebsitesStore.getState().createProject(
      gatewayWith({ create: async () => { throw new Error('同名项目已存在') } }),
      'node',
      { name: 'marketing-site', port: 3000, runtimeVersion: '20.11.1' },
    )
    const state = useWebsitesStore.getState()
    expect(ok).toBe(false)
    expect(state.createDialogOpen).toBe(true)
    expect(state.saving).toBe(false)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '同名项目已存在',
    })
  })
})

describe('设置与删除', () => {
  it('saveSettings 更新项目、关弹窗并通知', async () => {
    const gateway = gatewayWith()
    await useWebsitesStore.getState().load(gateway)
    useWebsitesStore.getState().openSettings(FIXTURES[1]!)

    const ok = await useWebsitesStore.getState().saveSettings(gateway, 'web-node-site', {
      note: '已交给市场部维护',
      expiryAt: '2027-01-01',
    })

    expect(ok).toBe(true)
    const state = useWebsitesStore.getState()
    expect(state.settingsTarget).toBeUndefined()
    expect(state.projects.find((item) => item.id === 'web-node-site')?.note).toBe('已交给市场部维护')
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '项目 marketing-site 已修改（演示数据，刷新后还原）',
    })
  })

  it('removeProject 成功后项目消失、弹窗状态清除并通知', async () => {
    const gateway = gatewayWith()
    await useWebsitesStore.getState().load(gateway)
    useWebsitesStore.getState().openRemove(FIXTURES[2]!)

    await useWebsitesStore.getState().removeProject(gateway, FIXTURES[2]!)

    const state = useWebsitesStore.getState()
    expect(state.projects.map((item) => item.id)).not.toContain('web-html-portal')
    expect(state.removeTarget).toBeUndefined()
    expect(state.busyProjectIds).toEqual([])
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '项目 company-portal 已删除（演示数据，刷新后还原）',
    })
  })
})

describe('启停', () => {
  it('setRunning 乐观更新先行，确认后发通知并清忙碌', async () => {
    let confirm!: (value: WebsiteProject) => void
    const gateway = gatewayWith({
      setRunning: () => new Promise<WebsiteProject>((resolve) => { confirm = resolve }),
    })
    await useWebsitesStore.getState().load(gateway)
    const target = useWebsitesStore.getState().projects[0]!

    const promise = useWebsitesStore.getState().setRunning(gateway, target, false)
    // 乐观更新：确认回来之前界面先翻成已停止并清 PID。
    expect(useWebsitesStore.getState().projects[0]).toMatchObject({ runState: 'stopped', pid: null })
    expect(useWebsitesStore.getState().busyProjectIds).toEqual(['web-java-api'])

    confirm({ ...target, runState: 'stopped', pid: null })
    await promise

    const state = useWebsitesStore.getState()
    expect(state.busyProjectIds).toEqual([])
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '项目 订单中心-api 已停止（演示数据，刷新后还原）',
    })
  })

  it('setRunning 失败回滚乐观状态并发危险通知', async () => {
    const gateway = gatewayWith({
      setRunning: async () => { throw new Error('执行层未接入') },
    })
    await useWebsitesStore.getState().load(gateway)
    const target = useWebsitesStore.getState().projects[0]!

    await useWebsitesStore.getState().setRunning(gateway, target, false)

    const state = useWebsitesStore.getState()
    expect(state.projects[0]).toMatchObject({ runState: 'running', pid: 3001 })
    expect(state.busyProjectIds).toEqual([])
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '执行层未接入',
    })
  })
})

describe('反向代理状态与对账', () => {
  it('load 与 refresh 把列表附带的通道状态落地', async () => {
    const unavailable = { state: 'unavailable' as const, detail: '宿主未提供 Caddy 管理通道' }
    await useWebsitesStore.getState().load(gatewayWith({ list: async () => ({ projects: [...FIXTURES], proxy: unavailable }) }))
    expect(useWebsitesStore.getState().proxyStatus).toEqual(unavailable)

    const drifted = { state: 'active' as const, detail: '2 个站点的路由未下发' }
    await useWebsitesStore.getState().refresh(
      gatewayWith({ list: async () => ({ projects: [...FIXTURES], proxy: drifted }) }),
    )
    expect(useWebsitesStore.getState().proxyStatus).toEqual(drifted)
  })

  it('reconcileProxy 成功：状态落地、成功通知并随后静默刷新', async () => {
    const list = vi.fn(async () => ({ projects: [...FIXTURES], proxy: { state: 'active' as const, detail: null } }))
    const gateway = gatewayWith({
      list,
      reconcileProxy: async () => ({ state: 'active' as const, detail: null }),
    })
    await useWebsitesStore.getState().load(gateway)

    await useWebsitesStore.getState().reconcileProxy(gateway)

    const state = useWebsitesStore.getState()
    expect(state.proxyStatus).toEqual({ state: 'active', detail: null })
    expect(state.reconciling).toBe(false)
    // 对账成功后自动刷新一次：证书与路由折算随新列表更新。
    expect(list).toHaveBeenCalledTimes(2)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '反向代理配置已重新下发',
    })
  })

  it('reconcileProxy 失败：危险通知透传 adapter 错误，reconciling 复位', async () => {
    await useWebsitesStore.getState().load(gatewayWith())
    await useWebsitesStore.getState().reconcileProxy(
      gatewayWith({ reconcileProxy: async () => { throw new Error('宿主 Caddy 存在面板外的配置，拒绝覆盖') } }),
    )

    expect(useWebsitesStore.getState().reconciling).toBe(false)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '宿主 Caddy 存在面板外的配置，拒绝覆盖',
    })
  })

  it('动作完成提示按运行模式标注：Docker 真实执行不带后缀，本地演示标注演示语义', () => {
    expect(websiteNoticeSuffix(true)).toBe('')
    expect(websiteNoticeSuffix(false)).toBe('（演示数据，刷新后还原）')
  })
})

describe('详情抽屉', () => {
  it('openDetail 先进 loading，日志到达后就绪', async () => {
    let resolveLogs!: (value: readonly string[]) => void
    const gateway = gatewayWith({
      logs: () => new Promise<readonly string[]>((resolve) => { resolveLogs = resolve }),
    })
    await useWebsitesStore.getState().load(gateway)
    const target = useWebsitesStore.getState().projects[0]!

    const promise = useWebsitesStore.getState().openDetail(gateway, target)
    expect(useWebsitesStore.getState().detailTarget?.id).toBe('web-java-api')
    expect(useWebsitesStore.getState().detailLogs).toBeUndefined()
    expect(useWebsitesStore.getState().detailLogsLoading).toBe(true)

    resolveLogs(['line-1', 'line-2'])
    await promise

    const state = useWebsitesStore.getState()
    expect(state.detailLogs).toEqual(['line-1', 'line-2'])
    expect(state.detailLogsLoading).toBe(false)
  })

  it('openDetail 拉日志失败：危险通知并清 loading，文案优先取 Error.message', async () => {
    const gateway = gatewayWith({ logs: async () => { throw new Error('日志服务不可用') } })
    await useWebsitesStore.getState().load(gatewayWith())

    await useWebsitesStore.getState().openDetail(gateway, FIXTURES[0]!)

    const state = useWebsitesStore.getState()
    expect(state.detailLogsLoading).toBe(false)
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '日志服务不可用',
    })
  })

  it('openDetail 拉日志失败且错误不是 Error 时回落固定文案', async () => {
    const gateway = gatewayWith({ logs: async () => { throw 'boom' } })
    await useWebsitesStore.getState().load(gatewayWith())

    await useWebsitesStore.getState().openDetail(gateway, FIXTURES[0]!)

    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'danger',
      message: '日志加载失败',
    })
  })

  it('reloadDetailLogs 在抽屉打开时重新拉取日志', async () => {
    let round = 0
    let resolveLogs!: (value: readonly string[]) => void
    const gateway = gatewayWith({
      logs: () => round === 0
        ? Promise.resolve(['第一轮日志'])
        : new Promise<readonly string[]>((resolve) => { resolveLogs = resolve }),
    })
    await useWebsitesStore.getState().load(gateway)
    await useWebsitesStore.getState().openDetail(gateway, FIXTURES[0]!)
    expect(useWebsitesStore.getState().detailLogs).toEqual(['第一轮日志'])

    round = 1
    const promise = useWebsitesStore.getState().reloadDetailLogs(gateway)
    // 刷新期间旧日志留在屏上，只有 loading 在转。
    expect(useWebsitesStore.getState().detailLogs).toEqual(['第一轮日志'])
    expect(useWebsitesStore.getState().detailLogsLoading).toBe(true)

    resolveLogs(['第一轮日志', '第二轮日志'])
    await promise

    const state = useWebsitesStore.getState()
    expect(state.detailLogs).toEqual(['第一轮日志', '第二轮日志'])
    expect(state.detailLogsLoading).toBe(false)
  })

  it('closeDetail 清空目标、日志与 loading', async () => {
    const gateway = gatewayWith()
    await useWebsitesStore.getState().load(gateway)
    await useWebsitesStore.getState().openDetail(gateway, FIXTURES[0]!)
    useWebsitesStore.getState().closeDetail()
    const state = useWebsitesStore.getState()
    expect(state.detailTarget).toBeUndefined()
    expect(state.detailLogs).toBeUndefined()
    expect(state.detailLogsLoading).toBe(false)
  })
})

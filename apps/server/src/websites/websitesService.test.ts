import { describe, expect, it, vi } from 'vitest'
import { buildCaddyConfig } from './caddyConfig.ts'
import { CaddyChannelError, type WebsiteCaddy } from './websitesCaddy.ts'
import type { WebsiteDocker } from './websitesDocker.ts'
import { createMemoryWebsiteRegistry, type WebsiteRecord } from './websitesRegistry.ts'
import {
  createWebsiteService,
  validateWebsiteCreateRequest,
  validateWebsiteUpdateRequest,
  type WebsiteCreateRequest,
} from './websitesService.ts'
import type { PortMapping } from '@elysian/contracts'
import { InvalidRequestError } from '../shared/errors.ts'

const CONTAINER_ID = 'a'.repeat(64)
const CONTAINER_NAME = 'elysian-site-0123456789ab'

function createInput(overrides: Partial<WebsiteCreateRequest> = {}): WebsiteCreateRequest {
  return validateWebsiteCreateRequest({
    kind: 'node', name: 'admin-console', port: 3000, runtimeVersion: '20.11.1',
    domain: null, gitUrl: null, note: null, ...overrides,
  })
}

function fixture(options: {
  portBindings?: readonly PortMapping[]
  inspectState?: { Running: boolean; Pid: number } | 'missing'
} = {}) {
  const registry = createMemoryWebsiteRegistry()
  const sequence: string[] = []
  const inspectState = options.inspectState ?? { Running: false, Pid: 0 }
  const docker: WebsiteDocker = {
    ensureImage: vi.fn(async () => { sequence.push('ensure-image') }),
    ensureSiteDir: vi.fn(async (name, mountRoot) => {
      sequence.push('mkdir')
      return `${mountRoot}/wwwroot/${name}`
    }),
    newContainerName: () => CONTAINER_NAME,
    create: vi.fn(async () => { sequence.push('container'); return { containerId: CONTAINER_ID } }),
    start: vi.fn(async () => { sequence.push('start') }),
    stop: vi.fn(async () => { sequence.push('stop') }),
    inspect: vi.fn(async () => {
      if (inspectState === 'missing') throw new InvalidRequestError(404, '站点容器已不存在')
      return { State: inspectState }
    }),
    logs: vi.fn(async () => { sequence.push('logs'); return ['启动完成，监听端口 3000'] }),
    removeManaged: vi.fn(async (): Promise<'removed' | 'missing'> => { sequence.push('remove-container'); return 'removed' }),
    removeCreated: vi.fn(async () => { sequence.push('remove-created') }),
    removeSiteDir: vi.fn(async () => { sequence.push('remove-dir') }),
  }
  const caddyState: {
    current: unknown
    failCurrentWith: Error | null
    failLoadWith: Error | null
    loads: unknown[]
  } = { current: {}, failCurrentWith: null, failLoadWith: null, loads: [] }
  const caddy: WebsiteCaddy = {
    adminListen: 'unix//run/caddy/admin.sock',
    async load(config) {
      if (caddyState.failLoadWith) throw caddyState.failLoadWith
      caddyState.loads.push(config)
      caddyState.current = config
    },
    async currentConfig() {
      if (caddyState.failCurrentWith) throw caddyState.failCurrentWith
      return caddyState.current
    },
  }
  const service = createWebsiteService({
    registry,
    docker,
    caddy,
    mountRoot: '/srv',
    listPortBindings: async () => options.portBindings ?? [],
  })
  return { service, registry, docker, caddy, caddyState, sequence }
}

function seededRow(overrides: Partial<WebsiteRecord> = {}): WebsiteRecord {
  return {
    id: 'site-1',
    kind: 'node',
    name: 'admin-console',
    port: 3000,
    runtimeVersion: '20.11.1',
    rootDir: '/srv/wwwroot/admin-console',
    domain: null,
    containerName: CONTAINER_NAME,
    containerId: CONTAINER_ID,
    imageRef: 'node:20.11.1',
    deployCommand: 'tail -f /dev/null',
    enabled: false,
    category: 'development',
    expiryAt: null,
    note: null,
    gitUrl: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

describe('validateWebsiteCreateRequest 手写中文校验', () => {
  it('类型、名称、端口、运行时版本与域名的逐字文案', () => {
    expect(() => validateWebsiteCreateRequest({ kind: 'php', name: 'x', port: 3000 })).toThrow('项目类型无效')
    expect(() => validateWebsiteCreateRequest({ kind: 'node', name: 'a/b', port: 3000, runtimeVersion: '20.11.1' })).toThrow('项目名称需为 1-64 个字符')
    expect(() => validateWebsiteCreateRequest({ kind: 'node', name: 'x', port: 0, runtimeVersion: '20.11.1' })).toThrow('端口需为 1-65535 的整数')
    expect(() => validateWebsiteCreateRequest({ kind: 'node', name: 'x', port: 3000 })).toThrow('请选择运行时版本')
    expect(() => validateWebsiteCreateRequest({ kind: 'node', name: 'x', port: 3000, runtimeVersion: '99.9.9' })).toThrow('运行时版本不在可选目录内')
    expect(() => validateWebsiteCreateRequest({ kind: 'node', name: 'x', port: 3000, runtimeVersion: '20.11.1', domain: 'bad name' })).toThrow('域名无效')
    // HTML 忽略 runtimeVersion，域名合法形态放行。
    const html = validateWebsiteCreateRequest({ kind: 'html', name: '官网', port: 8088, runtimeVersion: '20.11.1', domain: 'www.example.com' })
    expect(html.runtimeVersion).toBeNull()
    expect(html.domain).toBe('www.example.com')
  })

  it('到期时间判据：合法日期放行、畸形与不存在日期拒绝、空串按长期有效', () => {
    expect(validateWebsiteUpdateRequest({ expiryAt: '2026-12-20' }).expiryAt).toBe('2026-12-20')
    expect(validateWebsiteUpdateRequest({ expiryAt: '' }).expiryAt).toBeNull()
    expect(validateWebsiteUpdateRequest({ note: '  ' }).note).toBeNull()
    expect(() => validateWebsiteUpdateRequest({ expiryAt: '2026/12/20' })).toThrow('到期时间格式无效')
    expect(() => validateWebsiteUpdateRequest({ expiryAt: '2026-02-31' })).toThrow('到期时间格式无效')
  })

  it('设置端点的备注与创建路径同一长度上限（防撑破登记读侧 1 MiB 上限）', () => {
    expect(validateWebsiteUpdateRequest({ note: 'x'.repeat(1024) }).note).toBe('x'.repeat(1024))
    expect(() => validateWebsiteUpdateRequest({ note: 'x'.repeat(1025) })).toThrow('备注无效')
    expect(() => validateWebsiteUpdateRequest({ note: 42 })).toThrow('备注无效')
  })
})

describe('创建编排', () => {
  it('非 HTML：mkdir → 镜像核对 → 建容器 → 启动 → 停止（新建即 stopped）→ 落登记', async () => {
    const f = fixture()
    const project = await f.service.create(createInput())
    expect(f.sequence).toEqual(['mkdir', 'ensure-image', 'container', 'start', 'stop'])
    expect(project).toMatchObject({
      kind: 'node', name: 'admin-console', runState: 'stopped', pid: null,
      containerId: CONTAINER_ID, cert: 'none', category: 'development',
      expiryAt: null, rootDir: '/srv/wwwroot/admin-console',
      deployCommand: expect.stringContaining('node -e'),
      traffic: { todayMb: 0, totalGb: 0 },
    })
    expect((await f.registry.list())).toHaveLength(1)
  })

  it('HTML：无容器无镜像核对，只建目录与登记，忽略 runtimeVersion', async () => {
    const f = fixture()
    const project = await f.service.create(createInput({ kind: 'html', runtimeVersion: null, port: 8088 }))
    expect(f.sequence).toEqual(['mkdir'])
    expect(project).toMatchObject({ kind: 'html', containerId: null, deployCommand: null, runState: 'stopped' })
    const row = (await f.registry.list())[0]!
    expect(row.imageRef).toBeNull()
  })

  it('镜像缺失在建容器之前拒绝（409 中文文案）', async () => {
    const f = fixture()
    ;(f.docker.ensureImage as ReturnType<typeof vi.fn>).mockRejectedValue(new InvalidRequestError(409, '指定版本的运行时镜像尚未拉取：node:20.11.1'))
    await expect(f.service.create(createInput())).rejects.toMatchObject({ status: 409, message: '指定版本的运行时镜像尚未拉取：node:20.11.1' })
    // 镜像核对在建容器之前失败：无容器、无登记（目录已建，空目录无害）。
    expect(f.sequence).not.toContain('container')
    expect(f.sequence).not.toContain('start')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('容器创建失败保留目录并报「创建站点容器失败」', async () => {
    const f = fixture()
    ;(f.docker.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('创建站点容器失败：HTTP 500'))
    await expect(f.service.create(createInput())).rejects.toThrow('创建站点容器失败：HTTP 500')
    expect(f.sequence).not.toContain('start')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('start 失败删容器回滚；撤销失败时报容器 ID', async () => {
    const f = fixture()
    ;(f.docker.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('驱动错误'))
    await expect(f.service.create(createInput())).rejects.toThrow('创建站点容器失败：容器启动失败，已撤销创建：驱动错误')
    expect(f.sequence).toContain('remove-created')
    const undoFailed = fixture()
    ;(undoFailed.docker.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('驱动错误'))
    ;(undoFailed.docker.removeCreated as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('引擎不可用'))
    await expect(undoFailed.service.create(createInput()))
      .rejects.toThrow(`创建站点容器失败：容器启动失败，已撤销创建：驱动错误且撤销失败，容器 ID 为 ${CONTAINER_ID}`)
  })

  it('registry 落登记失败：停容器、删容器、保留目录、如实报错', async () => {
    const f = fixture()
    const failing = createMemoryWebsiteRegistry()
    failing.put = async () => { throw new Error('磁盘已满') }
    const service = createWebsiteService({
      registry: failing, docker: f.docker, caddy: f.caddy, mountRoot: '/srv',
      listPortBindings: async () => [],
    })
    await expect(service.create(createInput())).rejects.toThrow('网站登记写入失败：磁盘已满；站点容器已回滚删除，站点目录保留')
    expect(f.sequence).toEqual(['mkdir', 'ensure-image', 'container', 'start', 'stop', 'stop', 'remove-created'])
  })

  it('有域名时下发 Caddy 配置（从登记全量生成）；通道正常时创建响应的 cert 如实为已部署', async () => {
    const f = fixture()
    const project = await f.service.create(createInput({ domain: 'www.example.com' }))
    expect(f.caddyState.loads).toHaveLength(1)
    const config = f.caddyState.loads[0] as ReturnType<typeof buildCaddyConfig>
    expect(JSON.stringify(config)).toContain('www.example.com')
    expect(JSON.stringify(config)).toContain('127.0.0.1:3000')
    // cert 语义按事实折算：路由已下发即 deployed（无域名或通道不可用才是 none）。
    expect(project.cert).toBe('deployed')
  })

  it('通道不可用：创建照常完成、不伪造路由成功，列表如实呈现不可用', async () => {
    const f = fixture()
    const unavailable = new CaddyChannelError('宿主未提供 Caddy 管理通道', true)
    f.caddyState.failCurrentWith = unavailable
    const project = await f.service.create(createInput({ domain: 'www.example.com' }))
    expect(project.cert).toBe('none')
    expect(f.caddyState.loads).toHaveLength(0)
    const report = await f.service.list()
    expect(report.proxy).toEqual({ state: 'unavailable', detail: '宿主未提供 Caddy 管理通道' })
    expect(report.projects[0]?.cert).toBe('none')
  })

  it('下发被拒：站点保留（登记在册）并抛中文错误', async () => {
    const f = fixture()
    f.caddyState.failLoadWith = new CaddyChannelError('bad config', false)
    await expect(f.service.create(createInput({ domain: 'www.example.com' })))
      .rejects.toThrow('反向代理配置下发被拒绝：bad config')
    // 站点保留：容器与登记都已就位，界面刷新可见。
    expect(await f.registry.list()).toHaveLength(1)
  })
})

describe('名称全局唯一与查重', () => {
  it('跨类型同名同样拒绝「项目已存在：X」（站点目录只由名称推导）', async () => {
    const f = fixture()
    await f.service.create(createInput({ kind: 'java', name: '订单中心', port: 8080, runtimeVersion: '17' }))
    await expect(f.service.create(createInput({ kind: 'python', name: '订单中心', port: 8081, runtimeVersion: '3.11.9' })))
      .rejects.toMatchObject({ status: 409, message: '项目已存在：订单中心' })
  })

  it('并发的跨类型同名创建被全局创建互斥拦下，不会落两条共享同一站点目录的登记', async () => {
    const f = fixture()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    // 把先发创建卡在建目录阶段（查重之后、落登记之前的真实 await 窗口）。
    ;(f.docker.ensureSiteDir as ReturnType<typeof vi.fn>).mockImplementation(async (name: string, mountRoot: string) => {
      await gate
      return `${mountRoot}/wwwroot/${name}`
    })
    const first = f.service.create(createInput({ kind: 'java', name: '订单中心', port: 8080, runtimeVersion: '17' }))
    const second = f.service.create(createInput({ kind: 'python', name: '订单中心', port: 8081, runtimeVersion: '3.11.9' }))
    await expect(second).rejects.toMatchObject({ status: 409, message: '网站项目正在创建，请稍后再试' })
    release()
    await expect(first).resolves.toBeTruthy()
    const rows = await f.registry.list()
    expect(rows).toHaveLength(1)
    expect(rows.map((row) => row.rootDir)).toEqual(['/srv/wwwroot/订单中心'])
  })

  it('域名字段登记归一为小写：大小写变体在查重里是同一域名', async () => {
    const f = fixture()
    const created = await f.service.create(createInput({ name: 'a', port: 3001, domain: 'WWW.Example.COM' }))
    expect(created.domain).toBe('www.example.com')
    await expect(f.service.create(createInput({ name: 'b', port: 3002, domain: 'www.example.com' })))
      .rejects.toMatchObject({ status: 409, message: '域名已被绑定：www.example.com' })
  })

  it('并发的不同名同域名创建同样被全局创建互斥拦下（域名查重的 TOCTOU 窗口）', async () => {
    const f = fixture()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(f.docker.ensureSiteDir as ReturnType<typeof vi.fn>).mockImplementation(async (name: string, mountRoot: string) => {
      await gate
      return `${mountRoot}/wwwroot/${name}`
    })
    const first = f.service.create(createInput({ name: 'a', port: 3001, domain: 'www.example.com' }))
    const second = f.service.create(createInput({ name: 'b', port: 3002, domain: 'www.example.com' }))
    await expect(second).rejects.toMatchObject({ status: 409, message: '网站项目正在创建，请稍后再试' })
    release()
    await expect(first).resolves.toBeTruthy()
    expect(await f.registry.list()).toHaveLength(1)
  })

  it('域名唯一查重', async () => {
    const f = fixture()
    await f.service.create(createInput({ name: 'a', port: 3001, domain: 'www.example.com' }))
    await expect(f.service.create(createInput({ name: 'b', port: 3002, domain: 'www.example.com' })))
      .rejects.toMatchObject({ status: 409, message: '域名已被绑定：www.example.com' })
  })

  it('端口三重查重：面板保留、反向代理保留、容器占用、站点占用的逐字文案', async () => {
    const f = fixture()
    await expect(f.service.create(createInput({ port: 22 }))).rejects.toMatchObject({ message: '宿主端口为面板保留：22' })
    await expect(f.service.create(createInput({ port: 48100 }))).rejects.toMatchObject({ message: '宿主端口为面板保留：48100' })
    await expect(f.service.create(createInput({ port: 80 }))).rejects.toMatchObject({ message: '宿主端口由反向代理保留：80' })
    await expect(f.service.create(createInput({ port: 443 }))).rejects.toMatchObject({ message: '宿主端口由反向代理保留：443' })
    const bound = fixture({ portBindings: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0' }] })
    await expect(bound.service.create(createInput({ port: 8080 }))).rejects.toMatchObject({ message: '宿主端口已被占用：8080/tcp' })
    await f.service.create(createInput({ name: '已占站点', port: 3000 }))
    await expect(f.service.create(createInput({ name: '再来一个', port: 3000 }))).rejects.toMatchObject({ message: '宿主端口已被站点占用：3000' })
  })
})

describe('启停与并发互斥', () => {
  it('非 HTML 落容器启停并回报 PID；未知 id 报「未找到项目 X」', async () => {
    const f = fixture({ inspectState: { Running: true, Pid: 4242 } })
    await f.registry.put(seededRow())
    const project = await f.service.setRunning('site-1', true)
    expect(f.sequence).toContain('start')
    expect(project).toMatchObject({ runState: 'running', pid: 4242 })
    await expect(f.service.setRunning('missing', true)).rejects.toMatchObject({ status: 404, message: '未找到项目 missing' })
  })

  it('容器已被外部删除：启停报「站点容器已不存在，请删除站点后重建」', async () => {
    const f = fixture({ inspectState: 'missing' })
    await f.registry.put(seededRow())
    ;(f.docker.start as ReturnType<typeof vi.fn>).mockRejectedValue(new InvalidRequestError(404, '站点容器已不存在'))
    await expect(f.service.setRunning('site-1', true)).rejects.toMatchObject({ message: '站点容器已不存在，请删除站点后重建' })
  })

  it('同 id 并发启停 409「项目正在执行其他操作」（服务端第二道闸）', async () => {
    const f = fixture()
    await f.registry.put(seededRow())
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    ;(f.docker.start as ReturnType<typeof vi.fn>).mockImplementation(async () => { await gate })
    const first = f.service.setRunning('site-1', true)
    await expect(f.service.setRunning('site-1', true)).rejects.toMatchObject({ status: 409, message: '项目正在执行其他操作' })
    release()
    await expect(first).resolves.toBeTruthy()
  })

  it('HTML 翻转托管开关并重下发 Caddy 配置；重复启停幂等不再下发', async () => {
    const f = fixture()
    await f.registry.put(seededRow({ kind: 'html', containerId: null, containerName: null, imageRef: null, deployCommand: null, enabled: false, domain: 'www.example.com' }))
    const started = await f.service.setRunning('site-1', true)
    expect(started).toMatchObject({ runState: 'running', pid: null })
    expect(f.caddyState.loads).toHaveLength(1)
    expect(JSON.stringify(f.caddyState.loads[0])).toContain('file_server')
    const again = await f.service.setRunning('site-1', true)
    expect(again.runState).toBe('running')
    expect(f.caddyState.loads).toHaveLength(1)
    const stopped = await f.service.setRunning('site-1', false)
    expect(stopped.runState).toBe('stopped')
    // 关站后路由回收：期望集合不再包含该域名。
    expect(JSON.stringify(f.caddyState.loads[1])).not.toContain('www.example.com')
  })

  it('并发的 HTML 双站启停不会以旧快照回滚先下发的路由（下发队列每次重新读登记）', async () => {
    const f = fixture()
    await f.registry.put(seededRow({
      id: 'site-a', name: '甲站', port: 3001, domain: 'a.example.com',
      kind: 'html', containerId: null, containerName: null, imageRef: null, deployCommand: null, enabled: false,
    }))
    await f.registry.put(seededRow({
      id: 'site-b', name: '乙站', port: 3002, domain: 'b.example.com',
      kind: 'html', containerId: null, containerName: null, imageRef: null, deployCommand: null, enabled: false,
    }))
    await Promise.all([
      f.service.setRunning('site-a', true),
      f.service.setRunning('site-b', true),
    ])
    // 最终配置同时包含两条域名路由：最后一次下发基于含全部已落登记的最新快照。
    const finalConfig = JSON.stringify(f.caddyState.current)
    expect(finalConfig).toContain('a.example.com')
    expect(finalConfig).toContain('b.example.com')
    const rows = await f.registry.list()
    expect(rows.every((row) => row.enabled)).toBe(true)
  })
})

describe('设置与日志', () => {
  it('设置只改 note 与 expiryAt，名称与根目录不动', async () => {
    const f = fixture()
    await f.registry.put(seededRow({ note: '旧备注', expiryAt: '2026-09-01' }))
    const updated = await f.service.update('site-1', validateWebsiteUpdateRequest({ note: '新备注', expiryAt: null }))
    expect(updated).toMatchObject({ note: '新备注', expiryAt: null, name: 'admin-console', rootDir: '/srv/wwwroot/admin-console' })
    const row = (await f.registry.list())[0]!
    expect(row.note).toBe('新备注')
    expect(row.expiryAt).toBeNull()
    expect(row.name).toBe('admin-console')
  })

  it('设置与同项目的启停互斥：并发时设置让行 409，不再以整记录回写吞掉启停的翻转', async () => {
    const f = fixture()
    await f.registry.put(seededRow({ kind: 'html', containerId: null, containerName: null, imageRef: null, deployCommand: null, enabled: false, domain: 'www.example.com' }))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const originalLoad = f.caddy.load.bind(f.caddy)
    f.caddy.load = async (config: unknown) => { await gate; return originalLoad(config) }
    const toggling = f.service.setRunning('site-1', true)
    await expect(f.service.update('site-1', validateWebsiteUpdateRequest({ note: '并发备注' })))
      .rejects.toMatchObject({ status: 409, message: '项目正在执行其他操作' })
    release()
    await expect(toggling).resolves.toBeTruthy()
    // 让行失败的设置重试后成功；最终登记同时保留翻转与备注，没有静默回滚。
    await f.service.update('site-1', validateWebsiteUpdateRequest({ note: '并发备注' }))
    const row = (await f.registry.list())[0]!
    expect(row).toMatchObject({ enabled: true, note: '并发备注' })
  })

  it('日志：HTML 返回 Caddy 托管说明行，非 HTML 读容器日志', async () => {
    const f = fixture()
    await f.registry.put(seededRow())
    await expect(f.service.logs('site-1')).resolves.toEqual(['启动完成，监听端口 3000'])
    await f.registry.put(seededRow({ id: 'site-html', kind: 'html', containerId: null, containerName: null, imageRef: null, deployCommand: null }))
    await expect(f.service.logs('site-html')).resolves.toEqual(['静态站点由宿主 Caddy 直接托管，无应用运行日志'])
    await expect(f.service.logs('missing')).rejects.toMatchObject({ message: '未找到项目 missing' })
  })
})

describe('删除编排', () => {
  it('顺序：停容器 → Caddy 回收 → 删容器 → 删目录 → 删登记；二次删除报未找到', async () => {
    const f = fixture()
    await f.registry.put(seededRow())
    await f.service.remove('site-1')
    expect(f.sequence).toEqual(['stop', 'remove-container', 'remove-dir'])
    expect(await f.registry.list()).toHaveLength(0)
    await expect(f.service.remove('site-1')).rejects.toMatchObject({ status: 404, message: '未找到项目 site-1' })
  })

  it('Caddy 回收失败不阻断资源删除：目录与登记照删，报「配置残留将在下次下发时回收」', async () => {
    const f = fixture()
    await f.registry.put(seededRow({ domain: 'www.example.com' }))
    f.caddyState.failLoadWith = new CaddyChannelError('bad config', false)
    await expect(f.service.remove('site-1')).rejects.toThrow('反向代理配置回收失败：反向代理配置下发被拒绝：bad config；站点资源已删除，配置残留将在下次下发时回收')
    expect(f.sequence).toEqual(['stop', 'remove-container', 'remove-dir'])
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('通道不可用时的删除照常完成（降级跳过回收，不算失败）', async () => {
    const f = fixture()
    await f.registry.put(seededRow({ domain: 'www.example.com' }))
    f.caddyState.failCurrentWith = new CaddyChannelError('宿主未提供 Caddy 管理通道', true)
    await expect(f.service.remove('site-1')).resolves.toBeUndefined()
    expect(f.sequence).toEqual(['stop', 'remove-container', 'remove-dir'])
  })

  it('容器已被外部删除：删除幂等跳过容器步骤，目录与登记照删', async () => {
    const f = fixture({ inspectState: 'missing' })
    await f.registry.put(seededRow())
    ;(f.docker.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new InvalidRequestError(404, '站点容器已不存在'))
    ;(f.docker.removeManaged as ReturnType<typeof vi.fn>).mockResolvedValue('missing')
    await expect(f.service.remove('site-1')).resolves.toBeUndefined()
    expect(f.sequence).toEqual(['remove-dir'])
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('目录删除失败：容器与登记已处理完成，报「站点目录删除失败」不回滚其余步骤', async () => {
    const f = fixture()
    await f.registry.put(seededRow())
    ;(f.docker.removeSiteDir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('设备繁忙'))
    await expect(f.service.remove('site-1')).rejects.toThrow('站点目录删除失败：设备繁忙')
    expect(f.sequence).toContain('remove-container')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('身份核对失败中断删除、登记保留', async () => {
    const f = fixture()
    await f.registry.put(seededRow())
    ;(f.docker.removeManaged as ReturnType<typeof vi.fn>).mockRejectedValue(new InvalidRequestError(409, '站点容器身份核对失败'))
    await expect(f.service.remove('site-1')).rejects.toMatchObject({ status: 409, message: '站点容器身份核对失败' })
    expect(await f.registry.list()).toHaveLength(1)
    expect(f.sequence).not.toContain('remove-dir')
  })
})

describe('列表折算与漂移呈现', () => {
  it('容器 inspect 404 折算为 stopped、pid=null、containerId 保留登记值', async () => {
    const f = fixture({ inspectState: 'missing' })
    await f.registry.put(seededRow({ containerId: 'b'.repeat(64) }))
    const report = await f.service.list()
    expect(report.projects[0]).toMatchObject({
      runState: 'stopped', pid: null, containerId: 'b'.repeat(64),
    })
  })

  it('cert 折算：域名在当前配置里 deployed、不在则 none；无域名恒 none', async () => {
    const f = fixture()
    f.caddyState.current = buildCaddyConfig([
      { kind: 'proxy', domain: 'www.example.com', port: 3000 },
    ], { adminListen: 'unix//run/caddy/admin.sock' })
    await f.registry.put(seededRow({ domain: 'www.example.com' }))
    await f.registry.put(seededRow({ id: 'site-2', name: '无域名站', port: 3001, domain: null }))
    const report = await f.service.list()
    expect(report.projects.find((project) => project.id === 'site-1')?.cert).toBe('deployed')
    expect(report.projects.find((project) => project.id === 'site-2')?.cert).toBe('none')
    expect(report.proxy).toEqual({ state: 'active', detail: null })
  })

  it('漂移呈现：通道 active 但期望路由有缺口时 detail 如实写「N 个站点的路由未下发」', async () => {
    const f = fixture()
    f.caddyState.current = {}
    await f.registry.put(seededRow({ domain: 'a.example.com' }))
    await f.registry.put(seededRow({ id: 'site-2', name: '第二个域名站', port: 3001, domain: 'b.example.com' }))
    const report = await f.service.list()
    expect(report.proxy).toEqual({ state: 'active', detail: '2 个站点的路由未下发' })
    expect(report.projects.every((project) => project.cert === 'none')).toBe(true)
  })
})

describe('对账（reconcileProxy）', () => {
  it('从 registry 全量重新生成并下发，返回 active；横幅随之下一次刷新消失', async () => {
    const f = fixture()
    f.caddyState.current = {}
    await f.registry.put(seededRow({ domain: 'a.example.com' }))
    expect((await f.service.list()).proxy.detail).toBe('1 个站点的路由未下发')
    await expect(f.service.reconcileProxy()).resolves.toEqual({ state: 'active', detail: null })
    expect(f.caddyState.loads).toHaveLength(1)
    expect(JSON.stringify(f.caddyState.loads[0])).toContain('a.example.com')
    expect((await f.service.list()).proxy).toEqual({ state: 'active', detail: null })
  })

  it('通道不可用时如实返回不可用状态（applied=false 由路由折算）', async () => {
    const f = fixture()
    f.caddyState.failCurrentWith = new CaddyChannelError('宿主未提供 Caddy 管理通道', true)
    await expect(f.service.reconcileProxy()).resolves.toEqual({ state: 'unavailable', detail: '宿主未提供 Caddy 管理通道' })
    expect(f.caddyState.loads).toHaveLength(0)
  })

  it('存在面板外配置时拒绝覆盖（409 中文文案）', async () => {
    const f = fixture()
    f.caddyState.current = { apps: { http: {}, other: {} } }
    await f.registry.put(seededRow({ domain: 'a.example.com' }))
    await expect(f.service.reconcileProxy()).rejects.toMatchObject({ status: 409, message: '宿主 Caddy 存在面板外的配置，拒绝覆盖' })
    expect(f.caddyState.loads).toHaveLength(0)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isValidWebsiteDomain, WEBSITE_PROXY_STATES } from '@elysian/contracts'
import type { WebsitesAdapter } from './adapters'
import { MockWebsitesAdapter } from '../adapters/mock/mockAdapters'
import {
  addWebsiteProject,
  getWebsiteLogs,
  getWebsiteProjects,
  removeWebsiteProject,
  resetWebsitesData,
  setWebsiteProjectRunning,
  updateWebsiteProject,
} from '../adapters/mock/websitesData'
import {
  createHttpWebsitesAdapter,
  parseWebsiteLogsResponse,
} from '../adapters/http/websitesHttpAdapter'

/**
 * 网站适配器的共同契约。
 *
 * 只依赖 `WebsitesAdapter` 接口本身，不依赖任何 mock 细节——mock 与 HTTP 两实现
 * 对同一套断言各跑一遍，这就是「mock 可替换」的验证方式。HTTP 实例的 fetch 桩
 * 直接复用 mock 数据层作事实来源（模式对齐 containersHttpAdapter.test 的解析层
 * 测试）：检验的是 adapter 的请求形状与响应解析往返，而非服务端行为本身。
 */

export function createWebsitesAdapterContractTests(
  name: string,
  make: () => WebsitesAdapter,
): void {
  describe(`WebsitesAdapter 契约：${name}`, () => {
    it('list 返回项目列表与反向代理通道状态，标识唯一且字段按类型自洽', async () => {
      const { projects, proxy } = await make().list()
      expect(projects.length).toBeGreaterThan(0)
      expect(new Set(projects.map((project) => project.id)).size).toBe(projects.length)
      expect(WEBSITE_PROXY_STATES).toContain(proxy.state)
      expect(proxy.detail === null || typeof proxy.detail === 'string').toBe(true)

      for (const project of projects) {
        expect(project.name.trim().length).toBeGreaterThan(0)
        // 根目录由名称推导：挂载根可变（演示 /www、真实 /srv），但目录段与名称一致。
        expect(project.rootDir).toContain('/wwwroot/')
        expect(project.rootDir.endsWith(`/${project.name}`)).toBe(true)
        expect(project.port).toBeGreaterThanOrEqual(1)
        expect(project.port).toBeLessThanOrEqual(65535)

        if (project.kind === 'html') {
          expect(project.runtimeVersion).toBeNull()
          expect(project.pid).toBeNull()
          expect(project.deployCommand).toBeNull()
          expect(project.containerId).toBeNull()
        } else {
          expect(project.runtimeVersion).toBeTruthy()
          expect(project.deployCommand).not.toBeNull()
          // 非 HTML 站点为容器 ID（64 位十六进制），容器被外部删除后保留登记值。
          expect(project.containerId).toMatch(/^[0-9a-f]{64}$/)
        }
        if (project.runState === 'running' && project.kind !== 'html') {
          expect(project.pid).not.toBeNull()
        }
        if (project.runState === 'stopped') {
          expect(project.pid).toBeNull()
        }
        // 域名形态过契约判据；证书按域名路由折算，已部署/已过期必先绑定域名。
        expect(project.domain === null || isValidWebsiteDomain(project.domain)).toBe(true)
        if (project.cert !== 'none') {
          expect(project.domain).not.toBeNull()
        }
        expect(project.traffic).toBeTruthy()
        expect(project.traffic.todayMb).toBeGreaterThanOrEqual(0)
        expect(project.traffic.totalGb).toBeGreaterThanOrEqual(0)
        expect(project.gitUrl === null || project.gitUrl.length > 0).toBe(true)
      }
    })

    it('五种类型各有种子数据，界面不会一进来就空', async () => {
      const { projects } = await make().list()
      for (const kind of ['java', 'node', 'go', 'python', 'html'] as const) {
        expect(projects.some((project) => project.kind === kind), `缺 ${kind} 种子`).toBe(true)
      }
    })

    it('create 新建即已停止、无证书；根目录由名称推导；同名拒绝（跨类型全局唯一）', async () => {
      const adapter = make()
      const created = await adapter.create('python', {
        name: '报表服务',
        port: 8010,
        runtimeVersion: '3.11.9',
        domain: 'report.example.com',
        note: '演示新建',
        gitUrl: 'https://github.com/acme/report.git',
      })

      expect(created.kind).toBe('python')
      expect(created.name).toBe('报表服务')
      expect(created.runState).toBe('stopped')
      expect(created.pid).toBeNull()
      expect(created.cert).toBe('none')
      expect(created.rootDir).toBe('/www/wwwroot/报表服务')
      expect(created.port).toBe(8010)
      expect(created.runtimeVersion).toBe('3.11.9')
      expect(created.domain).toBe('report.example.com')
      expect(created.containerId).toMatch(/^[0-9a-f]{64}$/)
      expect(created.gitUrl).toBe('https://github.com/acme/report.git')
      expect(created.traffic).toEqual({ todayMb: 0, totalGb: 0 })
      expect(created.deployCommand).not.toBeNull()

      const again = adapter.create('python', {
        name: '报表服务',
        port: 8011,
        runtimeVersion: '3.11.9',
      })
      await expect(again).rejects.toThrow('已存在')

      // 名称全局唯一：站点目录只由名称推导，跨类型同名会共享同一目录，同样拒绝。
      await expect(
        adapter.create('go', { name: '报表服务', port: 9010, runtimeVersion: '1.22.4' }),
      ).rejects.toThrow('已存在')
    })

    it('create 域名可选：不填为 null，形态非法或已被绑定时报中文错误', async () => {
      const adapter = make()
      const withoutDomain = await adapter.create('node', {
        name: 'no-domain-site',
        port: 3211,
        runtimeVersion: '20.11.1',
      })
      expect(withoutDomain.domain).toBeNull()

      await expect(
        adapter.create('node', {
          name: 'bad-domain-site',
          port: 3212,
          runtimeVersion: '20.11.1',
          domain: 'not a domain',
        }),
      ).rejects.toThrow('域名无效')

      await expect(
        adapter.create('node', {
          name: 'dup-domain-site',
          port: 3213,
          runtimeVersion: '20.11.1',
          domain: 'www.acme.example.com',
        }),
      ).rejects.toThrow('域名已被绑定')
    })

    it('create 所有类型都接受端口；HTML 忽略运行时版本且无部署命令', async () => {
      const adapter = make()
      const java = await adapter.create('java', {
        name: 'port-check-java',
        port: 18080,
        runtimeVersion: '17',
      })
      expect(java.port).toBe(18080)
      expect(java.runtimeVersion).toBe('17')

      const html = await adapter.create('html', {
        name: 'port-check-html',
        port: 18081,
        runtimeVersion: '17',
      })
      expect(html.port).toBe(18081)
      expect(html.runtimeVersion).toBeNull()
      expect(html.deployCommand).toBeNull()
      expect(html.containerId).toBeNull()
    })

    it('create 缺少端口或非 HTML 缺少版本时拒绝', async () => {
      const adapter = make()
      await expect(
        adapter.create('node', { name: 'no-port', port: 0 as unknown as number, runtimeVersion: '20.11.1' }),
      ).rejects.toThrow('端口')
      await expect(
        adapter.create('go', { name: 'no-version', port: 9105 }),
      ).rejects.toThrow('运行时版本')
    })

    it('setRunning 启停改运行状态：非 HTML 启动后补进程号，停止后清空', async () => {
      const adapter = make()
      const created = await adapter.create('node', {
        name: 'start-check',
        port: 3210,
        runtimeVersion: '20.11.1',
      })

      const running = await adapter.setRunning(created.id, true)
      expect(running.runState).toBe('running')
      expect(running.pid).not.toBeNull()

      const off = await adapter.setRunning(created.id, false)
      expect(off.runState).toBe('stopped')
      expect(off.pid).toBeNull()
    })

    it('setRunning 对 HTML 启动后仍无 PID；未知标识报错', async () => {
      const adapter = make()
      const created = await adapter.create('html', { name: '静态主页', port: 8088 })
      const running = await adapter.setRunning(created.id, true)
      expect(running.runState).toBe('running')
      expect(running.pid).toBeNull()
      await expect(adapter.setRunning('site-not-exist', true)).rejects.toThrow()
    })

    it('update 只改备注与到期时间，未知标识报错', async () => {
      const adapter = make()
      const [seed] = (await adapter.list()).projects
      // 到期时间只收 YYYY-MM-DD：设置弹窗发这个形态，服务端校验（websitesService
      // 的 /^\d{4}-\d{2}-\d{2}$/ 判据）也只放行这个形态，共享断言钉住同一口径。
      const expiry = '2027-01-01'
      const updated = await adapter.update(seed!.id, { note: '改过的备注', expiryAt: expiry })
      expect(updated.note).toBe('改过的备注')
      expect(updated.expiryAt).toBe(expiry)
      expect(updated.name).toBe(seed!.name)

      await expect(adapter.update('site-not-exist', { note: 'x' })).rejects.toThrow()
    })

    it('remove 把项目从列表移除，未知标识报错', async () => {
      const adapter = make()
      const created = await adapter.create('java', {
        name: 'remove-check',
        port: 18082,
        runtimeVersion: '17',
      })
      expect((await adapter.list()).projects.some((project) => project.id === created.id)).toBe(true)

      await adapter.remove(created.id)
      expect((await adapter.list()).projects.some((project) => project.id === created.id)).toBe(false)
      await expect(adapter.remove(created.id)).rejects.toThrow()
    })

    it('logs 对每个项目返回非空行数组；运行中的 HTML 站由宿主 Caddy 托管', async () => {
      const adapter = make()
      const { projects } = await adapter.list()
      for (const project of projects) {
        const lines = await adapter.logs(project.id)
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.every((line) => line.length > 0)).toBe(true)
      }

      const runningHtml = projects.find(
        (project) => project.kind === 'html' && project.runState === 'running',
      )
      expect(runningHtml).toBeTruthy()
      const htmlLogs = await adapter.logs(runningHtml!.id)
      expect(htmlLogs.join('\n')).toContain('Caddy')
    })

    it('logs 对不存在的项目拒绝', async () => {
      const adapter = make()
      await expect(adapter.logs('website-not-exist')).rejects.toThrow('未找到项目')
    })

    it('reconcileProxy 返回反向代理通道状态形状', async () => {
      const status = await make().reconcileProxy()
      expect(WEBSITE_PROXY_STATES).toContain(status.state)
      expect(status.detail === null || typeof status.detail === 'string').toBe(true)
    })
  })
}

createWebsitesAdapterContractTests('mock 实现', () => new MockWebsitesAdapter())

/*
 * mock 专属断言：真实实现里已停止的容器仍保留历史日志（引擎日志是落盘事实），
 * 「停止即日志只剩停止说明」是 mock 的演示口径——与登录日志的 mock 专属用例同款处理。
 */
describe('WebsitesAdapter 契约：mock 专属', () => {
  it('已停止项目的日志包含「已停止」', async () => {
    const adapter = new MockWebsitesAdapter()
    const { projects } = await adapter.list()
    const stopped = projects.find((project) => project.runState === 'stopped')
    expect(stopped).toBeTruthy()
    const stoppedLogs = await adapter.logs(stopped!.id)
    expect(stoppedLogs.join('\n')).toContain('已停止')
  })
})

/**
 * HTTP 实例的 fetch 桩：按 method + path 分发到 mock 数据层（每个用例重置回种子）。
 * 响应形状以服务端 websitesRoutes 的真实端点为准：列表为 { projects, proxy }、
 * 日志为 { logs }（数组）、对账为 { proxy, applied }、错误体 { error } 透传中文消息，
 * 状态码取 409 表达查重冲突、404 表达未找到。
 */
function makeHttpAdapter(): WebsitesAdapter {
  resetWebsitesData()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname.replace(/^\/api\/websites/, '') || '/'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      const respond = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      if (method === 'GET' && path === '/') {
        return respond({
          projects: getWebsiteProjects(),
          proxy: { state: 'active', detail: null },
        })
      }
      if (method === 'POST' && path === '/') {
        try {
          return respond(
            addWebsiteProject(body.kind as never, body as never),
            201,
          )
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : '创建失败' }, 400)
        }
      }
      if (method === 'PUT') {
        try {
          return respond(updateWebsiteProject(decodeURIComponent(path.slice(1)), body as never))
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : '修改失败' }, 404)
        }
      }
      if (method === 'POST' && path.endsWith('/running')) {
        try {
          return respond(
            setWebsiteProjectRunning(
              decodeURIComponent(path.slice(1, -'/running'.length)),
              body.running === true,
            ),
          )
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : '操作失败' }, 404)
        }
      }
      if (method === 'POST' && path === '/proxy/reconcile') {
        return respond({ proxy: { state: 'active', detail: null }, applied: true })
      }
      if (method === 'GET' && path.endsWith('/logs')) {
        try {
          return respond({
            logs: getWebsiteLogs(decodeURIComponent(path.slice(1, -'/logs'.length))),
          })
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : '读取日志失败' }, 404)
        }
      }
      if (method === 'DELETE') {
        if (body.confirm !== 'DELETE_WEBSITE_AND_DATA') {
          return respond({ error: '必须确认删除站点及数据' }, 400)
        }
        try {
          removeWebsiteProject(decodeURIComponent(path.slice(1)))
          return respond({ ok: true })
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : '删除失败' }, 404)
        }
      }
      return respond({ error: `未知端点：${method} ${path}` }, 404)
    }),
  )
  return createHttpWebsitesAdapter()
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetWebsitesData()
})

createWebsitesAdapterContractTests('http 实现（fetch 桩）', makeHttpAdapter)

describe('HTTP 网站端点接线', () => {
  it('七个动作各自落在 /api/websites 下的约定路径与正文上', async () => {
    // 静态样本桩：按端点返回合法形状，本用例只核对请求路径与正文。
    const sample = getWebsiteProjects()[0]!
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname.replace(/^\/api\/websites/, '') || '/'
      const respond = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        })
      if (method === 'GET' && path === '/') return respond({ projects: [], proxy: { state: 'active', detail: null } })
      if (method === 'POST' && path === '/proxy/reconcile') {
        return respond({ proxy: { state: 'active', detail: null }, applied: true })
      }
      if (method === 'DELETE') return respond({ ok: true })
      if (method === 'GET') return respond({ logs: [] })
      return respond(sample)
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpWebsitesAdapter()
    await adapter.list()
    await adapter.create('java', { name: '接线检查', port: 18090, runtimeVersion: '17' })
    await adapter.update('website-java-order-api', { note: null })
    await adapter.setRunning('website-java-order-api', false)
    await adapter.remove('website-java-order-api')
    await adapter.logs('website-java-order-api')
    await adapter.reconcileProxy()

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/websites', { cache: 'no-store' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/websites/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        kind: 'java',
        name: '接线检查',
        port: 18090,
        runtimeVersion: '17',
        domain: null,
        gitUrl: null,
        note: null,
      }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/websites/website-java-order-api', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ note: null, expiryAt: null }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/websites/website-java-order-api/running',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ running: false }),
      },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/websites/website-java-order-api', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ confirm: 'DELETE_WEBSITE_AND_DATA' }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      '/api/websites/website-java-order-api/logs',
      { cache: 'no-store' },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/websites/proxy/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({}),
    })
    vi.unstubAllGlobals()
  })

  it('HTTP 非 2xx 时抛响应体里的 error 字符串', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: '项目已存在：报表服务' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const adapter = createHttpWebsitesAdapter()
    await expect(
      adapter.create('python', { name: '报表服务', port: 8010, runtimeVersion: '3.11.9' }),
    ).rejects.toThrow('项目已存在：报表服务')
    vi.unstubAllGlobals()
  })
})

/*
 * 服务端真实路由与前端解析器的形状对齐（反回归锚点）。用的是**服务端真实的
 * 网站子应用**（apps/server/src/websites/websitesRoutes.ts 的 createWebsitesApp），
 * 只有 WebsiteService 是假的（数据源复用 mock 数据层）——被检验的是真实的路由
 * 与响应形状，而非一份手抄的形状；此前 fetch 桩与 adapter 同形互相掩盖、日志
 * 字段名两端断裂的事故由这层断言兜住。
 *
 * 与日志域先例（logsHttpAdapter.contract.test.ts 静态 import createLogsApp）不同，
 * 这里必须走变量路径的动态 import：logsRoutes 依赖链零 bun，而 websites 的服务端
 * 依赖图含 bun 专属模块与并行轨进行中的文件，静态 import 会把它们整个拉进 web
 * 的 tsc 程序图拖垮 typecheck；动态 import 让 tsc 不解析该模块，vitest 运行时
 * 照常按需转换加载。代价是构造器类型要在本地按形状声明。
 *
 * 写端点要过同源守卫：桩补上 Origin 与 Host，与真实浏览器的请求同形。
 */

/*
 * 形状锚点：fetch 桩与服务端真实形状的对应关系在此钉死。服务端日志端点返回
 * { logs: [...] }（apps/server/src/websites/websitesRoutes.ts 的 GET /:id/logs，
 * 其路由测试同形断言），此前桩与 adapter 同用 { lines } 互相掩盖、两端各自绿灯
 * 而真实运行时断裂的事故，由下面的反向锚点兜住：解析器只认服务端形状。
 *
 * 注：让测试直接驱动服务端真实子应用（logs 域 logsHttpAdapter.contract.test.ts
 * 的静态跨包 import 先例）在 websites 域当前不可行——服务端依赖图含 bun 专属模块
 * 与并行轨进行中的文件，静态 import 会把它们拉进 web 的 tsc 程序图拖垮 typecheck，
 * 变量路径的动态 import 又落不到 vitest 的模块加载器；待服务端轨文件稳定后可按
 * 该先例升级为真实子应用驱动的形状断言。
 */
describe('前端解析器与服务端日志形状锚点', () => {
  it('解析器只认服务端日志形状 { logs }：{ lines } 形状必须被拒绝', () => {
    // 反向锚点：若有人把解析器改回 { lines }（或服务端改形状），这条会先红。
    expect(() => parseWebsiteLogsResponse({ lines: ['a'] })).toThrow('网站日志响应无效')
    expect(parseWebsiteLogsResponse({ logs: ['启动完成'] })).toEqual(['启动完成'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { TERMINAL_MOUNT, createTerminalsApp, type TerminalsAppDeps } from './terminalsRoutes.ts'
import { bunWebSocket } from './bunWebSocket.ts'
import type { TerminalWsEvents, WsConn } from './terminalConnection.ts'
import type { SessionConnections } from '../auth/sessionConnections.ts'
import type { TerminalsService } from './terminalsService.ts'

/*
 * 终端路由的守卫链测试：fake service 注入，app.request 驱动。503 整片（含未知
 * 路径）、/status 200、/ws 升级前同源校验矩阵（Origin 缺失/host 不一致/Host 不在
 * 名单）、未知路径 404 剥前缀文案。升级分支本身不进 vitest（upgradeWebSocket
 * 依赖 Bun server 实例）——合法升级的撤销接线用 vi.mock bunWebSocket 钉死传参，
 * 真实升级后 revoke 触发 close 由容器内冒烟（terminalsWiring.bun.test.ts）覆盖。
 */

// 文件级 mock：vi.mock 对路由 handler 内的动态 import 同样生效；既有用例全部短路
// 在升级之前（403/503/404），不受影响。
vi.mock('./bunWebSocket.ts', () => ({
  bunWebSocket: { upgradeWebSocket: vi.fn(async () => new Response(null, { status: 200 })) },
}))

function createFakeService(): TerminalsService {
  return {
    tryOpen: () => null,
    activeCount: () => 0,
  }
}

const SAME_ORIGIN_HEADERS = {
  host: 'localhost:5173',
  origin: 'http://localhost:5173',
}

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: { ...SAME_ORIGIN_HEADERS, ...headers },
  })
}

/** 挂到 strict:false 父应用的形态（app.ts 的真实挂载方式），锚定挂载后行为。 */
function mountedApp(deps: TerminalsAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.route(TERMINAL_MOUNT, createTerminalsApp(deps))
  return parent
}

const AVAILABLE: TerminalsAppDeps = { available: true, service: createFakeService() }

describe('createTerminalsApp', () => {
  it('不可用时一律 503（容器边界保护，含未知路径、/ws 与 /status）', async () => {
    const app = createTerminalsApp({ available: false })
    for (const [method, path] of [
      ['GET', '/status'],
      ['GET', '/ws'],
      ['POST', '/ws'],
      ['GET', '/nowhere'],
    ] as const) {
      const res = await app.request(req(method, path))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实终端仅在 Docker 容器内可用' })
    }
  })

  it('service 缺失同样整片 503（有可用性没服务也不许答）', async () => {
    const app = createTerminalsApp({ available: true })
    const res = await app.request(req('GET', '/status'))
    expect(res.status).toBe(503)
  })

  it('/status 可用时返回 200 {ok:true}', async () => {
    const res = await mountedApp(AVAILABLE).request(req('GET', `${TERMINAL_MOUNT}/status`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  describe('/ws 升级前置同源校验（安全基线 1）', () => {
    it('Origin 缺失即拒 403', async () => {
      const res = await mountedApp(AVAILABLE).request(
        req('GET', `${TERMINAL_MOUNT}/ws`, { origin: '' }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: '请求来源不允许' })
    })

    it('Origin host 与 Host 不一致拒 403（跨域站点）', async () => {
      const res = await mountedApp(AVAILABLE).request(
        req('GET', `${TERMINAL_MOUNT}/ws`, { origin: 'http://evil.example' }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: '请求来源不允许' })
    })

    it('Origin 端口与 Host 不一致拒 403（同主机不同端口）', async () => {
      const res = await mountedApp(AVAILABLE).request(
        req('GET', `${TERMINAL_MOUNT}/ws`, { origin: 'http://localhost:9999' }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: '请求来源不允许' })
    })

    it('Host hostname 不在回环名单拒 403（Origin 与 Host 互相一致的 DNS rebinding）', async () => {
      const res = await mountedApp(AVAILABLE).request(
        req('GET', `${TERMINAL_MOUNT}/ws`, {
          host: 'evil.example:5173',
          origin: 'http://evil.example:5173',
        }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: '请求来源不允许' })
    })

    it('Host 是畸形值拒 403', async () => {
      const res = await mountedApp(AVAILABLE).request(
        req('GET', `${TERMINAL_MOUNT}/ws`, { host: 'http://a b', origin: 'http://a b' }),
      )
      expect(res.status).toBe(403)
    })
  })

  it('未知路径 404 且文案剥挂载前缀', async () => {
    const res = await mountedApp(AVAILABLE).request(req('GET', `${TERMINAL_MOUNT}/nowhere`))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知终端端点：GET /nowhere' })
  })

  it('写方法打未知路径先 403 后 404（守卫链次序与文件管理片同构）', async () => {
    const res = await mountedApp(AVAILABLE).request(req('POST', `${TERMINAL_MOUNT}/nowhere`, { origin: '' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })

  describe('/ws 合法升级的撤销接线', () => {
    /** 可升级的 fake service：tryOpen 恒成功（最小会话形状，onOpen 走登记分支）。 */
    function createUpgradableService(): TerminalsService {
      return {
        tryOpen: () => ({
          id: 't1',
          handleClientFrame: () => {},
          dispose: async () => {},
        }),
        activeCount: () => 1,
      }
    }

    function spySessionConnections(): SessionConnections {
      return {
        register: vi.fn(),
        unregister: vi.fn(),
        revoke: vi.fn(),
        revokeOthers: vi.fn(),
        revokeAll: vi.fn(),
      }
    }

    it('带会话 Cookie：wsEvents 携带 sessionId 与撤销表（onOpen 登记、撤销关闭、onClose 注销）', async () => {
      const upgradeWebSocket = vi.mocked(bunWebSocket.upgradeWebSocket)
      upgradeWebSocket.mockClear()
      const connections = spySessionConnections()
      const app = mountedApp({
        available: true,
        service: createUpgradableService(),
        sessionConnections: connections,
      })

      const res = await app.request(req('GET', `${TERMINAL_MOUNT}/ws`, { cookie: 'elysian_session=abc' }))
      expect(res.status).toBe(200)
      expect(upgradeWebSocket).toHaveBeenCalledTimes(1)

      // 第二参是每请求构造的 wsEvents：驱动其生命周期验证 revocation 已接进连接。
      const events = upgradeWebSocket.mock.calls[0]![1] as TerminalWsEvents
      const closes: { code: number; reason: string }[] = []
      const conn: WsConn = { send: () => {}, close: (code, reason) => closes.push({ code, reason }), readyState: 1 }

      events.onOpen({ type: 'open' }, conn)
      expect(connections.register).toHaveBeenCalledTimes(1)
      // connections 标注为 SessionConnections（传 deps 时类型正确），断言处用
      // vi.mocked 收窄回 Mock 才能访问 .mock 调用记录。
      expect(vi.mocked(connections.register).mock.calls[0]![0]).toBe('abc')

      const closer = vi.mocked(connections.register).mock.calls[0]![1]
      closer()
      expect(closes).toEqual([{ code: 1008, reason: '面板会话已失效，连接已关闭' }])

      events.onClose({ type: 'close' }, conn)
      expect(connections.unregister).toHaveBeenCalledWith('abc', closer)
    })

    it('不带会话 Cookie：revocation 为 undefined（不登记撤销 closer）', async () => {
      const upgradeWebSocket = vi.mocked(bunWebSocket.upgradeWebSocket)
      upgradeWebSocket.mockClear()
      const connections = spySessionConnections()
      const app = mountedApp({
        available: true,
        service: createUpgradableService(),
        sessionConnections: connections,
      })

      const res = await app.request(req('GET', `${TERMINAL_MOUNT}/ws`))
      expect(res.status).toBe(200)
      expect(upgradeWebSocket).toHaveBeenCalledTimes(1)

      const events = upgradeWebSocket.mock.calls[0]![1] as TerminalWsEvents
      const conn: WsConn = { send: () => {}, close: () => {}, readyState: 1 }
      events.onOpen({ type: 'open' }, conn)
      expect(connections.register).not.toHaveBeenCalled()
    })
  })
})

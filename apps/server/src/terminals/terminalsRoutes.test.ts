import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { TERMINAL_MOUNT, createTerminalsApp, type TerminalsAppDeps } from './terminalsRoutes.ts'
import type { TerminalsService } from './terminalsService.ts'

/*
 * 终端路由的守卫链测试：fake service 注入，app.request 驱动。503 整片（含未知
 * 路径）、/status 200、/ws 升级前同源校验矩阵（Origin 缺失/host 不一致/Host 不在
 * 名单）、未知路径 404 剥前缀文案。升级分支本身不进 vitest（upgradeWebSocket
 * 依赖 Bun server 实例），由 bun 冒烟覆盖——这是防「假满足」的前置短路形态的
 * 代价与纪律。
 */

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
})

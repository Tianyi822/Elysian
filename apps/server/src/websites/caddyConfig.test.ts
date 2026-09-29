import { describe, expect, it } from 'vitest'
import { buildCaddyConfig, hasForeignConfig, managedHosts, missingHosts, type CaddyManagedSite } from './caddyConfig.ts'

const ADMIN_LISTEN = 'unix//run/caddy/admin.sock'

describe('buildCaddyConfig 生成形状', () => {
  it('admin 与 server 段固定，路由按域名排序（同输入同输出）', () => {
    const sites: CaddyManagedSite[] = [
      { kind: 'proxy', domain: 'zeta.example.com', port: 8080 },
      { kind: 'static', domain: 'alpha.example.com', root: '/srv/wwwroot/alpha' },
      { kind: 'proxy', domain: 'mid.example.com', port: 3000 },
    ]
    const config = buildCaddyConfig(sites, { adminListen: ADMIN_LISTEN })
    expect(config.admin).toEqual({ listen: ADMIN_LISTEN })
    expect(config.logging).toEqual({ logs: { default: { level: 'WARN' } } })
    const server = (config.apps as { http: { servers: Record<string, unknown> } }).http.servers.elysian as {
      listen: string[]
      routes: { match: { host: string[] }[]; handle: unknown[] }[]
    }
    expect(server.listen).toEqual([':80', ':443'])
    expect(server.routes.map((route) => route.match[0]?.host[0])).toEqual([
      'alpha.example.com', 'mid.example.com', 'zeta.example.com',
    ])
    expect(server.routes[0]?.handle).toEqual([{ handler: 'file_server', root: '/srv/wwwroot/alpha' }])
    expect(server.routes[1]?.handle).toEqual([
      { handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3000' }] },
    ])
    // 确定性：两次生成逐字相同。
    expect(buildCaddyConfig(sites, { adminListen: ADMIN_LISTEN })).toEqual(config)
  })

  it('容器站 reverse_proxy 到 127.0.0.1 同号端口，HTML 站 file_server root 为站点目录', () => {
    const config = buildCaddyConfig([
      { kind: 'proxy', domain: 'api.example.com', port: 8080 },
      { kind: 'static', domain: 'www.example.com', root: '/srv/wwwroot/company-portal' },
    ], { adminListen: ADMIN_LISTEN })
    const routes = ((config.apps as { http: { servers: { elysian: { routes: unknown[] } } } }).http.servers.elysian.routes) as {
      match: { host: string[] }[]
      handle: { handler: string; upstreams?: { dial: string }[]; root?: string }[]
    }[]
    expect(routes.find((route) => route.match[0]?.host[0] === 'api.example.com')?.handle[0]?.upstreams)
      .toEqual([{ dial: '127.0.0.1:8080' }])
    expect(routes.find((route) => route.match[0]?.host[0] === 'www.example.com')?.handle[0]?.root)
      .toBe('/srv/wwwroot/company-portal')
  })

  it('无域名站点不生成路由：空站点列表产出空路由的合法配置', () => {
    const config = buildCaddyConfig([], { adminListen: ADMIN_LISTEN })
    const server = (config.apps as { http: { servers: { elysian: { routes: unknown[] } } } }).http.servers.elysian
    expect(server.routes).toEqual([])
  })
})

describe('managedHosts 提取', () => {
  it('从面板管理的 server 提取全部 host', () => {
    const config = buildCaddyConfig([
      { kind: 'proxy', domain: 'a.example.com', port: 1 },
      { kind: 'static', domain: 'b.example.com', root: '/srv/wwwroot/b' },
    ], { adminListen: ADMIN_LISTEN })
    expect(managedHosts(config)).toEqual(new Set(['a.example.com', 'b.example.com']))
  })

  it('空配置与形状不符的配置返回空集合（按「期望路由全部缺失」呈现，不编造）', () => {
    expect(managedHosts(null)).toEqual(new Set())
    expect(managedHosts({})).toEqual(new Set())
    expect(managedHosts({ apps: { http: { servers: { elysian: {} } } } })).toEqual(new Set())
  })
})

describe('hasForeignConfig 三类外配判定', () => {
  const expected = new Set(['a.example.com'])

  it('陌生 app（apps 里出现 http 之外的键）即外部配置', () => {
    expect(hasForeignConfig({ apps: { http: {}, tls: {} } }, expected)).toBe(true)
  })

  it('陌生 server（servers 里出现 elysian 之外的键）即外部配置', () => {
    expect(hasForeignConfig({ apps: { http: { servers: { elysian: {}, other: {} } } } }, expected)).toBe(true)
  })

  it('面板管理 server 里存在登记之外的域名路由即外部配置', () => {
    const config = buildCaddyConfig([
      { kind: 'proxy', domain: 'a.example.com', port: 1 },
      { kind: 'proxy', domain: 'stranger.example.com', port: 2 },
    ], { adminListen: ADMIN_LISTEN })
    expect(hasForeignConfig(config, expected)).toBe(true)
  })

  it('空配置（首次接管）与纯面板配置放行', () => {
    expect(hasForeignConfig({}, expected)).toBe(false)
    expect(hasForeignConfig(null, expected)).toBe(false)
    const ours = buildCaddyConfig([{ kind: 'proxy', domain: 'a.example.com', port: 1 }], { adminListen: ADMIN_LISTEN })
    expect(hasForeignConfig(ours, expected)).toBe(false)
  })

  it('admin listen 与面板一致的配置按面板自有处理：差集豁免（回收自有残留路由的依据）', () => {
    // 当前配置含 registry 之外的 host（面板此前下发、现已删除/关站的残留路由）。
    const stale = buildCaddyConfig([
      { kind: 'proxy', domain: 'a.example.com', port: 1 },
      { kind: 'proxy', domain: 'deleted.example.com', port: 2 },
    ], { adminListen: ADMIN_LISTEN })
    expect(hasForeignConfig(stale, expected)).toBe(true)
    expect(hasForeignConfig(stale, expected, { adminListen: ADMIN_LISTEN })).toBe(false)
    // admin listen 不是面板的（独立来源配置）时差集照判。
    expect(hasForeignConfig(stale, expected, { adminListen: 'unix//other.sock' })).toBe(true)
  })
})

describe('missingHosts 漂移探测', () => {
  it('期望集合中不在当前配置里的域名即缺口', () => {
    const current = buildCaddyConfig([{ kind: 'proxy', domain: 'a.example.com', port: 1 }], { adminListen: ADMIN_LISTEN })
    expect(missingHosts(new Set(['a.example.com', 'b.example.com']), current)).toEqual(new Set(['b.example.com']))
    expect(missingHosts(new Set(['a.example.com']), current)).toEqual(new Set())
    // 通道恢复后 caddy 以空配置重启：全部期望路由呈现缺口。
    expect(missingHosts(new Set(['a.example.com']), {})).toEqual(new Set(['a.example.com']))
  })
})

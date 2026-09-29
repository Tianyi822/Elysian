/*
 * Caddy 配置生成与判读的纯函数集：零 IO，独立单测。
 * 面板对宿主 Caddy 的驱动方式是整配置原子替换（POST /load）——配置永远由登记
 * 全量重新推导，路由按域名排序生成保证同输入同输出（可复现、可测）。
 */

export type CaddyManagedSite =
  | { kind: 'proxy'; domain: string; port: number }
  | { kind: 'static'; domain: string; root: string }

export type CaddyConfigOptions = {
  /** Caddy admin 监听地址（`unix/<socket 路径>`），同时写进配置的 admin 段。 */
  adminListen: string
}

const SERVER_NAME = 'elysian'
const LISTEN = [':80', ':443']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从登记投影生成 Caddy 原生 JSON 配置：非 HTML 域名站 `reverse_proxy` 到
 * `127.0.0.1:<port>`（容器端口发布的宿主回环），HTML 域名站 `file_server`
 * （root 为站点目录）。无域名站点不生成路由；路由按域名排序。
 */
export function buildCaddyConfig(
  sites: readonly CaddyManagedSite[],
  options: CaddyConfigOptions,
): Record<string, unknown> {
  const routes = [...sites]
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .map((site) => ({
      match: [{ host: [site.domain] }],
      handle:
        site.kind === 'proxy'
          ? [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${site.port}` }] }]
          : [{ handler: 'file_server', root: site.root }],
    }))
  return {
    admin: { listen: options.adminListen },
    logging: { logs: { default: { level: 'WARN' } } },
    apps: { http: { servers: { [SERVER_NAME]: { listen: LISTEN, routes } } } },
  }
}

/**
 * 从当前配置提取面板管理 server（apps.http.servers.elysian）的路由 host 集合。
 * 形状不符（空配置、被外部清空的配置）返回空集合——调用方按「期望路由全部缺失」
 * 呈现漂移，不在这里编造。
 */
export function managedHosts(config: unknown): Set<string> {
  const apps = isRecord(config) ? config.apps : undefined
  const http = isRecord(apps) ? apps.http : undefined
  const servers = isRecord(http) ? http.servers : undefined
  const server = isRecord(servers) ? servers[SERVER_NAME] : undefined
  const routes = isRecord(server) && Array.isArray(server.routes) ? server.routes : []
  const hosts = new Set<string>()
  for (const route of routes) {
    if (!isRecord(route) || !Array.isArray(route.match)) continue
    for (const matcher of route.match) {
      if (!isRecord(matcher) || !Array.isArray(matcher.host)) continue
      for (const host of matcher.host) {
        if (typeof host === 'string' && host.length > 0) hosts.add(host)
      }
    }
  }
  return hosts
}

/** 面板写出的配置只会有一个 http app 与一个 elysian server；出现其他键即外部配置。 */
function hasForeignAppsOrServers(config: unknown): boolean {
  const apps = isRecord(config) ? config.apps : undefined
  if (apps !== undefined) {
    if (!isRecord(apps)) return true
    if (Object.keys(apps).some((key) => key !== 'http')) return true
    const http = apps.http
    if (http !== undefined) {
      if (!isRecord(http)) return true
      const servers = http.servers
      if (servers !== undefined) {
        if (!isRecord(servers)) return true
        if (Object.keys(servers).some((key) => key !== SERVER_NAME)) return true
      }
    }
  }
  return false
}

/**
 * 外部配置判定（下发前防护）：apps 键不全在 { http } 内、或 apps.http.servers 键
 * 不全在 { elysian } 内、或面板管理 server 的路由 host 集合与 registry 推导集合
 * 之差非空（存在面板不认识的域名路由），即视为面板外配置、拒绝覆盖。空配置
 * （首次接管）三条件都不成立，直接放行。管理员需要手工配置宿主 Caddy 时，须先
 * 知晓本防护会拒绝覆盖（部署文档同款口径）。
 *
 * host 差集一环对「面板自己写出的配置」豁免（options.adminListen 与当前配置的
 * admin.listen 一致时跳过该环）：删除域名站点与关停 HTML 域名站都要从全量重下发
 * 中**回收**已登记过的路由——差集里那些"面板不认识"的 host 恰恰是面板此前自己
 * 下发的残留，若按差集一律拒绝，回收与「配置残留将在下次下发时回收」就永远走
 * 不通。与面板产出逐字同形（admin listen、apps、server 名一致）的配置按面板自有
 * 处理；管理员若在 elysian server 里手工加路由并保留面板的 admin listen，防护
 * 不再区分（该形态与面板产出不可分辨），整配置仍由 registry 全量替换。
 */
export function hasForeignConfig(
  config: unknown,
  expectedHosts: ReadonlySet<string>,
  options: { adminListen?: string } = {},
): boolean {
  if (hasForeignAppsOrServers(config)) return true
  if (options.adminListen !== undefined) {
    const listen = (config as { admin?: { listen?: unknown } } | null)?.admin?.listen
    if (listen === options.adminListen) return false
  }
  for (const host of managedHosts(config)) {
    if (!expectedHosts.has(host)) return true
  }
  return false
}

/** 期望域名集合中不在当前配置里的部分（漂移探测：降级期间创建的域名站点、外部重置）。 */
export function missingHosts(expectedHosts: ReadonlySet<string>, config: unknown): ReadonlySet<string> {
  const current = managedHosts(config)
  const missing = new Set<string>()
  for (const host of expectedHosts) {
    if (!current.has(host)) missing.add(host)
  }
  return missing
}

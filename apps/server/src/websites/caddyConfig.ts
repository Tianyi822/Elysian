/*
 * Caddy 配置生成与判读的纯函数集：零 IO，独立单测。
 * 面板对宿主 Caddy 的驱动方式是整配置原子替换（POST /load）——配置永远由登记
 * 全量重新推导，路由按域名排序生成保证同输入同输出（可复现、可测）。
 */
import { X509Certificate } from 'node:crypto'

export type CaddyManagedSite = { kind: 'proxy'; domain: string; port: number; certificatePem?: string; privateKeyPem?: string }

export type CaddyConfigOptions = {
  /** Caddy admin 监听地址（`unix/<socket 路径>`），同时写进配置的 admin 段。 */
  adminListen: string
}

const SERVER_NAME = 'elysian'
const REDIRECT_SERVER_NAME = 'elysian_http'
const LISTEN = [':443']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从登记投影生成 Caddy 原生 JSON 配置：域名站一律 `reverse_proxy` 到
 * `127.0.0.1:<port>`（容器端口发布的宿主回环）。无域名站点不生成路由。
 */
export function buildCaddyConfig(
  sites: readonly CaddyManagedSite[],
  options: CaddyConfigOptions,
): Record<string, unknown> {
  const routes = [...sites]
    .sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .map((site) => ({
      match: [{ host: [site.domain] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${site.port}` }] }],
    }))
  const certificates = [...sites].sort((a, b) => a.domain.localeCompare(b.domain))
    .filter((site) => site.certificatePem && site.privateKeyPem)
    .map((site) => ({ certificate: site.certificatePem, key: site.privateKeyPem }))
  return {
    admin: { listen: options.adminListen },
    logging: { logs: { default: { level: 'WARN' } } },
    apps: {
      http: { servers: {
        [SERVER_NAME]: { listen: LISTEN, tls_connection_policies: [{}], automatic_https: { disable: true }, routes },
        [REDIRECT_SERVER_NAME]: { listen: [':80'], automatic_https: { disable: true }, routes: [...sites].sort((a, b) => a.domain.localeCompare(b.domain)).map((site) => ({
          match: [{ host: [site.domain] }],
          handle: [{ handler: 'static_response', status_code: '308', headers: { Location: [`https://${site.domain}{http.request.uri}`] } }],
        })) },
      } },
      tls: { certificates: { load_pem: certificates } },
    },
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

/** 面板写出的配置仅有 http、tls app 和两个命名 server；出现其他键即外部配置。 */
function hasForeignAppsOrServers(config: unknown): boolean {
  const apps = isRecord(config) ? config.apps : undefined
  if (apps !== undefined) {
    if (!isRecord(apps)) return true
    if (Object.keys(apps).some((key) => key !== 'http' && key !== 'tls')) return true
    const tls = apps.tls
    if (tls !== undefined) {
      if (!isRecord(tls) || Object.keys(tls).some((key) => key !== 'certificates')) return true
      const certificates = tls.certificates
      if (certificates !== undefined && (!isRecord(certificates) || Object.keys(certificates).some((key) => key !== 'load_pem'))) return true
    }
    const http = apps.http
    if (http !== undefined) {
      if (!isRecord(http)) return true
      const servers = http.servers
      if (servers !== undefined) {
        if (!isRecord(servers)) return true
        if (Object.keys(servers).some((key) => key !== SERVER_NAME && key !== REDIRECT_SERVER_NAME)) return true
      }
    }
  }
  return false
}

/** 外部 app、server、未知域名或 admin 监听不匹配时拒绝覆盖。删除时调用方把删除前登记域名作为已知集合传入。 */
export function hasForeignConfig(
  config: unknown,
  expectedHosts: ReadonlySet<string>,
  options: { adminListen?: string } = {},
): boolean {
  if (hasForeignAppsOrServers(config)) return true
  if (options.adminListen !== undefined) {
    const listen = (config as { admin?: { listen?: unknown } } | null)?.admin?.listen
    if (listen !== undefined && listen !== options.adminListen) return true
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

/** 只核对面板负责的路由三要素：域名、处理器、目标。额外字段由 Caddy 自行维护。 */
export function appliedManagedHosts(sites: readonly CaddyManagedSite[], config: unknown): Set<string> {
  const apps = isRecord(config) ? config.apps : undefined
  const http = isRecord(apps) ? apps.http : undefined
  const servers = isRecord(http) ? http.servers : undefined
  const server = isRecord(servers) ? servers[SERVER_NAME] : undefined
  if (!isRecord(server) || !Array.isArray(server.listen) ||
    !server.listen.includes(':443') || server.listen.includes(':80')) return new Set()
  const routes = isRecord(server) && Array.isArray(server.routes) ? server.routes : []
  const applied = new Set<string>()
  for (const site of sites) {
    const domainRoutes = routes.filter((route) => isRecord(route) && Array.isArray(route.match) &&
      route.match.some((match) => isRecord(match) && Array.isArray(match.host) && match.host.includes(site.domain)))
    const found = domainRoutes.length === 1 && domainRoutes.some((route) => {
      if (!isRecord(route) || !Array.isArray(route.match) || route.match.length !== 1 ||
        !Array.isArray(route.handle) || route.handle.length !== 1) return false
      const matches = route.match.some((match) => isRecord(match) && Array.isArray(match.host) &&
        match.host.length === 1 && match.host[0] === site.domain)
      if (!matches) return false
      return route.handle.some((handle) => {
        if (!isRecord(handle)) return false
        return handle.handler === 'reverse_proxy' && Array.isArray(handle.upstreams) &&
          handle.upstreams.length === 1 &&
          handle.upstreams.some((upstream) => isRecord(upstream) && upstream.dial === `127.0.0.1:${site.port}`)
      })
    })
    if (found) applied.add(site.domain)
  }
  return applied
}

/** 与登记的叶证书指纹核对；只反映 Caddy 已加载配置，不代表公网可达。 */
export function appliedCertificateFingerprints(config: unknown): Set<string> {
  const apps = isRecord(config) ? config.apps : undefined
  const tls = isRecord(apps) ? apps.tls : undefined
  const certificates = isRecord(tls) ? tls.certificates : undefined
  const loaded = isRecord(certificates) && Array.isArray(certificates.load_pem) ? certificates.load_pem : []
  const fingerprints = new Set<string>()
  for (const item of loaded) {
    if (!isRecord(item) || typeof item.certificate !== 'string') continue
    try { fingerprints.add(new X509Certificate(item.certificate).fingerprint256) } catch { /* 漂移显示为未下发 */ }
  }
  return fingerprints
}

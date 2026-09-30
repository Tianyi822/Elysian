import { describe, expect, it } from 'vitest'
import { appliedManagedHosts, buildCaddyConfig, hasForeignConfig } from './caddyConfig.ts'

const site = { kind: 'proxy' as const, domain: 'example.com', port: 8080, certificatePem: '证书', privateKeyPem: '私钥' }
const options = { adminListen: 'unix//run/caddy/admin.sock' }

describe('Caddy 手动证书路由', () => {
  it('443 反代、80 重定向且两个服务均关闭自动签发', () => {
    const config = buildCaddyConfig([site], options) as any
    const https = config.apps.http.servers.elysian
    const http = config.apps.http.servers.elysian_http
    expect(https.listen).toEqual([':443'])
    expect(https.tls_connection_policies).toEqual([{}])
    expect(https.automatic_https.disable).toBe(true)
    expect(https.routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:8080')
    expect(http.listen).toEqual([':80'])
    expect(http.automatic_https.disable).toBe(true)
    expect(http.routes[0].handle[0]).toEqual({ handler: 'static_response', status_code: '308', headers: { Location: ['https://example.com{http.request.uri}'] } })
    expect(config.apps.tls.certificates.load_pem).toEqual([{ certificate: '证书', key: '私钥' }])
  })

  it('路由核对识别目标漂移和监听漂移', () => {
    const config = buildCaddyConfig([site], options) as any
    expect(appliedManagedHosts([site], config).has('example.com')).toBe(true)
    config.apps.http.servers.elysian.routes[0].handle[0].upstreams[0].dial = '127.0.0.1:9999'
    expect(appliedManagedHosts([site], config).has('example.com')).toBe(false)
    config.apps.http.servers.elysian.routes[0].handle[0].upstreams[0].dial = '127.0.0.1:8080'
    config.apps.http.servers.elysian.listen = [':80']
    expect(appliedManagedHosts([site], config).has('example.com')).toBe(false)
  })

  it('拒绝覆盖外部 app 和外部 server', () => {
    const config = buildCaddyConfig([site], options) as any
    expect(hasForeignConfig(config, new Set(['example.com']), options)).toBe(false)
    config.apps.tls.automation = {}
    expect(hasForeignConfig(config, new Set(['example.com']), options)).toBe(true)
  })

  it('同一个 admin socket 下的未知域名路由仍视为外部配置', () => {
    const config = buildCaddyConfig([site], options) as any
    expect(hasForeignConfig(config, new Set(), options)).toBe(true)
    expect(hasForeignConfig(config, new Set(['example.com']), options)).toBe(false)
  })
})

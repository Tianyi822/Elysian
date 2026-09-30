import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpWebsitesAdapter, parseWebsiteProject } from '../adapters/http/websitesHttpAdapter'
import { MockWebsitesAdapter } from '../adapters/mock/mockAdapters'
import { resetWebsitesData } from '../adapters/mock/websitesData'

const row = { id: 'p', kind: 'html', name: 'site', pid: null, containerId: 'a'.repeat(64), port: 8080,
  runtimeVersion: null, rootDir: '/srv/wwwroot/site', runState: 'stopped', accessMode: 'domain', domain: 'example.com',
  routeApplied: true, certificate: { issuer: '公开 CA', notAfter: '2027-01-01T00:00:00.000Z', fingerprint256: 'AA', applied: true },
  expiryAt: null, note: null, category: 'development', deployCommand: 'nginx -g daemon off;', gitUrl: null,
  traffic: { todayMb: 0, totalGb: 0 } }

afterEach(() => { vi.unstubAllGlobals(); resetWebsitesData() })

describe('网站 adapter 访问配置', () => {
  it('响应只解析公开证书元数据，不接受旧 cert 字段代替证书', () => {
    expect(parseWebsiteProject(row).certificate?.applied).toBe(true)
    expect(() => parseWebsiteProject({ ...row, certificate: undefined, cert: 'deployed' })).toThrow('证书响应无效')
  })

  it('HTTP 创建和访问更新传输访问方式及证书，读取响应不含私钥', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({ project: row, firewallPort: null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const adapter = createHttpWebsitesAdapter()
    const created = await adapter.create('html', { name: 'site', port: 8080, access: { mode: 'direct' } })
    expect(created.firewallPort).toBeNull()
    await adapter.setAccess('p', { mode: 'domain', domain: 'example.com', certificatePem: 'cert', privateKeyPem: 'key' })
    expect(requests[0]?.url).toBe('/api/websites/')
    expect(JSON.parse(String(requests[0]?.init?.body)).access).toEqual({ mode: 'direct' })
    expect(requests[1]?.url).toBe('/api/websites/p/access')
    expect(JSON.parse(String(requests[1]?.init?.body)).privateKeyPem).toBe('key')
    expect(parseWebsiteProject(row)).not.toHaveProperty('privateKeyPem')
  })

  it('mock 从空列表开始，直连项目可以创建、启停和更换访问方式', async () => {
    const adapter = new MockWebsitesAdapter()
    expect((await adapter.list()).projects).toEqual([])
    const project = (await adapter.create('html', { name: 'docs', port: 8088, access: { mode: 'direct' } })).project
    expect(project.containerId).toMatch(/^[0-9a-f]{64}$/)
    expect((await adapter.setRunning(project.id, true)).runState).toBe('running')
    const domain = (await adapter.setAccess(project.id, { mode: 'domain', domain: 'example.com', certificatePem: 'cert', privateKeyPem: 'key' })).project
    expect(domain.domain).toBe('example.com')
    expect(domain.certificate?.applied).toBe(true)
    expect((await adapter.setAccess(project.id, { mode: 'direct' })).project.certificate).toBeNull()
  })
})

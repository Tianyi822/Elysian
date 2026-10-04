import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpWebsitesAdapter, parseWebsiteProject } from '../adapters/http/websitesHttpAdapter'
import { MockWebsitesAdapter } from '../adapters/mock/mockAdapters'
import { resetWebsitesData } from '../adapters/mock/websitesData'
import { MOCK_WEBSITE_RUNTIME_REPORT } from '../adapters/mock/websiteRuntimeCatalog'

const row = { id: 'p', kind: 'html', name: 'site', pid: null, containerId: 'a'.repeat(64), port: 8080,
  runtimeVersion: null, rootDir: '/srv/wwwroot/site', runState: 'stopped', accessMode: 'domain', domain: 'example.com',
  routeApplied: true, certificate: { issuer: '公开 CA', notAfter: '2027-01-01T00:00:00.000Z', fingerprint256: 'AA', applied: true },
  expiryAt: null, note: null, category: 'development', deployCommand: 'nginx -g daemon off;', gitUrl: null,
  traffic: { todayMb: 0, totalGb: 0 } }

afterEach(() => { vi.unstubAllGlobals(); resetWebsitesData() })

describe('网站 adapter 访问配置', () => {
  it.each([
    ['node', '24.21.0', 'node app.js'],
    ['python', '3.9.7', 'python3 app.py'],
  ] as const)('mock %s 创建不能补填启动命令，必须使用用户输入', async (kind, runtimeVersion, command) => {
    const adapter = new MockWebsitesAdapter()
    const input = { name: 'app', port: 8080, runtimeVersion, access: { mode: 'direct' as const } }
    await expect(adapter.create(kind, input)).rejects.toThrow('请填写容器启动命令')
    expect((await adapter.list()).projects).toEqual([])
    const created = await adapter.create(kind, { ...input, command })
    expect(created.project.deployCommand).toBe(command)
  })

  it('版本目录通过同源 API 获取，拒绝预发布响应', async () => {
    const fetcher = vi.fn(async () => Response.json(MOCK_WEBSITE_RUNTIME_REPORT))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    const adapter = createHttpWebsitesAdapter()
    expect(await adapter.runtimeCatalog(signal)).toEqual(MOCK_WEBSITE_RUNTIME_REPORT)
    expect(fetcher).toHaveBeenCalledWith('/api/websites/runtimes', { signal: expect.any(AbortSignal), cache: 'no-store' })
    const invalid = structuredClone(MOCK_WEBSITE_RUNTIME_REPORT)
    invalid.catalog.node = [{ version: '24.22.0-rc.1', image: 'node:24.22.0-rc.1', maintenance: 'legacy', checkedAt: '2026-09-30' }]
    fetcher.mockResolvedValue(Response.json(invalid))
    await expect(adapter.runtimeCatalog()).rejects.toThrow('正式运行时版本目录响应无效')
  })

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

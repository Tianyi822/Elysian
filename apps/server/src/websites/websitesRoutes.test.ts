import { describe, expect, it, vi } from 'vitest'
import type { WebsiteService } from './websitesService.ts'
import { createWebsitesApp } from './websitesRoutes.ts'
import type { WebsiteProject } from '@elysian/contracts'

const project = { id: 'p', kind: 'html', name: 'site', pid: null, containerId: 'a'.repeat(64), port: 8080,
  runtimeVersion: null, rootDir: '/srv/wwwroot/site', runState: 'stopped', accessMode: 'direct', domain: null,
  routeApplied: false, certificate: null, expiryAt: null, note: null, category: 'development',
  deployCommand: 'nginx -g daemon off;', gitUrl: null, traffic: { todayMb: 0, totalGb: 0 } } satisfies WebsiteProject

function fixture() {
  const service: WebsiteService = {
    list: vi.fn(async () => ({ projects: [project], proxy: { state: 'active' as const, detail: null } })),
    create: vi.fn(async () => ({ project, firewallPort: null })),
    update: vi.fn(async () => project),
    setAccess: vi.fn(async () => ({ project, firewallPort: null })),
    setRunning: vi.fn(async () => project),
    logs: vi.fn(async () => ['日志']),
    remove: vi.fn(async () => undefined),
    reconcileProxy: vi.fn(async () => ({ state: 'active' as const, detail: null })),
  }
  return { service, app: createWebsitesApp({ available: true, service }) }
}

describe('网站访问接口', () => {
  it('创建解析访问模式与启动命令', async () => {
    const { app, service } = fixture()
    const response = await app.request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({ kind: 'html', name: 'site', port: 8080, access: { mode: 'direct' } }) })
    expect(response.status).toBe(201)
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ access: { mode: 'direct' }, command: 'nginx -g daemon off;' }))
  })

  it('统一访问端点处理直连与域名，旧域名端点不可写', async () => {
    const { app, service } = fixture()
    const response = await app.request('http://localhost/p/access', { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: '{"mode":"direct"}' })
    expect(response.status).toBe(200)
    expect(service.setAccess).toHaveBeenCalledWith('p', { mode: 'direct' })
    const old = await app.request('http://localhost/p/domain', { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: '{"domain":null}' })
    expect(old.status).toBe(404)
  })

  it('域名请求证书材料缺一拒绝', async () => {
    const { app } = fixture()
    const response = await app.request('http://localhost/p/access', { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
      body: JSON.stringify({ mode: 'domain', domain: 'example.com', certificatePem: 'cert' }) })
    expect(response.status).toBe(400)
  })
})

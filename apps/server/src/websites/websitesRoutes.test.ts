import { describe, expect, it, vi } from 'vitest'
import type { WebsiteListReport, WebsiteProject, WebsiteProxyStatus } from '@elysian/contracts'
import { createWebsitesApp } from './websitesRoutes.ts'
import type { WebsiteService } from './websitesService.ts'
import { InvalidRequestError } from '../shared/errors.ts'

/*
 * 守卫链（503/403/415/413/400）与端点行为，中文文案逐字断言；
 * 模式对齐 databaseRoutes.test.ts（fake service，不起真实引擎与 socket）。
 */

const PROJECT: WebsiteProject = {
  id: 'site-1', kind: 'node', name: 'admin-console', pid: null, containerId: 'a'.repeat(64),
  port: 3000, runtimeVersion: '20.11.1', rootDir: '/srv/wwwroot/admin-console',
  runState: 'stopped', domain: null, expiryAt: null, note: null, cert: 'none',
  category: 'development', deployCommand: 'tail -f /dev/null', gitUrl: null,
  traffic: { todayMb: 0, totalGb: 0 },
}

function fixture() {
  const service: WebsiteService = {
    list: vi.fn(async (): Promise<WebsiteListReport> => ({
      projects: [PROJECT],
      proxy: { state: 'active', detail: null },
    })),
    create: vi.fn(async () => PROJECT),
    update: vi.fn(async () => PROJECT),
    setRunning: vi.fn(async () => PROJECT),
    logs: vi.fn(async () => ['启动完成']),
    remove: vi.fn(async () => undefined),
    reconcileProxy: vi.fn(async (): Promise<WebsiteProxyStatus> => ({ state: 'active', detail: null })),
  }
  const app = createWebsitesApp({ available: true, service })
  return { app, service }
}

const HEADERS = { Host: 'localhost:48100', Origin: 'http://localhost:48100', 'Content-Type': 'application/json' }

describe('可用性与同源守卫', () => {
  it('available 为假整片 503（含未知路径），文案与容器边界一致', async () => {
    const app = createWebsitesApp({ available: false })
    for (const path of ['/', '/site-1', '/proxy/reconcile', '/unknown']) {
      const res = await app.request(`http://localhost:48100${path}`, { headers: { Host: 'localhost:48100' } })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实网站管理仅在 Docker 环境可用' })
    }
  })

  it('跨源写请求 403「请求来源不允许」，GET 不受影响', async () => {
    const { app, service } = fixture()
    const blocked = await app.request('http://localhost:48100/', {
      method: 'POST',
      headers: { Host: 'localhost:48100', Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'node', name: 'x', port: 3000, runtimeVersion: '20.11.1' }),
    })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({ error: '请求来源不允许' })
    expect(service.create).not.toHaveBeenCalled()
    expect((await app.request('http://localhost:48100/')).status).toBe(200)
  })
})

describe('请求体三拦（415/413/400）', () => {
  it('Content-Type 非 JSON 415、超大请求体 413、非法 JSON 400', async () => {
    const { app } = fixture()
    const wrongType = await app.request('http://localhost:48100/', {
      method: 'POST', headers: { Host: 'localhost:48100', Origin: 'http://localhost:48100', 'Content-Type': 'text/plain' }, body: 'x',
    })
    expect(wrongType.status).toBe(415)
    expect(await wrongType.json()).toEqual({ error: 'Content-Type 必须为 application/json' })
    const oversized = await app.request('http://localhost:48100/', {
      method: 'POST',
      headers: { Host: 'localhost:48100', Origin: 'http://localhost:48100', 'Content-Type': 'application/json', 'Content-Length': String(65 * 1024) },
      body: 'x'.repeat(65 * 1024),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: '请求体过大' })
    const malformed = await app.request('http://localhost:48100/', {
      method: 'POST', headers: HEADERS, body: '{not-json',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: '请求体不是有效 JSON' })
  })
})

describe('端点行为', () => {
  it('GET / 返回 { projects, proxy }；GET /:id/logs 带 no-store', async () => {
    const { app } = fixture()
    const list = await app.request('http://localhost:48100/')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({
      projects: [PROJECT],
      proxy: { state: 'active', detail: null },
    })
    const logs = await app.request('http://localhost:48100/site-1/logs')
    expect(logs.status).toBe(200)
    expect(logs.headers.get('cache-control')).toBe('no-store')
    expect(await logs.json()).toEqual({ logs: ['启动完成'] })
  })

  it('POST / 创建走服务端校验（400 中文文案）并返回 201', async () => {
    const { app, service } = fixture()
    const bad = await app.request('http://localhost:48100/', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ kind: 'node', name: 'x', port: 0, runtimeVersion: '20.11.1' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '端口需为 1-65535 的整数' })
    expect(service.create).not.toHaveBeenCalled()
    const created = await app.request('http://localhost:48100/', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ kind: 'node', name: 'admin-console', port: 3000, runtimeVersion: '20.11.1' }),
    })
    expect(created.status).toBe(201)
  })

  it('POST /:id/running 校验布尔启停状态', async () => {
    const { app, service } = fixture()
    const bad = await app.request('http://localhost:48100/site-1/running', {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ running: 'yes' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '启停状态须为布尔值' })
    const ok = await app.request('http://localhost:48100/site-1/running', {
      method: 'POST', headers: HEADERS, body: JSON.stringify({ running: true }),
    })
    expect(ok.status).toBe(200)
    expect(service.setRunning).toHaveBeenCalledWith('site-1', true)
  })

  it('POST /proxy/reconcile 返回 { proxy, applied }；通道不可用时 applied=false', async () => {
    const { app, service } = fixture()
    const res = await app.request('http://localhost:48100/proxy/reconcile', { method: 'POST', headers: HEADERS, body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ proxy: { state: 'active', detail: null }, applied: true })
    expect(service.reconcileProxy).toHaveBeenCalled()
    const degraded = createWebsitesApp({
      available: true,
      service: {
        ...fixture().service,
        reconcileProxy: vi.fn(async (): Promise<WebsiteProxyStatus> => ({ state: 'unavailable', detail: '宿主未提供 Caddy 管理通道' })),
      },
    })
    const degradedRes = await degraded.request('http://localhost:48100/proxy/reconcile', { method: 'POST', headers: HEADERS, body: '{}' })
    expect(await degradedRes.json()).toEqual({
      proxy: { state: 'unavailable', detail: '宿主未提供 Caddy 管理通道' },
      applied: false,
    })
  })

  it('PUT /:id 设置走校验：到期时间格式无效 400', async () => {
    const { app } = fixture()
    const bad = await app.request('http://localhost:48100/site-1', {
      method: 'PUT', headers: HEADERS, body: JSON.stringify({ expiryAt: '2026/12/20' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '到期时间格式无效' })
  })

  it('DELETE /:id 必须带 DELETE_WEBSITE_AND_DATA 确认正文，缺确认 400 且不删除', async () => {
    const { app, service } = fixture()
    const denied = await app.request('http://localhost:48100/site-1', {
      method: 'DELETE', headers: HEADERS, body: JSON.stringify({ confirm: false }),
    })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toEqual({ error: '必须确认删除站点及数据' })
    expect(service.remove).not.toHaveBeenCalled()
    const accepted = await app.request('http://localhost:48100/site-1', {
      method: 'DELETE', headers: HEADERS, body: JSON.stringify({ confirm: 'DELETE_WEBSITE_AND_DATA' }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ ok: true })
    expect(service.remove).toHaveBeenCalledWith('site-1')
  })

  it('服务端错误按自带状态码映射 4xx，未知 id 404「未找到项目 X」', async () => {
    const { app } = fixture()
    const missing = createWebsitesApp({
      available: true,
      service: { ...fixture().service, update: vi.fn(async () => { throw new InvalidRequestError(404, '未找到项目 site-9') }) },
    })
    const res = await missing.request('http://localhost:48100/site-9', {
      method: 'PUT', headers: HEADERS, body: JSON.stringify({ note: 'x' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未找到项目 site-9' })
    expect(app).toBeDefined()
  })

  it('未知路径 404（父级兜底先例照旧，database 片同款）', async () => {
    const { app } = fixture()
    const res = await app.request('http://localhost:48100/unknown/deeper', { headers: { Host: 'localhost:48100' } })
    expect(res.status).toBe(404)
  })
})

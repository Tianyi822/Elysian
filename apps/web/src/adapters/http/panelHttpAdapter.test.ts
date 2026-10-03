import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPanelAdapter, parsePanelInfo, parsePanelTask } from './panelHttpAdapter'
const task = { id: 'a'.repeat(32), kind: 'ports', state: 'queued', phase: 'checking', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', oldPorts: { frontendPort: 48100, backendPort: 48101 }, newPorts: { frontendPort: 49000, backendPort: 49001 }, targetCommit: '', error: '' }
afterEach(() => vi.unstubAllGlobals())
describe('面板维护 HTTP 契约', () => {
  it('拒绝错误端口和未知任务状态', () => {
    expect(() => parsePanelTask({ ...task, state: 'pretend-success' })).toThrow('状态无效')
    expect(() => parsePanelTask({ ...task, newPorts: { frontendPort: 0, backendPort: 1 } })).toThrow('端口响应无效')
    expect(() => parsePanelInfo({ ports: task.oldPorts, available: true })).toThrow('响应无效')
  })
  it('端口提交携带稳定提交编号，并返回异步任务', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(task), { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    expect(await createHttpPanelAdapter().ports(task.newPorts, 'stable-request')).toEqual(task)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ ...task.newPorts, requestId: 'stable-request' }) })
  })
  it('错误透传，跨端口健康探测不携带 Cookie', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '端口被占用' }), { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ready: true })))
    vi.stubGlobal('fetch', fetch)
    await expect(createHttpPanelAdapter().restart('stable-request')).rejects.toThrow('端口被占用')
    expect(await createHttpPanelAdapter().ready('http://127.0.0.1:49000', task.id)).toBe(true)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ credentials: 'omit' })
  })
})

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
  it.each(['commit', 'release'] as const)('检查、日志和更新提交使用同一策略：%s', async (channel) => {
    const target = { channel, targetCommit: 'b'.repeat(40), releaseTag: channel === 'release' ? 'v1.2.0' : '' }
    const update = { ...target, repository: 'Tianyi822/Elysian', branch: channel === 'commit' ? 'main' : '', currentCommit: 'a'.repeat(40), message: '更新说明', available: true }
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(update)))
      .mockResolvedValueOnce(new Response('[]'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...task, kind: 'update', ...target, updateChannel: channel }), { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPanelAdapter()
    expect(await adapter.checkUpdate(channel)).toEqual(update)
    await adapter.commits(channel)
    await adapter.update(target, 'stable-request')
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/panel/update?channel=${channel}`)
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/panel/commits?channel=${channel}`)
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ ...target, requestId: 'stable-request' }) })
  })
  it('拒绝其他策略的检查结果，避免发版选择执行默认分支', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ channel: 'commit', releaseTag: '', repository: 'Tianyi822/Elysian', branch: 'main', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), message: '更新', available: true }))))
    await expect(createHttpPanelAdapter().checkUpdate('release')).rejects.toThrow('更新信息与所选策略不一致')
  })
})

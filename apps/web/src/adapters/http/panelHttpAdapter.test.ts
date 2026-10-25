import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPanelAdapter, PanelHttpError, PanelNetworkError, parsePanelInfo, parsePanelTask, probeSameOriginHealth } from './panelHttpAdapter'
const task = { id: 'a'.repeat(32), kind: 'ports', state: 'queued', phase: 'checking', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', oldPorts: { frontendPort: 48100, backendPort: 48101 }, newPorts: { frontendPort: 49000, backendPort: 49001 }, targetCommit: '', error: '' }
afterEach(() => vi.unstubAllGlobals())
describe('面板维护 HTTP 契约', () => {
  it('拒绝错误端口和未知任务状态', () => {
    expect(() => parsePanelTask({ ...task, state: 'pretend-success' })).toThrow('状态无效')
    expect(() => parsePanelTask({ ...task, newPorts: { frontendPort: 0, backendPort: 1 } })).toThrow('端口响应无效')
    expect(() => parsePanelInfo({ ports: task.oldPorts, available: true })).toThrow('响应无效')
  })
  it('接受服务端派生的维护进程存活性标志，拒绝非布尔取值', () => {
    expect(parsePanelTask({ ...task, workerDead: true }).workerDead).toBe(true)
    expect(parsePanelTask({ ...task }).workerDead).toBeUndefined()
    expect(() => parsePanelTask({ ...task, workerDead: 'yes' })).toThrow('维护进程状态无效')
    expect(parsePanelTask({ ...task, workerStatus: 'unknown' }).workerStatus).toBe('unknown')
    expect(() => parsePanelTask({ ...task, workerStatus: 'timeout' })).toThrow('维护进程状态无效')
  })
  it('按请求编号精确查询，404仅表示尚未找到', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '尚未找到' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '服务忙' }), { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPanelAdapter()
    expect(await adapter.taskByRequest('request-1')).toBeNull()
    expect(await adapter.taskByRequest('request-1')).toEqual(task)
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/panel/tasks/by-request/request-1')
    await expect(adapter.taskByRequest('request-1')).rejects.toBeInstanceOf(PanelHttpError)
  })
  it.each(['fetch', 'body'] as const)('同源健康探测对挂起的%s有三秒上限，之后仍可重试', async (phase) => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', phase === 'fetch' ? vi.fn(() => new Promise(() => {})) : vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })))
      const pending = probeSameOriginHealth()
      await vi.advanceTimersByTimeAsync(3000)
      expect(await pending).toBeNull()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, commit: 'c' }))))
      expect(await probeSameOriginHealth()).toEqual({ commit: 'c' })
    } finally { vi.useRealTimers() }
  })
  it('同源健康探测响应调用方取消', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const cancel = new AbortController()
    const pending = probeSameOriginHealth(cancel.signal)
    cancel.abort()
    expect(await pending).toBeNull()
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
  it('网络失败与 HTTP 错误分流：只有前者标记为断连', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '面板正忙，请稍后重试' }), { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>网关错误</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPanelAdapter()
    await expect(adapter.info()).rejects.toBeInstanceOf(PanelNetworkError)
    await expect(adapter.info()).rejects.toThrow('面板正忙，请稍后重试')
    // 502 的非 JSON 响应体也归网络失败（面板本身没给出业务错误）。
    await expect(adapter.info()).rejects.toBeInstanceOf(PanelNetworkError)
  })
  it('同源健康探测返回运行版本，失败回空不抛错', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, commit: 'b'.repeat(40) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 503 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetch)
    expect(await probeSameOriginHealth()).toEqual({ commit: 'b'.repeat(40) })
    expect(await probeSameOriginHealth()).toBeNull()
    expect(await probeSameOriginHealth()).toBeNull()
  })
  it.each(['commit', 'release'] as const)('检查、日志和更新提交使用同一策略与来源：%s', async (channel) => {
    const target = { channel, source: 'gitee' as const, targetCommit: 'b'.repeat(40), releaseTag: channel === 'release' ? 'v1.2.0' : '' }
    const update = { ...target, repository: 'Tianyi822/Elysian', branch: channel === 'commit' ? 'main' : '', currentCommit: 'a'.repeat(40), message: '更新说明', available: true }
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(update)))
      .mockResolvedValueOnce(new Response('[]'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...task, kind: 'update', ...target, updateChannel: channel }), { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPanelAdapter()
    expect(await adapter.checkUpdate(channel, 'gitee')).toEqual(update)
    await adapter.commits(channel, 'gitee')
    await adapter.update(target, 'stable-request')
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/panel/update?channel=${channel}&source=gitee`)
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/panel/commits?channel=${channel}&source=gitee`)
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ ...target, requestId: 'stable-request' }) })
  })
  it('拒绝其他策略的检查结果，避免发版选择执行默认分支', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ channel: 'commit', source: 'github', releaseTag: '', repository: 'Tianyi822/Elysian', branch: 'main', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), message: '更新', available: true }))))
    await expect(createHttpPanelAdapter().checkUpdate('release', 'github')).rejects.toThrow('更新信息与所选策略不一致')
  })
  it('拒绝与所选仓库来源不符的检查结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ channel: 'commit', source: 'github', releaseTag: '', repository: 'Tianyi822/Elysian', branch: 'main', currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), message: '更新', available: true }))))
    await expect(createHttpPanelAdapter().checkUpdate('commit', 'gitee')).rejects.toThrow('更新信息与所选来源不一致')
  })
})

it('校验 CLI 注册状态并复用同源重试接口', async () => {
  expect(parsePanelTask({ ...task, cliRegistration: { status: 'failed', error: '外部命令占用' } }).cliRegistration?.status).toBe('failed')
  expect(() => parsePanelTask({ ...task, cliRegistration: { status: 'pretend-success' } })).toThrow('CLI 注册状态无效')
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...task, cliRegistration: { status: 'succeeded' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  const result = await createHttpPanelAdapter().retryCLIRegistration(task.id)
  expect(result.cliRegistration?.status).toBe('succeeded')
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/tasks/${task.id}/cli-registration/retry`), expect.objectContaining({ method: 'POST' }))
})

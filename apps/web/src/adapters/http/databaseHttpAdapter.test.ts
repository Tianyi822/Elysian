import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceAuthGeneration } from '../../utils/authGeneration'
import { setUnauthorizedListener } from './unauthorized'
import { createHttpDatabaseAdapter, sqliteDownloadName } from './databaseHttpAdapter'

/*
 * 数据库 HTTP adapter 的出口：新端点形状（容器行与 SQLite 文件分流）、
 * request 出口的 401 拦截、downloadSqlite 的 fetch blob 改造（不再 <a href> 导航——
 * 401 有明确中文反馈、不把错误 JSON 当文件保存）。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedListener(() => {})
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

class FakeXHR {
  static last: FakeXHR
  upload: { onprogress?: (event: ProgressEvent) => void } = {}
  status = 401
  responseText = '{"error":"未登录或会话已过期"}'
  onload?: () => void
  onerror?: () => void
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()
  constructor() { FakeXHR.last = this }
}

/** 捕获 fetch 的请求参数：断言端点路径与请求体形状。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): { requests: { url: string; init?: RequestInit }[] } {
  const requests: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return handler(url, init)
  }))
  return { requests }
}

describe('createHttpDatabaseAdapter 端点形状', () => {
  it('list 走容器行端点，listSqlite 走 /sqlite，两路显式分流', async () => {
    const containerRow = { id: 'ctr-1', engine: 'MariaDB', name: 'db', version: '10.11', status: 'running', image: 'mariadb:10.11', containerId: 'ctr-1', ports: [], networks: [], credentialsVerified: false, needsAttention: false, updatedAt: '2026-09-12T08:00:00.000Z' }
    const sqliteRow = { id: 'sqlite-1', engine: 'SQLite', name: 'notes', version: '3.46', status: 'running', updatedAt: '2026-09-12T08:00:00.000Z' }
    const { requests } = stubFetch((url) => jsonResponse(url.endsWith('/sqlite') ? [sqliteRow] : [containerRow]))
    const adapter = createHttpDatabaseAdapter()

    expect(await adapter.list()).toEqual([containerRow])
    expect(await adapter.listSqlite()).toEqual([sqliteRow])
    expect(requests.map((request) => request.url)).toEqual(['/api/databases/', '/api/databases/sqlite'])
  })

  it.each([
    { name: 'reveal 管理员凭据', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.reveal('ctr-1'), path: '/api/databases/ctr-1/reveal', method: 'POST' },
    { name: 'reconcile 容器核对', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.reconcile('ctr-1'), path: '/api/databases/ctr-1/reconcile', method: 'POST' },
    { name: 'reconcileSqlite 文件核对', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.reconcileSqlite('sqlite-1'), path: '/api/databases/sqlite/sqlite-1/reconcile', method: 'POST' },
    { name: 'forget 容器登记', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.forget('ctr-1'), path: '/api/databases/ctr-1/registration', method: 'DELETE' },
    { name: 'forgetSqlite 文件登记', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.forgetSqlite('sqlite-1'), path: '/api/databases/sqlite/sqlite-1/registration', method: 'DELETE' },
    { name: 'removeSqlite 带确认短语', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.removeSqlite('sqlite-1'), path: '/api/databases/sqlite/sqlite-1', method: 'DELETE' },
    { name: 'removeContainer 带确认短语', invoke: (a: ReturnType<typeof createHttpDatabaseAdapter>) => a.removeContainer('ctr-1'), path: '/api/databases/ctr-1/container', method: 'DELETE' },
  ])('$name 请求正确的端点', async ({ invoke, path, method }) => {
    const { requests } = stubFetch(() => jsonResponse(method === 'POST' ? {} : { ok: true }))
    await invoke(createHttpDatabaseAdapter())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(path)
    expect(requests[0]!.init?.method).toBe(method)
  })

  it('removeSqlite 与 removeContainer 的确认短语按目标类型区分', async () => {
    const { requests } = stubFetch(() => jsonResponse({ ok: true }))
    const adapter = createHttpDatabaseAdapter()
    await adapter.removeSqlite('sqlite-1')
    await adapter.removeContainer('ctr-1')
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ confirm: 'DELETE_SQLITE_FILE' })
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ confirm: 'DELETE_CONTAINER_AND_DATA' })
  })

  it('创建容器只提交新建容器的目标字段，不携带逻辑库或账号', async () => {
    const { requests } = stubFetch(() => jsonResponse({ instance: {}, firewallPort: null }))
    await createHttpDatabaseAdapter().create({
      kind: 'container', engine: 'MySQL', versionTag: '8.4', containerName: 'elysian-mysql',
      imageId: 'sha256:abc', accessScope: 'any-host', hostPort: 43306, confirmPublic: true,
    })
    expect(requests[0]!.url).toBe('/api/databases/')
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      engine: 'MySQL', versionTag: '8.4', containerName: 'elysian-mysql', imageId: 'sha256:abc',
      accessScope: 'any-host', hostPort: 43306, confirmPublic: true,
    })
  })

  it('容器创建缺少镜像或版本时在前端挡下', async () => {
    const adapter = createHttpDatabaseAdapter()
    await expect(adapter.create({ kind: 'container', engine: 'Redis', versionTag: '', containerName: 'x', imageId: '', accessScope: 'localhost' })).rejects.toThrow('请选择数据库镜像版本')
  })
})

describe('createHttpDatabaseAdapter 401 拦截', () => {
  it('request 出口的 401：上报并抛中文登录失效错误', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '未登录或会话已过期' }, 401)))
    await expect(createHttpDatabaseAdapter().list()).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('非 401 错误照旧透传服务端 error 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '数据库服务未就绪' }, 503)))
    await expect(createHttpDatabaseAdapter().list()).rejects.toThrow('数据库服务未就绪')
  })

  it('downloadSqlite 的 401：上报、抛中文错误、不产生任何下载动作', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '未登录或会话已过期' }, 401)))
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    await expect(createHttpDatabaseAdapter().downloadSqlite?.('sqlite-demo')).rejects.toThrow(
      '登录状态已失效，请重新登录',
    )
    expect(listener).toHaveBeenCalledTimes(1)
    expect(clickSpy).not.toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('重新登录后旧 SQLite 下载的 401 仍拒绝下载，不使新会话失效', async () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { complete = resolve })))
    const pending = createHttpDatabaseAdapter().downloadSqlite?.('sqlite-demo')
    advanceAuthGeneration()
    complete(jsonResponse({ error: '未登录或会话已过期' }, 401))
    await expect(pending).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).not.toHaveBeenCalled()
  })

  it.each([false, true])('SQLite 上传 401 仍拒绝请求，仅当前登录代次上报（旧请求：%s）', async (stale) => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const file = new File(['sqlite-bytes'], 'demo.sqlite')
    const pending = createHttpDatabaseAdapter().create({ kind: 'file', engine: 'SQLite', name: 'demo', origin: 'uploaded', file })
    const xhr = FakeXHR.last
    if (stale) advanceAuthGeneration()
    xhr.onload?.()
    await expect(pending).rejects.toThrow('登录状态已失效，请重新登录')
    expect(listener).toHaveBeenCalledTimes(stale ? 0 : 1)
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('downloadSqlite 成功：fetch 取 blob 后经 object URL 触发下载并带文件名', async () => {
    const blob = new Blob(['sqlite-bytes'], { type: 'application/octet-stream' })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(blob, {
            status: 200,
            headers: { 'Content-Disposition': 'attachment; filename="demo.sqlite"' },
          }),
      ),
    )
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    await createHttpDatabaseAdapter().downloadSqlite?.('sqlite-demo')

    expect(clickSpy).toHaveBeenCalledTimes(1)
    const link = clickSpy.mock.instances[0] as HTMLAnchorElement
    expect(link.download).toBe('demo.sqlite')
    expect(link.href).toMatch(/^blob:/)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
    revokeSpy.mockRestore()
  })
})

describe('sqliteDownloadName', () => {
  it('从 Content-Disposition 解析文件名，UTF-8 与引号形态都接受', () => {
    expect(sqliteDownloadName('attachment; filename="demo.sqlite"', 'sqlite-1')).toBe('demo.sqlite')
    expect(sqliteDownloadName("attachment; filename*=UTF-8''demo.sqlite", 'sqlite-1')).toBe(
      'demo.sqlite',
    )
  })

  it('缺失或畸形时回退 id 加扩展名', () => {
    expect(sqliteDownloadName(null, 'sqlite-demo')).toBe('sqlite-demo.sqlite')
    expect(sqliteDownloadName('inline', 'sqlite-demo')).toBe('sqlite-demo.sqlite')
    expect(sqliteDownloadName('attachment; filename=""', 'sqlite-demo')).toBe(
      'sqlite-demo.sqlite',
    )
  })
})

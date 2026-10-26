import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceAuthGeneration, setUnauthorizedListener } from './unauthorized'
import { createHttpDatabaseAdapter, sqliteDownloadName } from './databaseHttpAdapter'

/*
 * 数据库 HTTP adapter 的 401 出口：request 出口、downloadSqlite 的 fetch blob 改造
 * （不再 <a href> 导航——401 有明确中文反馈、不把错误 JSON 当文件保存）。
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

describe('createHttpDatabaseAdapter 401 拦截', () => {
  it.each(['missing', 'blocked'])('WebSocket %s 时异步拒绝，供连接状态和通知统一收口', async failure => {
    vi.stubGlobal('WebSocket', failure === 'missing' ? undefined : class { constructor() { throw new DOMException('blocked', 'SecurityError') } })
    let pending: Promise<unknown> | undefined
    expect(() => { pending = createHttpDatabaseAdapter().openTerminal?.('db-1') }).not.toThrow()
    await expect(pending).rejects.toThrow('浏览器无法建立数据库终端连接')
  })

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

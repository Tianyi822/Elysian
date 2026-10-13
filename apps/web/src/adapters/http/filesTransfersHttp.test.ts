import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpFilesAdapter } from './filesHttpAdapter'
import { FILE_DOWNLOAD_PREPARE_TIMEOUT, FILE_TRANSFER_TIMEOUT, parseFileDownload } from './filesTransfersHttp'
import { FileTransferError } from '../filesTransferError'
import { advanceAuthGeneration, setUnauthorizedListener } from './unauthorized'

const prepared = { id: 'download-1', name: '日志 + 备份.tar.gz', sizeBytes: 3 * 1024 ** 3, expiresAt: '2030-01-01T00:00:00Z' }
const entry = { name: '备份 + %.zip', kind: 'file', mode: '644', owner: 'root', modifiedAt: '2026-10-11T00:00:00Z', sizeBytes: 3 }

class FakeXHR {
  static last: FakeXHR
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  timeout = 0
  status = 200
  responseText = JSON.stringify({ entry })
  onload?: () => void
  onabort?: () => void
  ontimeout?: () => void
  onerror?: () => void
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => this.onabort?.())
  constructor() { FakeXHR.last = this }
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('XMLHttpRequest', FakeXHR) })
afterEach(() => { document.querySelectorAll('iframe').forEach((frame) => frame.remove()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setUnauthorizedListener(() => {}) })

describe('文件传输 HTTP adapter', () => {
  it('下载准备只取元数据，目录长打包不套普通写请求的 60 秒超时', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(prepared)))
    vi.stubGlobal('fetch', fetcher)
    const result = await createHttpFilesAdapter().prepareDownload('/tmp/日志 + 备份')
    expect(result).toEqual(prepared)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/files/downloads')
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({ path: '/tmp/日志 + 备份' })
    expect(FILE_DOWNLOAD_PREPARE_TIMEOUT).toBe(30 * 60_000)
  })

  it('原生下载使用 iframe，无 download 属性，不读取 Blob；错误响应反馈用户', () => {
    const onError = vi.fn()
    const blob = vi.spyOn(Response.prototype, 'blob')
    createHttpFilesAdapter().startDownload(prepared, onError)
    const frame = document.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('/api/files/downloads/download-1')
    expect(frame.hasAttribute('download')).toBe(false)
    expect(frame.hidden).toBe(true)
    expect(blob).not.toHaveBeenCalled()
    // jsdom 不加载外部资源；注入同源错误页模拟 iframe 收到 JSON。
    Object.defineProperty(frame, 'contentDocument', { value: { body: { textContent: '{"error":"下载已过期"}' } } })
    frame.dispatchEvent(new Event('load'))
    expect(onError.mock.calls[0]?.[0].message).toBe('下载已过期')
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('准备后的会话失效仍走全局 401 拦截，不把 JSON 当附件', () => {
    const unauthorized = vi.fn()
    setUnauthorizedListener(unauthorized)
    const onError = vi.fn()
    createHttpFilesAdapter().startDownload(prepared, onError)
    const frame = document.querySelector('iframe')!
    Object.defineProperty(frame, 'contentDocument', { value: { body: { textContent: '{"error":"未登录或会话已过期"}' } } })
    frame.dispatchEvent(new Event('load'))
    expect(unauthorized).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0].status).toBe(401)
  })

  it('重新登录后旧下载的 401 只反馈下载失败，不使新会话失效', () => {
    const unauthorized = vi.fn()
    setUnauthorizedListener(unauthorized)
    const onError = vi.fn()
    createHttpFilesAdapter().startDownload(prepared, onError)
    const frame = document.querySelector('iframe')!
    advanceAuthGeneration()
    Object.defineProperty(frame, 'contentDocument', { value: { body: { textContent: '{"error":"未登录或会话已过期"}' } } })
    frame.dispatchEvent(new Event('load'))
    expect(unauthorized).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ status: 401, message: '未登录或会话已过期' })
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('检查同名条目并校验文件；409保留状态，401上报', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'replace', token: 'token', existing: entry }))))
    expect(await createHttpFilesAdapter().checkUpload('/tmp', entry.name, 3)).toMatchObject({ state: 'replace', token: 'token' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"目标已变化"}', { status: 409 })))
    await expect(createHttpFilesAdapter().checkUpload('/tmp', entry.name, 3)).rejects.toMatchObject({ status: 409 })
    const unauthorized = vi.fn()
    setUnauthorizedListener(unauthorized)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    await expect(createHttpFilesAdapter().prepareDownload('/tmp')).rejects.toMatchObject({ status: 401 })
    expect(unauthorized).toHaveBeenCalledOnce()
  })

  it('上传直接发送 File，路径编码一次，携带确认信息，进度与成功回读一致', async () => {
    const file = new File(['zip'], entry.name)
    const onProgress = vi.fn()
    const pending = createHttpFilesAdapter().uploadFile('/tmp/中文 + %', file, { state: 'replace', token: 'verified' }, true, { onProgress })
    const xhr = FakeXHR.last
    expect(xhr.open).toHaveBeenCalledWith('PUT', `/api/files/upload?dirPath=${encodeURIComponent('/tmp/中文 + %')}&name=${encodeURIComponent(entry.name)}`)
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-Elysian-Upload-Token', 'verified')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-Elysian-Upload-Overwrite', 'true')
    expect(xhr.send).toHaveBeenCalledWith(file)
    expect(xhr.timeout).toBe(FILE_TRANSFER_TIMEOUT)
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 })
    expect(onProgress).toHaveBeenCalledWith(33)
    xhr.onload?.()
    expect(await pending).toEqual(entry)
    expect(onProgress).toHaveBeenLastCalledWith(100)
  })

  it('上传取消会终止 XHR；超时、409、网络故障都不自动重发', async () => {
    const file = new File(['zip'], entry.name)
    const controller = new AbortController()
    const pending = createHttpFilesAdapter().uploadFile('/tmp', file, { state: 'create', token: 't' }, false, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeXHR.last.abort).toHaveBeenCalledOnce()
    for (const failure of ['conflict', 'timeout', 'network']) {
      const request = createHttpFilesAdapter().uploadFile('/tmp', file, { state: 'create', token: 't' }, false)
      const xhr = FakeXHR.last
      if (failure === 'conflict') { xhr.status = 409; xhr.responseText = '{"error":"目标已变化"}'; xhr.onload?.() }
      else if (failure === 'timeout') xhr.ontimeout?.()
      else xhr.onerror?.()
      await expect(request).rejects.toThrow(failure === 'conflict' ? '目标已变化' : '操作结果尚未确认')
      expect(xhr.send).toHaveBeenCalledOnce()
    }
  })

  it.each([false, true])('上传 401 仍拒绝请求，仅当前登录代次上报（旧请求：%s）', async (stale) => {
    const unauthorized = vi.fn()
    setUnauthorizedListener(unauthorized)
    const pending = createHttpFilesAdapter().uploadFile('/tmp', new File(['zip'], entry.name), { state: 'create', token: 't' }, false)
    const xhr = FakeXHR.last
    if (stale) advanceAuthGeneration()
    xhr.status = 401
    xhr.responseText = '{"error":"未登录或会话已过期"}'
    xhr.onload?.()
    await expect(pending).rejects.toMatchObject({ status: 401, message: '登录状态已失效，请重新登录' })
    expect(unauthorized).toHaveBeenCalledTimes(stale ? 0 : 1)
    expect(xhr.send).toHaveBeenCalledOnce()
  })

  it('拒绝无效下载标识与超过10GiB的上传，不发送请求', async () => {
    expect(() => parseFileDownload({ ...prepared, id: '../elsewhere' })).toThrow()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(createHttpFilesAdapter().checkUpload('/tmp', 'large', 10 * 1024 ** 3 + 1)).rejects.toBeInstanceOf(FileTransferError)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

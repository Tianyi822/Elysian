import type { FileEntry } from '@elysian/contracts'
import type { FileDownload, FilesAdapter, FileUploadCheck } from '../../contracts/adapters'
import { FileTransferError } from '../filesTransferError'
import { RequestTimeoutError, withRequestDeadline } from './requestDeadline'
import { captureAuthGeneration, fetchWithSession, reportUnauthorized, reportUnauthorizedStatus } from './unauthorized'

export const FILE_DOWNLOAD_PREPARE_TIMEOUT = 30 * 60_000
export const FILE_TRANSFER_TIMEOUT = 2 * 60 * 60_000
export const FILE_UPLOAD_MAX_BYTES = 10 * 1024 ** 3

type TransferMethods = Pick<FilesAdapter, 'prepareDownload' | 'startDownload' | 'checkUpload' | 'uploadFile'>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件传输响应格式无效')
  return value as Record<string, unknown>
}

function errorMessage(body: unknown, status: number): string {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error : `文件传输请求失败：HTTP ${status}`
}

export function parseFileDownload(body: unknown): FileDownload {
  const row = object(body)
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)
    || typeof row.name !== 'string' || !row.name
    || typeof row.sizeBytes !== 'number' || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0
    || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) {
    throw new Error('文件下载准备响应无效')
  }
  return { id: row.id, name: row.name, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt }
}

/** 长请求单独设时限，所有响应体只包含元数据，文件正文不进 fetch/Blob。 */
export function createHttpFileTransfers(
  baseUrl: string,
  parseEntry: (body: unknown) => FileEntry,
  parseEntryResponse: (body: unknown) => FileEntry,
): TransferMethods {
  const post = (endpoint: string, body: unknown, signal?: AbortSignal, timeout?: number) =>
    withRequestDeadline({ method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, async (init) => {
      let response: Response
      try { response = await fetchWithSession(`${baseUrl}/${endpoint}`, init) } catch (error) {
        if (init.signal?.aborted) throw error
        throw new Error('文件传输请求网络失败')
      }
      if (reportUnauthorized(response)) throw new FileTransferError(401, '登录状态已失效，请重新登录')
      const value: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new FileTransferError(response.status, errorMessage(value, response.status))
      return value
    }, timeout)

  return {
    async prepareDownload(path, signal) {
      return parseFileDownload(await post('downloads', { path }, signal, FILE_DOWNLOAD_PREPARE_TIMEOUT))
    },
    startDownload(download, onError) {
      const generation = captureAuthGeneration()
      // 不设置 download 属性：只有成功的 Content-Disposition 才触发保存，401/404 JSON 不会变成文件。
      const frame = document.createElement('iframe')
      frame.hidden = true
      frame.title = `下载 ${download.name}`
      let timer: ReturnType<typeof setTimeout>
      const cleanup = () => { clearTimeout(timer); frame.remove() }
      frame.onload = () => {
        try {
          const body = frame.contentDocument?.body?.textContent?.trim()
          if (!body) return // 初始 about:blank 或由浏览器接管的附件。
          const value: unknown = JSON.parse(body)
          const row = object(value)
          if (typeof row.error === 'string') {
            // iframe 不暴露 HTTP 状态；此文案是全局 RequireSession 的固定 401 响应。
            const status = row.error === '未登录或会话已过期' ? 401 : typeof row.status === 'number' ? row.status : 0
            reportUnauthorizedStatus(status, generation)
            onError?.(new FileTransferError(status, row.error))
          } else {
            onError?.(new Error('文件下载响应无效，请重新下载'))
          }
        } catch {
          onError?.(new Error('文件下载响应无效，请检查连接后重试'))
        }
        cleanup()
      }
      timer = setTimeout(cleanup, FILE_TRANSFER_TIMEOUT + 60_000)
      frame.src = `${baseUrl}/downloads/${encodeURIComponent(download.id)}`
      document.body.append(frame)
    },
    async checkUpload(dirPath, name, sizeBytes, signal) {
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > FILE_UPLOAD_MAX_BYTES) {
        throw new FileTransferError(413, '单文件上传大小不能超过 10 GiB')
      }
      const row = object(await post('uploads/check', { dirPath, name, sizeBytes }, signal))
      if ((row.state !== 'create' && row.state !== 'replace') || typeof row.token !== 'string' || !row.token) {
        throw new Error('上传检查响应无效')
      }
      const check: FileUploadCheck = { state: row.state, token: row.token }
      if (row.existing !== undefined) check.existing = parseEntry(row.existing)
      if (check.state === 'replace' && check.existing?.kind !== 'file') throw new Error('上传冲突响应无效')
      return check
    },
    uploadFile(dirPath, file, check, overwrite, options) {
      return new Promise<FileEntry>((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) { reject(new DOMException('上传已取消', 'AbortError')); return }
        const xhr = new XMLHttpRequest()
        const generation = captureAuthGeneration()
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const fail = (error: unknown) => { cleanup(); reject(error) }
        const abort = () => xhr.abort()
        xhr.open('PUT', `${baseUrl}/upload?dirPath=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(file.name)}`)
        xhr.timeout = FILE_TRANSFER_TIMEOUT
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.setRequestHeader('X-Elysian-Upload-Token', check.token)
        xhr.setRequestHeader('X-Elysian-Upload-Overwrite', String(overwrite))
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) options?.onProgress?.(Math.min(100, Math.floor(event.loaded / event.total * 100)))
        }
        xhr.onload = () => {
          if (reportUnauthorizedStatus(xhr.status, generation)) { fail(new FileTransferError(401, '登录状态已失效，请重新登录')); return }
          let value: unknown
          try { value = JSON.parse(xhr.responseText) } catch { value = null }
          if (xhr.status < 200 || xhr.status >= 300) { fail(new FileTransferError(xhr.status, errorMessage(value, xhr.status))); return }
          try {
            const entry = parseEntryResponse(value)
            cleanup()
            options?.onProgress?.(100)
            resolve(entry)
          } catch (error) { fail(error) }
        }
        xhr.onerror = () => fail(new Error('上传连接中断，操作结果尚未确认，请刷新目录后再决定是否重试'))
        xhr.ontimeout = () => fail(new RequestTimeoutError(true))
        xhr.onabort = () => fail(new DOMException('上传已取消，已完成的文件会保留', 'AbortError'))
        signal?.addEventListener('abort', abort, { once: true })
        try { xhr.send(file) } catch (error) { fail(error) }
      })
    },
  }
}

import type { FileEntry, FileKind, FileSearchResult } from '@elysian/contracts'
import { FILE_KINDS } from '@elysian/contracts'
import type { FilesAdapter } from '../../contracts/adapters'

/*
 * 浏览器侧同源文件管理（Docker 运行时）。cp/mv/tar/chmod 只存在于容器内的
 * server 片，这里只做 JSON 形状校验与中文错误翻译，风格与 usersHttpAdapter 一致。
 * 目录条目没有 sizeBytes（服务端省略该字段），解析时缺失或 null 都归一为 undefined。
 */

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('文件管理响应格式无效')
  }
  return value as Record<string, unknown>
}

/** 校验单个条目：名称、种类、权限、所有者、修改时间齐全，目录省略大小。 */
export function parseFileEntry(value: unknown): FileEntry {
  const row = asObject(value)
  if (
    typeof row.name !== 'string' ||
    typeof row.mode !== 'string' ||
    typeof row.owner !== 'string' ||
    typeof row.modifiedAt !== 'string'
  ) {
    throw new Error('文件条目响应无效')
  }
  const kind = row.kind
  if (typeof kind !== 'string' || !FILE_KINDS.includes(kind as FileKind)) {
    throw new Error('文件条目种类响应无效')
  }
  const sizeBytes = row.sizeBytes
  if (sizeBytes !== undefined && sizeBytes !== null && typeof sizeBytes !== 'number') {
    throw new Error('文件条目大小响应无效')
  }
  return {
    name: row.name,
    kind: kind as FileKind,
    mode: row.mode,
    owner: row.owner,
    sizeBytes: sizeBytes ?? undefined,
    modifiedAt: row.modifiedAt,
  }
}

/** 校验 GET /entries 响应：目录直接子项的数组（顺序不保证，排序由界面决定）。 */
export function parseFileListResponse(body: unknown): readonly FileEntry[] {
  const entries = asObject(body).entries
  if (!Array.isArray(entries)) {
    throw new Error('文件列表响应无效：应为数组')
  }
  return entries.map((entry) => parseFileEntry(entry))
}

/** 校验 GET /size 响应：递归求和后的总字节数。 */
export function parseFileSizeResponse(body: unknown): { totalBytes: number } {
  const totalBytes = asObject(body).totalBytes
  if (typeof totalBytes !== 'number') {
    throw new Error('文件大小响应无效')
  }
  return { totalBytes }
}

/** 校验 GET /search 响应：搜索结果数组，每项是条目本身外加绝对路径。 */
export function parseFileSearchResponse(body: unknown): readonly FileSearchResult[] {
  const results = asObject(body).results
  if (!Array.isArray(results)) {
    throw new Error('文件搜索响应无效：应为数组')
  }
  return results.map((result) => {
    const entry = parseFileEntry(result)
    const path = asObject(result).path
    if (typeof path !== 'string') {
      throw new Error('文件搜索结果路径响应无效')
    }
    return { ...entry, path }
  })
}

/** 校验 copy/move/rename/compress 响应：写操作完成后回读出的那一个条目。 */
export function parseFileEntryResponse(body: unknown): FileEntry {
  return parseFileEntry(asObject(asObject(body).entry))
}

/** 校验 POST /chmod 响应：只确认权限与属主已落盘，不携带条目数据。 */
export function parseFileOkResponse(body: unknown): void {
  if (asObject(body).ok !== true) {
    throw new Error('文件权限响应无效')
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('文件管理请求网络失败')
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `文件管理请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('文件管理响应不是有效 JSON')
  }
}

/**
 * Docker 运行时的文件管理 adapter：八个动作落到 /api/files/*。
 * GET 的 path 与 keyword 对整串做一次 encodeURIComponent（空格编成 %20、加号编成 %2B，
 * 绝不发送裸加号），POST 的参数只随 JSON body 走，无编码歧义。
 */
export function createHttpFilesAdapter(baseUrl = '/api/files'): FilesAdapter {
  const postJson = (endpoint: string, payload: Record<string, unknown>): Promise<unknown> =>
    requestJson(`${baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  return {
    async list(dirPath) {
      return parseFileListResponse(
        await requestJson(`${baseUrl}/entries?path=${encodeURIComponent(dirPath)}`),
      )
    },

    async size(dirPath) {
      return parseFileSizeResponse(
        await requestJson(`${baseUrl}/size?path=${encodeURIComponent(dirPath)}`),
      ).totalBytes
    },

    async copyEntry(srcPath, destDirPath) {
      return parseFileEntryResponse(await postJson('copy', { srcPath, destDirPath }))
    },

    async moveEntry(srcPath, destDirPath) {
      return parseFileEntryResponse(await postJson('move', { srcPath, destDirPath }))
    },

    async renameEntry(path, newName) {
      return parseFileEntryResponse(await postJson('rename', { path, newName }))
    },

    async compressEntry(path) {
      return parseFileEntryResponse(await postJson('compress', { path }))
    },

    async chmod(path, input) {
      parseFileOkResponse(
        await postJson('chmod', {
          path,
          mode: input.mode,
          owner: input.owner,
          recursive: input.recursive,
        }),
      )
    },

    async search(keyword) {
      return parseFileSearchResponse(
        await requestJson(`${baseUrl}/search?keyword=${encodeURIComponent(keyword)}`),
      )
    },
  }
}

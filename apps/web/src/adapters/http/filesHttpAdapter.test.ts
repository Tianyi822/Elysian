import { describe, expect, it, vi } from 'vitest'
import {
  createHttpFilesAdapter,
  parseFileEntry,
  parseFileEntryResponse,
  parseFileListResponse,
  parseFileOkResponse,
  parseFileSizeResponse,
  parseFileSearchResponse,
} from './filesHttpAdapter'

/*
 * 纯解析函数的契约测试 + fetch 接线断言，不发任何真实请求。
 * 真实形状样例对齐方案端点表：目录条目直接省略 sizeBytes（JSON.stringify 自然省略
 * undefined），mock 同形样例对齐 filesData 的 toEntry 输出，两者都必须放行。
 */

const realDirectoryRow = {
  name: 'nginx',
  kind: 'directory',
  mode: '755',
  owner: 'root',
  modifiedAt: '2026-09-12T08:40:00.000Z',
}

const realFileRow = {
  name: 'access.log',
  kind: 'file',
  mode: '640',
  owner: 'www-data',
  sizeBytes: 8241067,
  modifiedAt: '2026-09-15T23:35:00.000Z',
}

const mockFileRow = {
  name: 'deploy.sh',
  kind: 'file',
  mode: '755',
  owner: 'deploy',
  sizeBytes: 4820,
  modifiedAt: '2026-09-08T09:20:00+08:00',
}

describe('parseFileEntry', () => {
  it('接受真实目录条目：无 sizeBytes 字段，解析结果归一为 undefined', () => {
    expect(parseFileEntry(realDirectoryRow)).toEqual(realDirectoryRow)
    expect(parseFileEntry(realDirectoryRow).sizeBytes).toBeUndefined()
  })

  it('接受 sizeBytes 为 null 的条目，同样归一为 undefined', () => {
    expect(parseFileEntry({ ...realDirectoryRow, sizeBytes: null })).toEqual(realDirectoryRow)
  })

  it('接受真实文件条目与 mock 同形条目（中文属主、带时区的种子时间）', () => {
    expect(parseFileEntry(realFileRow)).toEqual(realFileRow)
    expect(parseFileEntry(mockFileRow)).toEqual(mockFileRow)
  })

  it('非对象、缺字段或类型不对时抛中文错误', () => {
    expect(() => parseFileEntry(null)).toThrow('文件管理响应格式无效')
    expect(() => parseFileEntry('nginx')).toThrow('文件管理响应格式无效')
    expect(() => parseFileEntry({ ...realFileRow, name: 7 })).toThrow('文件条目响应无效')
    expect(() => parseFileEntry({ ...realFileRow, mode: 0o755 })).toThrow('文件条目响应无效')
    expect(() => parseFileEntry({ ...realFileRow, owner: null })).toThrow('文件条目响应无效')
    expect(() => parseFileEntry({ ...realFileRow, modifiedAt: 20260912 })).toThrow(
      '文件条目响应无效',
    )
  })

  it('kind 不在契约枚举里时按字段报错', () => {
    expect(() => parseFileEntry({ ...realFileRow, kind: 'symlink' })).toThrow(
      '文件条目种类响应无效',
    )
    expect(() => parseFileEntry({ ...realFileRow, kind: 'DIRECTORY' })).toThrow(
      '文件条目种类响应无效',
    )
  })

  it('sizeBytes 存在时只接受 number，其余类型抛中文错误', () => {
    expect(() => parseFileEntry({ ...realFileRow, sizeBytes: '8241067' })).toThrow(
      '文件条目大小响应无效',
    )
    expect(() => parseFileEntry({ ...realFileRow, sizeBytes: false })).toThrow(
      '文件条目大小响应无效',
    )
  })
})

describe('parseFileListResponse', () => {
  it('接受条目数组并逐条校验，空目录返回空数组', () => {
    expect(parseFileListResponse({ entries: [realDirectoryRow, mockFileRow] })).toEqual([
      realDirectoryRow,
      mockFileRow,
    ])
    expect(parseFileListResponse({ entries: [] })).toEqual([])
  })

  it('缺数组或条目坏时抛中文错误', () => {
    expect(() => parseFileListResponse({})).toThrow('文件列表响应无效：应为数组')
    expect(() => parseFileListResponse({ entries: 'nope' })).toThrow('文件列表响应无效：应为数组')
    expect(() => parseFileListResponse({ entries: [{ ...realFileRow, kind: 'fifo' }] })).toThrow(
      '文件条目种类响应无效',
    )
  })
})

describe('parseFileSizeResponse', () => {
  it('接受递归求和后的总字节数，非数字抛中文错误', () => {
    expect(parseFileSizeResponse({ totalBytes: 0 })).toEqual({ totalBytes: 0 })
    expect(parseFileSizeResponse({ totalBytes: 4821_340 })).toEqual({ totalBytes: 4821_340 })
    expect(() => parseFileSizeResponse({ totalBytes: '1024' })).toThrow('文件大小响应无效')
    expect(() => parseFileSizeResponse({})).toThrow('文件大小响应无效')
    expect(() => parseFileSizeResponse(null)).toThrow('文件管理响应格式无效')
  })
})

describe('parseFileSearchResponse', () => {
  it('接受带绝对路径的搜索结果数组', () => {
    const results = parseFileSearchResponse({ results: [{ ...mockFileRow, path: '/home/deploy/deploy.sh' }] })
    expect(results).toEqual([{ ...mockFileRow, path: '/home/deploy/deploy.sh' }])
  })

  it('缺数组、缺 path 或条目坏时抛中文错误', () => {
    expect(() => parseFileSearchResponse({})).toThrow('文件搜索响应无效：应为数组')
    expect(() => parseFileSearchResponse({ results: 'nope' })).toThrow('文件搜索响应无效：应为数组')
    expect(() => parseFileSearchResponse({ results: [{ ...mockFileRow, path: 7 }] })).toThrow(
      '文件搜索结果路径响应无效',
    )
    expect(() => parseFileSearchResponse({ results: [mockFileRow] })).toThrow(
      '文件搜索结果路径响应无效',
    )
  })
})

describe('parseFileEntryResponse', () => {
  it('接受写操作后回读出的那一个条目（复制、移动、重命名与压缩同形）', () => {
    expect(parseFileEntryResponse({ entry: realFileRow })).toEqual(realFileRow)
    expect(parseFileEntryResponse({ entry: realDirectoryRow })).toEqual(realDirectoryRow)
  })

  it('缺 entry 或 entry 非对象时抛中文错误', () => {
    expect(() => parseFileEntryResponse({})).toThrow('文件管理响应格式无效')
    expect(() => parseFileEntryResponse({ entry: null })).toThrow('文件管理响应格式无效')
  })
})

describe('parseFileOkResponse', () => {
  it('接受 { ok: true }，其余形状抛中文错误', () => {
    expect(parseFileOkResponse({ ok: true })).toBeUndefined()
    expect(() => parseFileOkResponse({ ok: false })).toThrow('文件权限响应无效')
    expect(() => parseFileOkResponse(null)).toThrow('文件管理响应格式无效')
  })
})

describe('createHttpFilesAdapter', () => {
  it('GET 的 path 与 keyword 对整串做一次 encodeURIComponent，绝不发送裸加号', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      jsonResponse(
        typeof url === 'string' && url.includes('/search')
          ? { results: [] }
          : typeof url === 'string' && url.includes('/size')
            ? { totalBytes: 1024 }
            : { entries: [] },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpFilesAdapter()
    await adapter.list('/var/log/nginx+old')
    await adapter.search('部署 脚本.sh')
    await adapter.size('/var/log')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/files/entries?path=%2Fvar%2Flog%2Fnginx%2Bold', undefined)
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/files/search?keyword=%E9%83%A8%E7%BD%B2%20%E8%84%9A%E6%9C%AC.sh', undefined)
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/files/size?path=%2Fvar%2Flog', undefined)
    vi.unstubAllGlobals()
  })

  it('copy/move/rename/compress 分别落到各自端点，body 形状对齐端点表', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entry: realFileRow }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpFilesAdapter()
    await adapter.copyEntry('/var/log/auth.log', '/tmp')
    await adapter.moveEntry('/var/log/auth.log', '/tmp')
    await adapter.renameEntry('/tmp/auth.log', 'auth.log.bak')
    await adapter.compressEntry('/tmp/auth.log')
    const post = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/files/copy', post({ srcPath: '/var/log/auth.log', destDirPath: '/tmp' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/files/move', post({ srcPath: '/var/log/auth.log', destDirPath: '/tmp' }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/files/rename', post({ path: '/tmp/auth.log', newName: 'auth.log.bak' }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/files/compress', post({ path: '/tmp/auth.log' }))
    vi.unstubAllGlobals()
  })

  it('POST 的参数只随 JSON body 走，并带 JSON 内容类型', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpFilesAdapter()
    await adapter.chmod('/tmp/报表', { mode: '755', owner: 'root', recursive: false })
    expect(fetchMock).toHaveBeenCalledWith('/api/files/chmod', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/报表', mode: '755', owner: 'root', recursive: false }),
    })
    vi.unstubAllGlobals()
  })

  it('非 2xx 时把响应体的 error 字段抬成错误消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: '目录不存在：/var/log' }, { status: 400 })),
    )
    const adapter = createHttpFilesAdapter()
    await expect(adapter.list('/var/log')).rejects.toThrow('目录不存在：/var/log')
    vi.unstubAllGlobals()
  })

  it('非 2xx 且无 error 字段时按状态码报中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const adapter = createHttpFilesAdapter()
    await expect(adapter.size('/var/log')).rejects.toThrow('文件管理请求失败：HTTP 503')
    vi.unstubAllGlobals()
  })

  it('网络失败与非法 JSON 分别抛对应中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const adapter = createHttpFilesAdapter()
    await expect(adapter.search('log')).rejects.toThrow('文件管理请求网络失败')
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(adapter.search('log')).rejects.toThrow('文件管理响应不是有效 JSON')
    vi.unstubAllGlobals()
  })
})

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

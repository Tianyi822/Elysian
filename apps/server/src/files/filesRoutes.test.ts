import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import { invalidRequest } from '../middleware/guard.ts'
import { FILES_MOUNT, createFilesApp, type FilesAppDeps, type FilesService } from './filesRoutes'

/*
 * 文件管理路由的行为测试：fake service 注入，app.request 驱动，不执行任何真实命令。
 * 守卫用例与安全区三片同源（503 整片含未知路径、跨源 403 先于读体、415/413 双拦、
 * 404 兜底剥挂载前缀）；query 编码往返锚定「整串 encodeURIComponent」的传输契约。
 */

const SAMPLE_ENTRY: FileEntry = {
  name: 'nginx.conf',
  kind: 'file',
  mode: '644',
  owner: 'root',
  sizeBytes: 1478,
  modifiedAt: '2026-09-16T07:35:00.000Z',
}

const SAMPLE_RESULT: FileSearchResult = { ...SAMPLE_ENTRY, path: '/etc/nginx/nginx.conf' }

function createFakeService(overrides: Partial<FilesService> = {}): FilesService {
  return {
    list: async () => [SAMPLE_ENTRY],
    size: async () => 4096,
    copyEntry: async () => SAMPLE_ENTRY,
    moveEntry: async () => SAMPLE_ENTRY,
    renameEntry: async () => SAMPLE_ENTRY,
    compressEntry: async () => SAMPLE_ENTRY,
    chmod: async () => undefined,
    search: async () => [SAMPLE_RESULT],
    ...overrides,
  }
}

const SAME_ORIGIN_HEADERS = {
  // 同源合法头：Origin 与 Host 一致；带体请求声明 JSON 与真实长度。
  host: 'localhost:5173',
  origin: 'http://localhost:5173',
}

/** 构造直连子应用的请求（守卫头齐全；带体时补 JSON 声明与真实长度）。 */
function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: {
      ...SAME_ORIGIN_HEADERS,
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

/** 构造原始体的请求：body 是未序列化的原文（守卫用例里故意给坏 JSON 或坏 Content-Type）。 */
function rawReq(method: string, path: string, payload: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: { ...SAME_ORIGIN_HEADERS, ...headers },
    body: payload,
  })
}

/** 挂到 strict:false 父应用的形态（app.ts 的真实挂载方式），锚定挂载后行为。 */
function mountedApp(deps: FilesAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.route(FILES_MOUNT, createFilesApp(deps))
  return parent
}

const AVAILABLE: FilesAppDeps = { available: true, service: createFakeService() }

describe('createFilesApp', () => {
  it('不可用时一律 503（容器边界保护，含未知路径与写方法）', async () => {
    const app = createFilesApp({ available: false })
    for (const [method, path, body] of [
      ['GET', '/entries?path=%2Fvar%2Flog', undefined],
      ['GET', '/size?path=%2Fvar%2Flog', undefined],
      ['GET', '/search?keyword=log', undefined],
      ['POST', '/copy', { srcPath: '/a', destDirPath: '/b' }],
      ['POST', '/chmod', { path: '/a', mode: '755', owner: 'root', recursive: false }],
      ['GET', '/nowhere', undefined],
    ] as const) {
      const res = await app.request(req(method, path, body))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实文件管理仅在 Docker 容器内可用' })
    }
  })

  it('GET 三端点透传 query 并按契约形状回包', async () => {
    const app = createFilesApp(AVAILABLE)
    const entries = await app.request(req('GET', '/entries?path=%2Fvar%2Flog'))
    expect(entries.status).toBe(200)
    expect(await entries.json()).toEqual({ entries: [SAMPLE_ENTRY] })

    const size = await app.request(req('GET', '/size?path=%2Fvar%2Flog'))
    expect(await size.json()).toEqual({ totalBytes: 4096 })

    const search = await app.request(req('GET', '/search?keyword=log'))
    expect(await search.json()).toEqual({ results: [SAMPLE_RESULT] })
  })

  it('query 编码整串往返：`+`、中文、空格、`?`、`&` 解码后原样到达 service', async () => {
    const seen: string[] = []
    const service = createFakeService({
      list: async (dirPath) => {
        seen.push(dirPath)
        return []
      },
    })
    const app = createFilesApp({ available: true, service })
    const encoded = encodeURIComponent('/var/日志 a+b?c&d')
    const res = await app.request(req('GET', `/entries?path=${encoded}`))
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/var/日志 a+b?c&d'])
  })

  it('缺 path 的 GET 是 400；缺省 keyword 当空串透传（空关键词返回空数组）', async () => {
    const app = createFilesApp(AVAILABLE)
    const missing = await app.request(req('GET', '/entries'))
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toBe('缺少路径参数')

    const sizeMissing = await app.request(req('GET', '/size'))
    expect(sizeMissing.status).toBe(400)

    const keywords: string[] = []
    const searchService = createFakeService({
      search: async (keyword) => {
        keywords.push(keyword)
        return []
      },
    })
    const searchApp = createFilesApp({ available: true, service: searchService })
    await searchApp.request(req('GET', '/search'))
    await searchApp.request(req('GET', '/search?keyword='))
    expect(keywords).toEqual(['', ''])
  })

  it('POST 五端点透传 body 字段，形状不对以中文错误返回 400', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      copyEntry: async (srcPath, destDirPath) => {
        calls.push(['copy', srcPath, destDirPath])
        return SAMPLE_ENTRY
      },
      moveEntry: async (srcPath, destDirPath) => {
        calls.push(['move', srcPath, destDirPath])
        return SAMPLE_ENTRY
      },
      renameEntry: async (path, newName) => {
        calls.push(['rename', path, newName])
        return SAMPLE_ENTRY
      },
      compressEntry: async (path) => {
        calls.push(['compress', path])
        return SAMPLE_ENTRY
      },
      chmod: async (path, input) => {
        calls.push(['chmod', path, input])
      },
    })
    const app = createFilesApp({ available: true, service })

    await app.request(req('POST', '/copy', { srcPath: '/var/www/index.html', destDirPath: '/tmp' }))
    await app.request(req('POST', '/move', { srcPath: '/var/www', destDirPath: '/tmp' }))
    await app.request(req('POST', '/rename', { path: '/var/www/index.html', newName: ' home.html ' }))
    await app.request(req('POST', '/compress', { path: '/etc/nginx' }))
    await app.request(req('POST', '/chmod', { path: '/etc/nginx', mode: '755', owner: 'deploy', recursive: true }))
    expect(calls).toEqual([
      ['copy', '/var/www/index.html', '/tmp'],
      ['move', '/var/www', '/tmp'],
      ['rename', '/var/www/index.html', ' home.html '],
      ['compress', '/etc/nginx'],
      ['chmod', '/etc/nginx', { mode: '755', owner: 'deploy', recursive: true }],
    ])

    const noSrc = await app.request(req('POST', '/copy', { destDirPath: '/tmp' }))
    expect(noSrc.status).toBe(400)
    expect(((await noSrc.json()) as { error: string }).error).toBe('源路径请求体无效')

    const noDest = await app.request(req('POST', '/move', { srcPath: '/a' }))
    expect(((await noDest.json()) as { error: string }).error).toBe('目标目录请求体无效')

    const noNewName = await app.request(req('POST', '/rename', { path: '/a' }))
    expect(((await noNewName.json()) as { error: string }).error).toBe('新名称请求体无效')

    const noPath = await app.request(req('POST', '/compress', {}))
    expect(((await noPath.json()) as { error: string }).error).toBe('路径请求体无效')

    const noMode = await app.request(req('POST', '/chmod', { path: '/a', owner: 'root', recursive: false }))
    expect(((await noMode.json()) as { error: string }).error).toBe('权限位请求体无效')

    const noOwner = await app.request(req('POST', '/chmod', { path: '/a', mode: '755', recursive: false }))
    expect(((await noOwner.json()) as { error: string }).error).toBe('所有者请求体无效')

    const badRecursive = await app.request(req('POST', '/chmod', { path: '/a', mode: '755', owner: 'root', recursive: '是' }))
    expect(((await badRecursive.json()) as { error: string }).error).toBe('递归标记需为布尔值')
  })

  it('chmod 成功响应 ok；请求被拒按 400 返回，系统侧失败才是 500', async () => {
    const ok = await createFilesApp(AVAILABLE).request(
      req('POST', '/chmod', { path: '/etc/nginx', mode: '755', owner: 'root', recursive: false }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })

    const rejected = createFilesApp({
      available: true,
      service: createFakeService({
        list: async () => {
          throw invalidRequest('目录不存在：/nope')
        },
      }),
    })
    const rejectedResponse = await rejected.request(req('GET', '/entries?path=%2Fnope'))
    expect(rejectedResponse.status).toBe(400)
    expect(await rejectedResponse.json()).toEqual({ error: '目录不存在：/nope' })

    const broken = createFilesApp({
      available: true,
      service: createFakeService({
        copyEntry: async () => {
          throw new Error('cp 执行失败（cp -a /a /b/a）：目标已存在')
        },
      }),
    })
    const brokenResponse = await broken.request(req('POST', '/copy', { srcPath: '/a', destDirPath: '/b' }))
    expect(brokenResponse.status).toBe(500)
    expect(await brokenResponse.json()).toEqual({ error: 'cp 执行失败（cp -a /a /b/a）：目标已存在' })
  })

  it('跨源 POST 在读体之前返回 403', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      copyEntry: async (srcPath, destDirPath) => {
        calls.push([srcPath, destDirPath])
        return SAMPLE_ENTRY
      },
    })
    const app = createFilesApp({ available: true, service })
    // 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 500 的解析错误而非 403。
    const res = await app.request(rawReq('POST', '/copy', 'not-json', { origin: 'http://evil.example', 'content-type': 'application/json' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
    expect(calls).toEqual([])
  })

  it('text/plain 的写请求返回 415；空体与坏 JSON 返回 400', async () => {
    const app = createFilesApp(AVAILABLE)
    const plain = await app.request(rawReq('POST', '/copy', '{}', { 'content-type': 'text/plain' }))
    expect(plain.status).toBe(415)
    expect(await plain.json()).toEqual({ error: 'Content-Type 必须为 application/json' })

    const empty = await app.request(rawReq('POST', '/copy', '', { 'content-type': 'application/json' }))
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: '请求体不能为空' })

    const bad = await app.request(rawReq('POST', '/copy', 'not-json', { 'content-type': 'application/json' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '请求体不是有效 JSON' })
  })

  it('请求体超过 64 KiB 返回 413（申报与实读都拦）', async () => {
    const app = createFilesApp(AVAILABLE)

    // 申报即超限：不看流直接拒。
    const declared = new Request('http://localhost:5173/copy', {
      method: 'POST',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
    })
    expect((await app.request(declared)).status).toBe(413)

    // 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
    const oversized = `{"srcPath":"${'a'.repeat(64 * 1024)}","destDirPath":"/tmp"}`
    const lied = new Request('http://localhost:5173/copy', {
      method: 'POST',
      headers: {
        ...SAME_ORIGIN_HEADERS,
        'content-type': 'application/json',
        'content-length': '2',
      },
      body: oversized,
    })
    const liedRes = await app.request(lied)
    expect(liedRes.status).toBe(413)
    expect(await liedRes.json()).toEqual({ error: '请求体过大' })
  })

  it('GET 放行同源头缺失的请求（无 Origin 头）', async () => {
    const res = await createFilesApp(AVAILABLE).request(new Request('http://localhost:5173/entries?path=%2Fvar%2Flog'))
    expect(res.status).toBe(200)
  })

  it('同源 application/json 写请求正常通过守卫；大小写归一放行', async () => {
    const app = createFilesApp(AVAILABLE)
    const res = await app.request(req('POST', '/compress', { path: '/etc/nginx' }))
    expect(res.status).toBe(200)

    const relaxed = await app.request(
      rawReq('POST', '/compress', '{"path":"/etc/nginx"}', {
        host: 'LOCALHOST:5173',
        origin: 'http://localhost:5173',
        'content-type': 'application/json; charset=utf-8',
      }),
    )
    expect(relaxed.status).toBe(200)
  })
})

describe('挂载后行为（app.ts 以 strict:false 父应用挂到 FILES_MOUNT）', () => {
  it('未知端点 404 文案剥掉挂载前缀：相对路径与安全区三片格式一致', async () => {
    const app = mountedApp(AVAILABLE)
    const res = await app.request(req('GET', '/api/files/nowhere'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知文件管理端点：GET /nowhere' })

    const deeper = await app.request(req('POST', '/api/files/nope/deeper', {}))
    expect(deeper.status).toBe(404)
    expect(await deeper.json()).toEqual({ error: '未知文件管理端点：POST /nope/deeper' })
  })

  it('不可用时挂载后同样整片 503，未知路径不漏成 404', async () => {
    const app = mountedApp({ available: false })
    const res = await app.request(req('GET', '/api/files/entries?path=%2Fvar%2Flog'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: '真实文件管理仅在 Docker 容器内可用' })
  })
})

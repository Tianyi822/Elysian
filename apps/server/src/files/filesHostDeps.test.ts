import { describe, expect, it } from 'vitest'
import type { Dirent, Stats } from 'node:fs'
import { createFilesApp } from './filesRoutes'
import { createFilesHostDeps, resolveFilesAvailability, type FilesHostDepsOptions } from './filesHostDeps'
import type { FilesHostDeps } from './filesService'

/*
 * 容器硬边界的测试锚定：可用性的推导（ELYSIAN_DOCKER=1 且 /.dockerenv 存在）与
 * 接线装配在这里钉住——改坏判定会让用例变红，而不是静默漏到宿主机执行
 * cp/mv/tar/chmod/chown 或 readdir 宿主文件系统。全部用注入的环境与 fake deps
 * 驱动，不依赖宿主机状态、不执行任何真实命令。
 */

const MTIME = new Date('2026-09-16T07:35:00Z')

type FlatNode = { kind: 'file' | 'dir'; size: number }

/** 只够读路径走通的最小内存树；任何写命令被调用即抛错——硬边界被改坏时用例立刻红。 */
function createListOnlyDeps(): FilesHostDeps {
  const tree = new Map<string, FlatNode>([
    ['/var/log', { kind: 'dir', size: 0 }],
    ['/var/log/syslog', { kind: 'file', size: 219_530 }],
    ['/var/log/nginx', { kind: 'dir', size: 0 }],
    ['/var/log/nginx/access.log', { kind: 'file', size: 8241 }],
    ['/etc', { kind: 'dir', size: 0 }],
  ])
  const fail = (name: string) => () => {
    throw new Error(`测试内不得执行真实命令：${name}`)
  }
  const statsOf = (path: string): Stats => {
    const node = tree.get(path)!
    return {
      isDirectory: () => node.kind === 'dir',
      isSymbolicLink: () => false,
      isFile: () => node.kind === 'file',
      size: node.size,
      mode: node.kind === 'dir' ? 0o755 : 0o644,
      uid: 0,
      mtime: MTIME,
    } as unknown as Stats
  }
  return {
    async readdir(path) {
      if (!tree.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const names = [...tree.keys()]
        .filter((candidate) => candidate.startsWith(`${path === '/' ? '' : path}/`))
        .map((candidate) => candidate.slice(path === '/' ? 1 : path.length + 1))
        .filter((name) => name.length > 0 && !name.includes('/'))
      return names.map((name) => ({ name } as unknown as Dirent))
    },
    async lstat(path) {
      if (!tree.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return statsOf(path)
    },
    async stat(path) {
      return this.lstat(path)
    },
    async realpath(path) {
      if (!tree.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return path
    },
    renamePath: fail('rename'),
    mkdir: fail('mkdir'),
    rmPath: fail('rm'),
    runCp: fail('cp'),
    runMv: fail('mv'),
    runTar: fail('tar'),
    runGetent: async (args) => {
      if (args[0] === 'passwd') return 'root:x:0:0:root:/root:/bin/bash\n'
      throw new Error(`测试内不支持的 getent 调用：${args.join(' ')}`)
    },
    chmodNoFollow: fail('chmodNoFollow'),
    chownNoFollow: fail('chownNoFollow'),
    homeDir: () => '/root',
  }
}

/** 由注入的装配选项直接建起可请求的路由应用：断言只关心状态码与响应体，不依赖驱动时序。 */
function appFrom(options: FilesHostDepsOptions) {
  return createFilesApp(createFilesHostDeps(options))
}

/** 同源合法头的请求桩：带体时声明 JSON 与真实长度。 */
function fakeReq(method: string, url: string, body?: unknown): Request {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Request(`http://localhost:5173${url}`, {
    method,
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      ...(payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
  })
}

describe('resolveFilesAvailability', () => {
  it('两项条件同时满足才可用：环境声明 Docker 编排 + /.dockerenv 证明真的在容器内', () => {
    expect(resolveFilesAvailability({ ELYSIAN_DOCKER: '1' }, true)).toBe(true)
    expect(resolveFilesAvailability({ ELYSIAN_DOCKER: '1' }, false)).toBe(false)
    expect(resolveFilesAvailability({ ELYSIAN_DOCKER: '0' }, true)).toBe(false)
    expect(resolveFilesAvailability({}, true)).toBe(false)
  })
})

describe('createFilesHostDeps 硬边界', () => {
  it('环境未声明 Docker（即使 /.dockerenv 存在，如在容器里手动起 dev）：一律 503，不触达真实文件系统', async () => {
    const app = appFrom({ env: {}, dockerenvExists: true, deps: createListOnlyDeps() })
    for (const [method, url, body] of [
      ['GET', '/entries?path=%2Fvar%2Flog', undefined],
      ['GET', '/size?path=%2Fvar%2Flog', undefined],
      ['GET', '/search?keyword=log', undefined],
      ['POST', '/copy', { srcPath: '/a', destDirPath: '/b' }],
      ['POST', '/chmod', { path: '/a', mode: '755', owner: 'root', recursive: false }],
      ['GET', '/nowhere', undefined],
    ] as const) {
      const res = await app.request(fakeReq(method, url, body))
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: '真实文件管理仅在 Docker 容器内可用' })
    }
  })

  it('声明了 Docker 但进程不在容器内（/.dockerenv 缺失，宿主机 dev/preview）：一律 503', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: false,
      deps: createListOnlyDeps(),
    })
    const res = await app.request(fakeReq('GET', '/entries?path=%2Fvar%2Flog'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: '真实文件管理仅在 Docker 容器内可用' })
  })

  it('两项条件满足时挂真实 service：读请求经守卫到达注入的 fake deps，宿主机零副作用', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createListOnlyDeps(),
    })
    const res = await app.request(fakeReq('GET', '/entries?path=%2Fvar%2Flog'))
    expect(res.status).toBe(200)
    // 目录条目整个省略 sizeBytes 字段（undefined 经 JSON.stringify 自然消失）。
    expect(await res.json()).toEqual({
      entries: [
        { name: 'syslog', kind: 'file', mode: '644', owner: 'root', sizeBytes: 219_530, modifiedAt: MTIME.toISOString() },
        { name: 'nginx', kind: 'directory', mode: '755', owner: 'root', modifiedAt: MTIME.toISOString() },
      ],
    })
  })

  it('真实 service 的路径判据经 HTTP 生效：`.` 段路径被 400 拒绝（中文文案带原样入参）', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createListOnlyDeps(),
    })
    const res = await app.request(fakeReq('GET', `/entries?path=${encodeURIComponent('/var/./log')}`))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '无效的文件路径：/var/./log' })
  })

  it('注入的 fake deps 不触碰真实文件系统：写命令被调用即抛错（硬边界回归锚）', async () => {
    const app = appFrom({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      deps: createListOnlyDeps(),
    })
    // 走完整真实 service 链路（校验全过）后落到注入的宿主原语：抛错映射 500，不执行任何真实命令。
    // 写链的首个原语是暂存目录 mkdir（cp/tar 只写私有暂存目录，最后 rename 发布），
    // 它同样只在注入的 deps 上执行——测试里绝不落到宿主机。
    const res = await app.request(fakeReq('POST', '/copy', { srcPath: '/var/log/syslog', destDirPath: '/etc' }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('测试内不得执行真实命令')
    expect(body.error).toContain('mkdir')
  })
})

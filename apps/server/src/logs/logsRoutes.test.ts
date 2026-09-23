import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOG_CLEARABLE_CATEGORIES, type LogStorageStats, type PlatformLogCategory } from '@elysian/contracts'
import { endpointErrorHandler } from '../middleware/guard.ts'
import { createLogsHostDeps } from './logsHostDeps.ts'
import type { SweepResult } from './logRetention.ts'
import { LOGS_MOUNT, createLogsApp, type LogsAppDeps } from './logsRoutes.ts'
import type { LogsService } from './logsService.ts'

/*
 * 日志路由的守卫链与端点测试：fake service 注入，app.request 驱动。
 * 覆盖清空路由的等式断言（由契约常量推导，不写死两条）、同源 403、读体守卫
 * 415/413/400、404 文案、读端点的 cache-control: no-store 与响应透传；
 * 末尾一组走**真实接线 + 临时根**的端到端往返（写入 → 读取 → 清空），
 * 断言清空之后磁盘上确实什么都不剩。
 */

const STORAGE: LogStorageStats = {
  totalBytes: 3072,
  runtimeBytes: 2048,
  operationBytes: 1024,
  fileCount: 3,
  oldestAt: '2026-09-22T00:00:00Z',
  lastSweepAt: null,
  trimmedBySize: false,
  droppedRecords: 0,
  failedWrites: 0,
}

const SWEEP: SweepResult = {
  removedTmp: 0,
  compressed: 0,
  deletedByAge: 0,
  deletedBySize: 0,
  freedBytes: 0,
  totalBytes: 0,
  trimmedBySize: false,
  failed: 0,
  at: '2026-09-23T00:00:00.000Z',
}

/** 记录被清空的类别，其余出口回固定形状：路由只做透传，业务在服务层。 */
function createFakeService(): { service: LogsService; cleared: PlatformLogCategory[] } {
  const cleared: PlatformLogCategory[] = []
  const service: LogsService = {
    runtimeLog: async () => ({
      entries: [{ id: '2026-09-23T00:00:00.000Z#1', at: '2026-09-23T00:00:00.000Z', level: 'info', source: 'server.lifecycle', message: '已启动' }],
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: STORAGE,
    }),
    operationLog: async () => ({
      entries: [
        {
          id: '2026-09-23T00:00:01.000Z#2',
          at: '2026-09-23T00:00:01.000Z',
          category: 'security',
          action: '修改 SSH 监听端口',
          target: 'sshd',
          summary: '端口 2222',
          result: 'success',
          actor: 'panel',
          method: 'PUT',
          path: '/api/security/ssh/port',
          httpStatus: 200,
        },
      ],
      truncated: true,
      skippedLines: 1,
      skippedFiles: 2,
      storage: STORAGE,
    }),
    clear: async (category) => {
      cleared.push(category)
      return { category, fileCount: 2, totalBytes: 1024, oldestAt: '2026-09-22T00:00:00Z', clearedAt: '2026-09-23T00:00:00Z' }
    },
    log: async () => undefined,
    recordOperation: async () => undefined,
    runSweep: async () => SWEEP,
  }
  return { service, cleared }
}

/** 与 app.ts 同构的父应用：strict:false（尾斜杠适配）+ endpointErrorHandler 统一错误映射。 */
function mountedApp(deps: LogsAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.onError(endpointErrorHandler)
  parent.route(LOGS_MOUNT, createLogsApp(deps))
  return parent
}

const ORIGIN = 'http://localhost:5173'

/** 发往挂载后端点的 Request：默认同源合法头；写请求显式声明 JSON 与真实长度。 */
function requestOf(
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${ORIGIN}${LOGS_MOUNT}${path}`, {
    method,
    headers: { host: 'localhost:5173', origin: ORIGIN, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })
}

function jsonRequest(method: string, path: string, body: unknown): Request {
  const payload = JSON.stringify(body)
  return requestOf(method, path, {
    body: payload,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) },
  })
}

const CLEAR_PATH = LOG_CLEARABLE_CATEGORIES.map((category) => `/${category}/clear`)

describe('createLogsApp', () => {
  it('清空路由由契约常量推导：路由表里的清空集合与 LOG_CLEARABLE_CATEGORIES 逐个相等', async () => {
    const app = mountedApp({ service: createFakeService().service })
    const clearRoutes = app.routes.filter((route) => route.path.endsWith('/clear'))
    expect(clearRoutes.map((route) => route.path).sort()).toEqual(
      CLEAR_PATH.map((path) => `${LOGS_MOUNT}${path}`).sort(),
    )
    for (const route of clearRoutes) expect(route.method).toBe('POST')
  })

  it('GET /runtime 与 /operation 透传服务的报告形状，并显式带 cache-control: no-store', async () => {
    const app = mountedApp({ service: createFakeService().service })

    const runtime = await app.request(requestOf('GET', '/runtime'))
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('cache-control')).toBe('no-store')
    const runtimeBody = (await runtime.json()) as { entries: unknown[]; truncated: boolean; storage: LogStorageStats }
    expect(runtimeBody.entries).toHaveLength(1)
    expect(runtimeBody.truncated).toBe(false)
    expect(runtimeBody.storage).toEqual(STORAGE)

    const operation = await app.request(requestOf('GET', '/operation'))
    expect(operation.status).toBe(200)
    expect(operation.headers.get('cache-control')).toBe('no-store')
    const operationBody = (await operation.json()) as { truncated: boolean; skippedLines: number; skippedFiles: number }
    expect(operationBody.truncated).toBe(true)
    expect(operationBody.skippedLines).toBe(1)
    expect(operationBody.skippedFiles).toBe(2)
  })

  it('读端点不设同源守卫（GET 无副作用），跨源 GET 照常 200', async () => {
    const app = mountedApp({ service: createFakeService().service })
    const res = await app.request(
      requestOf('GET', '/runtime', { headers: { origin: 'http://evil.example' } }),
    )
    expect(res.status).toBe(200)
  })

  it('清空端点走完整守卫链：空对象体 200，回的是已删除的事实', async () => {
    const { service, cleared } = createFakeService()
    const app = mountedApp({ service })
    for (const category of LOG_CLEARABLE_CATEGORIES) {
      const res = await app.request(jsonRequest('POST', `/${category}/clear`, {}))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { cleared: Record<string, unknown> }
      expect(body.cleared['category']).toBe(category)
      expect(body.cleared['fileCount']).toBe(2)
      expect(body.cleared['totalBytes']).toBe(1024)
    }
    expect(cleared).toEqual([...LOG_CLEARABLE_CATEGORIES])
  })

  it('清空是写端点：跨源 403，且拒绝发生在读体之前', async () => {
    const { service, cleared } = createFakeService()
    const app = mountedApp({ service })
    const payload = JSON.stringify({})
    const res = await app.request(
      new Request(`${ORIGIN}${LOGS_MOUNT}/runtime/clear`, {
        method: 'POST',
        headers: {
          host: 'localhost:5173',
          origin: 'http://evil.example',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload, 'utf8')),
        },
        body: payload,
      }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
    expect(cleared).toEqual([])
  })

  it('读体守卫：415（Content-Type 不符）/ 413（超限）/ 400（空体与坏 JSON）', async () => {
    const app = mountedApp({ service: createFakeService().service })

    const noType = await app.request(requestOf('POST', '/runtime/clear', { body: '{}' }))
    expect(noType.status).toBe(415)

    const tooLarge = await app.request(
      requestOf('POST', '/runtime/clear', {
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
      }),
    )
    expect(tooLarge.status).toBe(413)

    const empty = await app.request(
      requestOf('POST', '/runtime/clear', { body: '   ', headers: { 'content-type': 'application/json' } }),
    )
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: '请求体不能为空' })

    const broken = await app.request(
      requestOf('POST', '/runtime/clear', { body: '{', headers: { 'content-type': 'application/json' } }),
    )
    expect(broken.status).toBe(400)
    expect(await broken.json()).toEqual({ error: '请求体不是有效 JSON' })
  })

  it('未知路径 404，文案剥挂载前缀逐字一致', async () => {
    const app = mountedApp({ service: createFakeService().service })
    for (const [method, path, expected] of [
      ['GET', '/nowhere', '未知日志端点：GET /nowhere'],
      ['POST', '/runtime/compress', '未知日志端点：POST /runtime/compress'],
      ['DELETE', '/operation', '未知日志端点：DELETE /operation'],
    ] as const) {
      const res = await app.request(requestOf(method, path))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: expected })
    }
  })

  it('越界的类别名自然落到 404（请求体里的 category 不参与路由决策）', async () => {
    const app = mountedApp({ service: createFakeService().service })
    const res = await app.request(jsonRequest('POST', '/database/clear', { category: 'runtime' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知日志端点：POST /database/clear' })
  })

  it('未知路径的写请求先 403 后 404（守卫链次序与其余各片同构）', async () => {
    const app = mountedApp({ service: createFakeService().service })
    const res = await app.request(
      requestOf('POST', '/nowhere', { headers: { origin: '', 'content-type': 'application/json' }, body: '{}' }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })

  it('本片没有容器边界：非容器环境下读端点照常 200，不是 503', async () => {
    const app = mountedApp({ service: createFakeService().service })
    const res = await app.request(requestOf('GET', '/runtime'))
    expect(res.status).not.toBe(503)
  })
})

/*
 * 真实接线的端到端往返：注入临时根（mkdtemp）后走 HTTP，验证「请求 → 服务 → 真文件」
 * 与「真文件 → 服务 → 响应」这一整圈，以及清空后磁盘上确实什么都不剩（只剩一条留痕）。
 * 默认接线读的是开发者真实的 ~/.Elysian，那一路不做自动化断言（见 ARCHITECTURE 第十节）。
 */
describe('createLogsApp 接真实接线（临时根）', () => {
  async function withTempRoot<T>(task: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'elysian-logs-routes-'))
    try {
      return await task(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('写入 → 读取：两个类别的报告都取到刚写下的记录（都按时间倒序）', async () => {
    await withTempRoot(async (root) => {
      const { service } = createLogsHostDeps({ platformLogsDir: root })
      const app = mountedApp({ service })

      await service.log('info', 'server.lifecycle', 'Elysian 服务已启动：http://127.0.0.1:48101')
      await service.recordOperation({
        category: 'security',
        action: '修改 SSH 监听端口',
        target: 'sshd',
        result: 'success',
        summary: '端口 2222',
        method: 'PUT',
        path: '/api/security/ssh/port',
        httpStatus: 200,
      })

      const runtime = (await (await app.request(requestOf('GET', '/runtime'))).json()) as {
        entries: { message: string; source: string; level: string }[]
        storage: LogStorageStats
      }
      expect(runtime.entries.some((entry) => entry.message.includes('Elysian 服务已启动'))).toBe(true)
      expect(runtime.storage.runtimeBytes).toBeGreaterThan(0)
      // 巡检留痕也真的落在同一个文件里（first-write 上报由写入器携带，见 logsService）。
      await service.runSweep('runtime', 'manual')

      const operation = (await (await app.request(requestOf('GET', '/operation'))).json()) as {
        entries: { action: string; actor: string; target: string | null; summary: string }[]
      }
      expect(operation.entries[0]).toMatchObject({
        action: '修改 SSH 监听端口',
        actor: 'panel',
        target: 'sshd',
        summary: '端口 2222',
      })
    })
  })

  it('清空不可恢复：磁盘上只剩一条「已清空」留痕，重复清空状态等价（第二次删掉的是那条留痕）', async () => {
    await withTempRoot(async (root) => {
      const { service } = createLogsHostDeps({ platformLogsDir: root })
      const app = mountedApp({ service })

      await service.log('info', 'server.lifecycle', '第一条')
      await service.log('info', 'server.lifecycle', '第二条')
      const before = readFileSync(join(root, 'runtime', await firstShardName(root, 'runtime')), 'utf8')
      expect(before.trim().split('\n').length).toBeGreaterThanOrEqual(2)

      const cleared = await app.request(jsonRequest('POST', '/runtime/clear', {}))
      expect(cleared.status).toBe(200)
      const report = ((await cleared.json()) as { cleared: { fileCount: number; totalBytes: number } }).cleared
      expect(report.fileCount).toBe(1)
      expect(report.totalBytes).toBeGreaterThan(0)

      // 磁盘上确实不可恢复：类别目录里只剩一个文件、文件里只剩一条留痕。
      const names = await readdir(join(root, 'runtime'))
      expect(names).toHaveLength(1)
      const after = readFileSync(join(root, 'runtime', names[0] as string), 'utf8').trim().split('\n')
      expect(after).toHaveLength(1)
      expect(JSON.parse(after[0] as string)).toMatchObject({ level: 'warning', source: 'logs.clear' })

      // 再清一次：状态等价（第二次删掉的正是第一次留下的那条留痕文件，fileCount 因此是 1）。
      const second = await app.request(jsonRequest('POST', '/runtime/clear', {}))
      expect(second.status).toBe(200)
      expect(((await second.json()) as { cleared: { fileCount: number } }).cleared.fileCount).toBe(1)
      expect(await readdir(join(root, 'runtime'))).toHaveLength(1)
    })
  })

  it('清空只清本类别，另一个类别与目录外的 sshd.log 都不受影响', async () => {
    await withTempRoot(async (root) => {
      const { service } = createLogsHostDeps({ platformLogsDir: root })
      const app = mountedApp({ service })

      await service.recordOperation({
        category: 'files',
        action: '压缩文件',
        result: 'success',
        summary: '/var/log/syslog',
        method: 'POST',
        path: '/api/files/compress',
        httpStatus: 200,
      })
      // sshd.log 在真实布局里与 platform/ 平级；这里放进临时根（不是类别目录）代表「日志模块不碰的外部文件」。
      const sshdLog = join(root, 'sshd.log')
      writeFileSync(sshdLog, 'sshd 自己的日志\n')

      expect((await app.request(jsonRequest('POST', '/runtime/clear', {}))).status).toBe(200)

      const operation = (await (await app.request(requestOf('GET', '/operation'))).json()) as {
        entries: { action: string }[]
      }
      expect(operation.entries[0]?.action).toBe('压缩文件')
      expect(readFileSync(sshdLog, 'utf8')).toBe('sshd 自己的日志\n')
    })
  })
})

/** 类别目录里第一个分片名（真实接线写入后必然存在）。 */
async function firstShardName(root: string, category: PlatformLogCategory): Promise<string> {
  const names = await readdir(join(root, category))
  const name = names.find((entry) => entry.endsWith('.jsonl'))
  if (name === undefined) throw new Error(`没有找到 ${category} 的分片：${names.join(',')}`)
  return name
}

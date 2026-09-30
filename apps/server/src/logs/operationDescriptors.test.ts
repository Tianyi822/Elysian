import { describe, expect, it } from 'vitest'
import { OPERATION_LOG_CATEGORIES, type LogStorageStats, type PlatformLogCategory } from '@elysian/contracts'
import { createApp } from '../app.ts'
import { LOGS_MOUNT } from './logsRoutes.ts'
import type { LogsService } from './logsService.ts'
import { OPERATION_DESCRIPTORS, extractPathParams } from './operationDescriptors.ts'

/*
 * 描述符表的漂移守卫：用**完整装配**的应用（各片注入 fake 与 available:true）取 app.routes，
 * 断言「每个写端点都已登记」与「表里的每个键都还在路由表里」。新增写端点若忘记登记，
 * 本文件立刻变红——这是「采集在 app 层中间件而不是各片 handler」这条决定的配套保险。
 *
 * 漂移守卫只读 app.routes 与发一次探测请求，不执行任何业务 handler，因此各片只给
 * 「可用 + 有服务对象」的最小形状；各片的行为测试在它们自己的测试文件里（那边有完整 fake）。
 */

const STUB = {} as never

/** 日志服务的空实现：漂移守卫里只有 GET 探针与 405 探针会走到它。 */
function createFakeLogs(): LogsService {
  const storage: LogStorageStats = {
    totalBytes: 0,
    runtimeBytes: 0,
    operationBytes: 0,
    fileCount: 0,
    oldestAt: null,
    lastSweepAt: null,
    trimmedBySize: false,
    droppedRecords: 0,
    failedWrites: 0,
  }
  return {
    runtimeLog: async () => ({ entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0, storage }),
    operationLog: async () => ({ entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0, storage }),
    clear: async (category: PlatformLogCategory) => ({
      category,
      fileCount: 0,
      totalBytes: 0,
      oldestAt: null,
      clearedAt: '2026-09-23T00:00:00.000Z',
    }),
    loginLog: async () => ({ entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0 }),
    log: async () => undefined,
    recordLogin: async () => undefined,
    recordOperation: async () => undefined,
    runSweep: async () => ({
      removedTmp: 0,
      compressed: 0,
      deletedByAge: 0,
      deletedBySize: 0,
      freedBytes: 0,
      totalBytes: 0,
      trimmedBySize: false,
      failed: 0,
      at: '2026-09-23T00:00:00.000Z',
    }),
  }
}

function assembly(): Promise<Awaited<ReturnType<typeof createApp>>> {
  return createApp({
    // 鉴权关：漂移守卫只读 app.routes 与发 405 探针，不测鉴权行为（鉴权接线在 authWiring.test.ts）。
    auth: { enabled: false },
    firewall: { available: true, service: STUB },
    ssh: { available: true, service: STUB },
    users: { available: true, service: STUB },
    files: { available: true, service: STUB },
    terminals: { available: true, service: { tryOpen: () => null, activeCount: () => 0 } },
    logs: createFakeLogs(),
    docker: { available: true, socketReady: true, service: STUB },
    databases: { available: true, service: STUB },
    websites: { available: true, service: STUB },
  })
}

const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'] as const

describe('OPERATION_DESCRIPTORS 漂移守卫', () => {
  it('每个写端点都已登记（含挂载前缀的全路径逐字相同）', async () => {
    const app = await assembly()
    const missing: string[] = []
    for (const route of app.routes) {
      if (route.path.includes('*')) continue
      if (!WRITE_METHODS.includes(route.method as (typeof WRITE_METHODS)[number])) continue
      if (OPERATION_DESCRIPTORS[`${route.method} ${route.path}`] === undefined) {
        missing.push(`${route.method} ${route.path}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('ALL 路由都是只读端点：写方法一律 405，不进描述符表', async () => {
    const app = await assembly()
    const allRoutes = app.routes.filter((route) => route.method === 'ALL' && !route.path.includes('*'))
    // platform 域当前两条（memory 与 dependencies），都是只读探测；没有这条断言，将来谁用
    // app.all 加一个写端点就没人拦（写端点走 app.all 会绕过「写方法」那一条守卫）。
    expect(allRoutes.map((route) => route.path).sort()).toEqual(['/api/platform/dependencies', '/api/platform/memory'])
    for (const route of allRoutes) {
      expect(OPERATION_DESCRIPTORS[`POST ${route.path}`]).toBeUndefined()
      const res = await app.request(new Request(`http://localhost:5173${route.path}`, { method: 'POST' }))
      expect(res.status).toBe(405)
    }
  })

  it('反向：表里的每个键都还存在于路由表（防陈旧描述符）', async () => {
    const app = await assembly()
    const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`))
    const stale = Object.keys(OPERATION_DESCRIPTORS).filter((key) => !registered.has(key))
    expect(stale).toEqual([])
  })

  it('每个描述符的类别与动作合法：类别取自契约枚举、动作非空', () => {
    for (const [key, descriptor] of Object.entries(OPERATION_DESCRIPTORS)) {
      expect(OPERATION_LOG_CATEGORIES).toContain(descriptor.category)
      expect(descriptor.action.trim()).not.toBe('')
      // 键的写法必须与 matchedRoutes 给的值同形：`<METHOD> <全路径>`。
      expect(key).toMatch(/^(POST|PUT|DELETE|PATCH) \//)
      // 含参数的路由只有 `:name` 一段形态（通配路由不会出现在具体路由里）。
      expect(key).not.toContain('*')
    }
  })

  it('凭据类端点不声明 summarize：请求体因此永远不会被采集器读取', () => {
    const credentialEndpoints = [
      'POST /api/security/ssh/root-password',
      'POST /api/security/users',
      'PUT /api/security/users/:id',
    ]
    for (const key of credentialEndpoints) {
      const descriptor = OPERATION_DESCRIPTORS[key]
      expect(descriptor).toBeDefined()
      // 唯一读体开关就是 summarize：不声明它，采集器连 clone 都不做，body 恒为 null。
      expect(descriptor?.summarize).toBeUndefined()
    }
  })

  it('日志清空两条端点都在表里（清空动作本身因此也留痕）', () => {
    expect(OPERATION_DESCRIPTORS[`POST ${LOGS_MOUNT}/runtime/clear`]?.action).toBe('清空运行日志')
    expect(OPERATION_DESCRIPTORS[`POST ${LOGS_MOUNT}/operation/clear`]?.action).toBe('清空操作日志')
  })

  it('访问配置操作留痕且不读取证书私钥', () => {
    const descriptor = OPERATION_DESCRIPTORS['PUT /api/websites/:id/access']
    expect(descriptor?.category).toBe('websites')
    expect(descriptor?.action).toBe('调整网站访问配置')
    expect(descriptor?.summarize).toBeUndefined()
  })
})

describe('extractPathParams', () => {
  it('按段还原路径参数', () => {
    expect(extractPathParams('/api/security/ssh/keys/:id', '/api/security/ssh/keys/k-2')).toEqual({ id: 'k-2' })
  })

  it('多段参数与中段参数都还原', () => {
    expect(extractPathParams('/api/a/:x/b/:y', '/api/a/1/b/2')).toEqual({ x: '1', y: '2' })
    expect(extractPathParams('/a/:id/c', '/a/1/c')).toEqual({ id: '1' })
  })

  it('尾斜杠不影响取段（带/不带尾斜杠同形）', () => {
    expect(extractPathParams('/api/security/users/:id', '/api/security/users/wangwu')).toEqual({ id: 'wangwu' })
    expect(extractPathParams('/api/security/users/:id', '/api/security/users/wangwu/')).toEqual({ id: 'wangwu' })
    expect(extractPathParams('/api/security/users/:id/', '/api/security/users/wangwu')).toEqual({ id: 'wangwu' })
  })

  it('模板无参数时回空对象（不编造键）', () => {
    expect(extractPathParams('/api/security/ssh/port', '/api/security/ssh/port')).toEqual({})
  })

  it('段数与模板不符时给不出值，返回的对象里就没有那个键', () => {
    expect(extractPathParams('/api/security/users/:id', '/api/security/users')).toEqual({})
    expect(extractPathParams('/api/security/users/:id', '/api/security/users/a/b')).toMatchObject({ id: 'a' })
  })

  it('通配模板不还原参数（`*` 不是参数名）', () => {
    expect(extractPathParams('/api/security/ssh/*', '/api/security/ssh/port')).toEqual({})
  })

  it('取值保持字面（不做二次解码：c.req.path 已是解码后的路径）', () => {
    expect(extractPathParams('/api/security/users/:id', '/api/security/users/a b')).toEqual({ id: 'a b' })
  })
})

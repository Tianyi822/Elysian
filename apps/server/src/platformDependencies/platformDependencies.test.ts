import { describe, expect, it, vi } from 'vitest'
import type { DependencyProbeReport, LogStorageStats, OperationLogCategory, PlatformLogCategory } from '@elysian/contracts'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createApp } from '../app.ts'
import { createDockerTransport, type DockerTransport } from '../docker/dockerTransport.ts'
import type { LogsService } from '../logs/logsService.ts'
import {
  CADDY_CHANNEL_UNAVAILABLE_DETAIL,
  createWebsiteCaddy,
  type CaddySocketRequest,
} from '../websites/websitesCaddy.ts'
import {
  CADDY_SYSTEM_ERROR_DETAIL,
  createDependencyProbe,
  DOCKER_SYSTEM_ERROR_DETAIL,
  DOCKER_UNAVAILABLE_DETAIL,
} from './dependencyProbe.ts'
import { createPlatformDependenciesApp } from './platformDependenciesRoutes.ts'

/*
 * 依赖检测测试：fake 注入锁行为与文案（requestImpl 先例 websitesCaddy.test.ts /
 * websitesDocker.test.ts），env 覆盖指向不存在 socket 的真实路径证明「覆盖即模拟」；
 * 路由与 app 接线直接 request 驱动，不起真实引擎、不碰宿主已有 socket。
 */

type DockerRequest = Parameters<DockerTransport['request']>[0]
type CaddyHandler = (input: CaddySocketRequest) => Promise<{ status: number; json: unknown }>

function connectionError(code: string, path: string): Error {
  const error = new Error(`connect ${code} ${path}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** fake 双通道探针：记录请求形状，handler 缺省回各自就绪响应。 */
function fixture(handlers: { docker?: (input: DockerRequest) => Promise<{ status: number; json: unknown }>; caddy?: CaddyHandler }) {
  const dockerCalls: DockerRequest[] = []
  const caddyCalls: CaddySocketRequest[] = []
  const prober = createDependencyProbe({
    createTransport: () => createDockerTransport({
      socketPath: '/var/run/docker.sock',
      requestImpl: async (input) => {
        dockerCalls.push(input)
        return handlers.docker ? handlers.docker(input) : { status: 200, json: { ApiVersion: '1.44' } }
      },
    }),
    createCaddy: () => createWebsiteCaddy({
      socketPath: '/run/caddy/admin.sock',
      requestImpl: async (input) => {
        caddyCalls.push(input)
        return handlers.caddy ? handlers.caddy(input) : { status: 200, json: {} }
      },
    }),
  })
  return { prober, dockerCalls, caddyCalls }
}

const OK_REPORT: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

describe('探测实现（fake 注入）', () => {
  it('双 ok：state ok、detail null；请求形状对齐既有探针（docker GET /version、caddy GET /config/）', async () => {
    const { prober, dockerCalls, caddyCalls } = fixture({})
    expect(await prober.probe()).toEqual(OK_REPORT)
    expect(dockerCalls).toEqual([{ method: 'GET', path: '/version', timeoutMs: 3000, maxBytes: 1_048_576 }])
    expect(caddyCalls).toEqual([{ method: 'GET', path: '/config/' }])
  })

  it.each(['ENOENT', 'ECONNREFUSED'] as const)('docker 连接类失败（%s）归 missing，detail 逐字固定文案', async (code) => {
    const { prober } = fixture({
      docker: () => {
        throw connectionError(code, '/var/run/docker.sock')
      },
    })
    expect((await prober.probe()).docker).toEqual({ state: 'missing', detail: DOCKER_UNAVAILABLE_DETAIL })
  })

  it('docker 版本过低归 error，detail 逐字复用 assertEngineApi 文案', async () => {
    const { prober } = fixture({ docker: async () => ({ status: 200, json: { ApiVersion: '1.24' } }) })
    expect((await prober.probe()).docker).toEqual({ state: 'error', detail: 'Docker Engine API 版本过低，需要 1.41 及以上' })
  })

  it('caddy 连接类失败归 missing，detail 复用既有通道固定文案', async () => {
    const { prober } = fixture({
      caddy: () => {
        throw connectionError('EACCES', '/run/caddy/admin.sock')
      },
    })
    expect((await prober.probe()).caddy).toEqual({ state: 'missing', detail: CADDY_CHANNEL_UNAVAILABLE_DETAIL })
  })

  it('caddy 引擎侧失败（HTTP 500）归 error，detail 是引擎消息——已装故障不归缺装类', async () => {
    const { prober } = fixture({ caddy: async () => ({ status: 500, json: { message: 'x' } }) })
    expect((await prober.probe()).caddy).toEqual({ state: 'error', detail: 'x' })
  })

  it('docker 非连接类系统错误（ENOTSOCK）归 error，detail 固定文案、不透传内嵌路径的 message', async () => {
    const { prober } = fixture({
      docker: () => {
        throw connectionError('ENOTSOCK', '/var/run/docker.sock')
      },
    })
    const docker = (await prober.probe()).docker
    expect(docker).toEqual({ state: 'error', detail: DOCKER_SYSTEM_ERROR_DETAIL })
    expect(docker.detail).not.toContain('/var/run/docker.sock')
  })

  it('caddy 非连接类系统错误（ENOTSOCK）归 error，detail 固定文案、不透传内嵌路径的 message', async () => {
    const { prober } = fixture({
      caddy: () => {
        throw connectionError('ENOTSOCK', '/run/caddy/admin.sock')
      },
    })
    const caddy = (await prober.probe()).caddy
    expect(caddy).toEqual({ state: 'error', detail: CADDY_SYSTEM_ERROR_DETAIL })
    expect(caddy.detail).not.toContain('/run/caddy/admin.sock')
  })
})

describe('env 覆盖（真实路径，不注入 requestImpl）', () => {
  it('ELYSIAN_DOCKER_SOCKET 指向不存在的路径：真实 requestOverSocket 落 missing + 固定文案', async () => {
    const report = await createDependencyProbe().probe({
      ELYSIAN_DOCKER_SOCKET: `/tmp/elysian-test-no-docker-${process.pid}.sock`,
    })
    expect(report.docker).toEqual({ state: 'missing', detail: DOCKER_UNAVAILABLE_DETAIL })
  })

  it('ELYSIAN_CADDY_SOCKET 指向不存在的路径：真实通道探测落 missing + 既有固定文案', async () => {
    const report = await createDependencyProbe().probe({
      ELYSIAN_CADDY_SOCKET: `/tmp/elysian-test-no-caddy-${process.pid}.sock`,
    })
    expect(report.caddy).toEqual({ state: 'missing', detail: CADDY_CHANNEL_UNAVAILABLE_DETAIL })
  })

  it('ELYSIAN_DOCKER_SOCKET 指向非 socket 普通文件：真实 ENOTSOCK 落 error + 固定文案，不透传宿主绝对路径', async () => {
    const notSocket = `/tmp/elysian-test-notsock-docker-${process.pid}.txt`
    writeFileSync(notSocket, 'not a socket')
    try {
      const report = await createDependencyProbe().probe({ ELYSIAN_DOCKER_SOCKET: notSocket })
      expect(report.docker).toEqual({ state: 'error', detail: DOCKER_SYSTEM_ERROR_DETAIL })
      expect(report.docker.detail).not.toContain(notSocket)
    } finally {
      unlinkSync(notSocket)
    }
  })

  it('ELYSIAN_CADDY_SOCKET 指向非 socket 普通文件：真实 ENOTSOCK 落 error + 固定文案，不透传宿主绝对路径', async () => {
    const notSocket = `/tmp/elysian-test-notsock-caddy-${process.pid}.txt`
    writeFileSync(notSocket, 'not a socket')
    try {
      const report = await createDependencyProbe().probe({ ELYSIAN_CADDY_SOCKET: notSocket })
      expect(report.caddy).toEqual({ state: 'error', detail: CADDY_SYSTEM_ERROR_DETAIL })
      expect(report.caddy.detail).not.toContain(notSocket)
    } finally {
      unlinkSync(notSocket)
    }
  })
})

describe('路由（createPlatformDependenciesApp）', () => {
  it('GET 200：报告 JSON、Cache-Control no-store、probe 每请求现场调用一次', async () => {
    const probe = vi.fn(async (): Promise<DependencyProbeReport> => OK_REPORT)
    const app = createPlatformDependenciesApp({ probe })
    const res = await app.request('http://localhost:48100/dependencies')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(OK_REPORT)
    expect(probe).toHaveBeenCalledTimes(1)
    await app.request('http://localhost:48100/dependencies')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('非 GET 一律 405「只允许 GET」，不触发探测', async () => {
    const probe = vi.fn(async (): Promise<DependencyProbeReport> => OK_REPORT)
    const app = createPlatformDependenciesApp({ probe })
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.request('http://localhost:48100/dependencies', { method })
      expect(res.status).toBe(405)
      expect(await res.json()).toEqual({ error: '只允许 GET' })
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('固定窗口限流：超限 GET 返回 429 与中文文案且不触发探测，窗口滚动后恢复', async () => {
    const probe = vi.fn(async (): Promise<DependencyProbeReport> => OK_REPORT)
    const app = createPlatformDependenciesApp({ probe, probeRateLimit: 2, rateWindowMs: 60 })
    for (let i = 0; i < 2; i += 1) {
      expect((await app.request('http://localhost:48100/dependencies')).status).toBe(200)
    }
    const limited = await app.request('http://localhost:48100/dependencies')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: '依赖检测请求过于频繁，请稍后再试' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(probe).toHaveBeenCalledTimes(2)
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect((await app.request('http://localhost:48100/dependencies')).status).toBe(200)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('非 GET 的 405 不占用探测限额', async () => {
    const probe = vi.fn(async (): Promise<DependencyProbeReport> => OK_REPORT)
    const app = createPlatformDependenciesApp({ probe, probeRateLimit: 1 })
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('http://localhost:48100/dependencies', { method: 'POST' })
      expect(res.status).toBe(405)
    }
    expect((await app.request('http://localhost:48100/dependencies')).status).toBe(200)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('app 接线与审计零记录', () => {
  it('createApp 挂载 /api/platform/dependencies：GET 200 形状正确，操作日志端点无本端点记录', async () => {
    const { service: logs, records } = createRecordingLogs()
    const probe = vi.fn(async (): Promise<DependencyProbeReport> => ({
      docker: { state: 'missing', detail: DOCKER_UNAVAILABLE_DETAIL },
      caddy: { state: 'missing', detail: CADDY_CHANNEL_UNAVAILABLE_DETAIL },
    }))
    const app = await createApp({ platformDependencies: { probe }, logs, auth: { enabled: false } })
    const res = await app.request('http://localhost:48100/api/platform/dependencies')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      docker: { state: 'missing', detail: DOCKER_UNAVAILABLE_DETAIL },
      caddy: { state: 'missing', detail: CADDY_CHANNEL_UNAVAILABLE_DETAIL },
    })
    expect(probe).toHaveBeenCalledTimes(1)
    // 405 短路同样不采集（ALL 路由的 POST 不在描述符表里）。
    const post = await app.request('http://localhost:48100/api/platform/dependencies', { method: 'POST' })
    expect(post.status).toBe(405)
    expect(records).toEqual([])
    const opRes = await app.request('http://localhost:48100/api/logs/operation')
    expect(opRes.status).toBe(200)
    const opBody = (await opRes.json()) as { entries: { path: string | null }[] }
    expect(opBody.entries.filter((entry) => entry.path?.includes('/api/platform/dependencies'))).toEqual([])
  })
})

const LOGS_STORAGE: LogStorageStats = {
  totalBytes: 0,
  runtimeBytes: 0,
  operationBytes: 0,
  runtimeRowCount: 0,
  operationRowCount: 0,
  rowCount: 0,
  oldestAt: null,
  lastSweepAt: null,
  trimmedBySize: false,
  droppedRecords: 0,
  failedWrites: 0,
}

/** 记录型日志 fake：recordOperation 的输入原样进 operationLog 的 entries，取证「零记录」。 */
function createRecordingLogs(): { service: LogsService; records: Parameters<LogsService['recordOperation']>[0][] } {
  const records: Parameters<LogsService['recordOperation']>[0][] = []
  const service: LogsService = {
    runtimeLog: async () => ({ entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0, storage: LOGS_STORAGE }),
    operationLog: async () => ({
      entries: records.map((record, index) => ({
        id: `2026-09-29T00:00:00.000Z#${index + 1}`,
        at: '2026-09-29T00:00:00.000Z',
        category: 'containers' satisfies OperationLogCategory,
        action: record.action,
        target: record.target ?? null,
        summary: record.summary ?? '',
        result: record.result,
        method: record.method ?? null,
        path: record.path ?? null,
        httpStatus: record.httpStatus ?? null,
      })),
      total: records.length,
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: LOGS_STORAGE,
    }),
    clear: async (category: PlatformLogCategory) => ({
      category,
      rowCount: 0,
      totalBytes: 0,
      oldestAt: null,
      clearedAt: '2026-09-29T00:00:00.000Z',
    }),
    loginLog: async () => ({ entries: [], total: 0, truncated: false, skippedLines: 0, skippedFiles: 0 }),
    log: async () => undefined,
    recordLogin: async () => undefined,
    recordOperation: async (input) => {
      records.push(input)
    },
    runSweep: async () => ({
      removedTmp: 0,
      compressed: 0,
      deletedByAge: 0,
      deletedBySize: 0,
      freedBytes: 0,
      totalBytes: 0,
      trimmedBySize: false,
      failed: 0,
      at: '2026-09-29T00:00:00.000Z',
    }),
  }
  return { service, records }
}

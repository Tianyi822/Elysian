import { describe, expect, it } from 'vitest'
import type { LogStorageStats, PlatformLogCategory } from '@elysian/contracts'
import { createApp } from './app'
import { DOCKER_MOUNT } from './docker/dockerRoutes.ts'
import type { DockerExecSessions } from './docker/dockerExecSessions.ts'
import type { DockerTransport } from './docker/dockerTransport.ts'
import { LOGS_MOUNT } from './logs/logsRoutes'
import type { LogsService } from './logs/logsService'
import { sendJson } from './middleware/guard.ts'

/*
 * app 组装冒烟测试：锚定挂载点与健康检查的可达性。三片安全路由全部装配真实接线：
 * 非容器环境（测试进程无 ELYSIAN_DOCKER 且无 /.dockerenv）下整片 503，
 * 这里锚定挂载形态与容器边界文案。
 *
 * 日志片与容器边界无关（读写面板自有的 ~/.Elysian 目录），因此它的用例**注入 fake
 * LogsService**（走 createApp 的覆盖参数）而不是用默认的真实接线：默认接线读的是开发者
 * 真实的 ~/.Elysian/logs/platform，一旦本机跑过面板目录就不再为空，「空目录 → 空列表」
 * 这类断言会红（测试不 hermetic）。同理这里不用真实接线做任何写请求。
 */

const LOGS_STORAGE: LogStorageStats = {
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

/** 日志服务的 fake：只回固定形状并记下调用，不碰文件系统。 */
function createFakeLogs(): {
  service: LogsService
  swept: string[]
  operationRecords: Parameters<LogsService['recordOperation']>[0][]
  runtimeLogs: string[]
} {
  const swept: string[] = []
  const operationRecords: Parameters<LogsService['recordOperation']>[0][] = []
  const runtimeLogs: string[] = []
  const service: LogsService = {
    runtimeLog: async () => ({
      entries: [
        { id: '2026-09-23T00:00:00.000Z#1', at: '2026-09-23T00:00:00.000Z', level: 'info', source: 'server.lifecycle', message: '已启动' },
      ],
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: LOGS_STORAGE,
    }),
    operationLog: async () => ({ entries: [], truncated: false, skippedLines: 0, skippedFiles: 0, storage: LOGS_STORAGE }),
    clear: async (category: PlatformLogCategory) => ({
      category,
      fileCount: 0,
      totalBytes: 0,
      oldestAt: null,
      clearedAt: '2026-09-23T00:00:00.000Z',
    }),
    log: async (_level, _source, message) => {
      runtimeLogs.push(message)
    },
    recordOperation: async (input) => {
      operationRecords.push(input)
    },
    runSweep: async (category) => {
      swept.push(category)
      return {
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
    },
  }
  return { service, swept, operationRecords, runtimeLogs }
}

describe('createApp 组装', () => {
  it('GET /api/health 返回 200 与 ok', async () => {
    const res = await (await createApp()).request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('平台内存挂在 /api/platform/memory，形状与换算来自契约', async () => {
    const res = await (await createApp()).request('/api/platform/memory')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, number>
    expect(Object.keys(body).sort()).toEqual(['heapTotalMb', 'heapUsedMb', 'rssMb'])
    for (const value of Object.values(body)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('SSH 与用户管理两片挂真实接线：非容器环境整片 503（含未知路径），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/security/ssh/overview', '真实 SSH 管理仅在 Docker 容器内可用'],
      ['/api/security/users', '真实用户管理仅在 Docker 容器内可用'],
      ['/api/security/users/', '真实用户管理仅在 Docker 容器内可用'],
      ['/api/security/users/nowhere', '真实用户管理仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('防火墙片挂真实接线：非容器环境整片 503（含未知路径与写方法），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/security/firewall', '真实防火墙仅在 Docker 容器内可用'],
      ['/api/security/firewall/toggles', '真实防火墙仅在 Docker 容器内可用'],
      ['/api/security/firewall/nowhere', '真实防火墙仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('容器管理片挂真实接线：非容器环境整片 503，文案与容器边界一致', async () => {
    const app = await createApp()
    const res = await app.request('/api/docker/containers')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: '真实容器管理仅在 Docker 容器内可用' })
  })

  it('文件管理片挂真实接线：非容器环境整片 503（含未知路径），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/files/entries?path=%2Fvar%2Flog', '真实文件管理仅在 Docker 容器内可用'],
      ['/api/files/search?keyword=log', '真实文件管理仅在 Docker 容器内可用'],
      ['/api/files/nowhere', '真实文件管理仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('终端片挂真实接线：非容器环境整片 503（含 /ws 与 /status），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/terminals/status', '真实终端仅在 Docker 容器内可用'],
      ['/api/terminals/ws', '真实终端仅在 Docker 容器内可用'],
      ['/api/terminals/nowhere', '真实终端仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('日志片与容器边界无关：非容器环境下读端点照常 200、带 no-store，未知路径 404', async () => {
    const logs = createFakeLogs()
    const app = await createApp({ logs: logs.service })

    const runtime = await app.request(`${LOGS_MOUNT}/runtime`)
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('cache-control')).toBe('no-store')
    const runtimeBody = (await runtime.json()) as { entries: { message: string }[]; truncated: boolean }
    expect(runtimeBody.entries).toHaveLength(1)
    expect(runtimeBody.entries[0]?.message).toBe('已启动')
    expect(runtimeBody.truncated).toBe(false)

    const operation = await app.request(`${LOGS_MOUNT}/operation`)
    expect(operation.status).toBe(200)
    expect(operation.headers.get('cache-control')).toBe('no-store')
    expect((await operation.json()) as { entries: unknown[] }).toMatchObject({ entries: [] })

    const unknown = await app.request(`${LOGS_MOUNT}/nowhere`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: '未知日志端点：GET /nowhere' })
  })

  it('日志片在容器外也不返回 503（本片没有容器边界）', async () => {
    const app = await createApp({ logs: createFakeLogs().service })
    const res = await app.request(`${LOGS_MOUNT}/runtime`)
    expect(res.status).not.toBe(503)
  })

  it('终端片拿到同一个日志服务：/ws 的同源校验通过后记录一条 terminals 操作日志与一条运行日志', async () => {
    const logs = createFakeLogs()
    const app = await createApp({
      logs: logs.service,
      terminals: { available: true, service: { tryOpen: () => null, activeCount: () => 0 } },
    })

    // 升级本身在 vitest 的 node 运行时里走不完（upgradeWebSocket 依赖 Bun server 实例），
    // 但「升级之前记一条」这条接线正是本用例锚定的对象：状态码不作断言，记录必须有。
    try {
      await app.request(
        new Request('http://localhost:5173/api/terminals/ws', {
          headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
        }),
      )
    } catch {
      // 升级失败不影响下面两条断言：记录发生在升级之前。
    }

    expect(logs.operationRecords).toHaveLength(1)
    expect(logs.operationRecords[0]).toMatchObject({
      category: 'terminals',
      action: '打开本机终端会话',
      result: 'success',
      method: 'GET',
      path: '/api/terminals/ws',
    })
    expect(logs.runtimeLogs).toContain('操作：打开本机终端会话（成功）')
  })

  it('容器片拿到同一个日志服务：容器终端升级前记录打开容器终端', async () => {
    const logs = createFakeLogs()
    const transport: DockerTransport = {
      request: async () => ({
        status: 200,
        json: { Id: 'a1b2c3d4e5f6', State: { Status: 'running' } },
      }),
    }
    const dockerExecSessions: DockerExecSessions = {
      createWsEvents: () => ({
        onOpen: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
      }),
      activeCount: () => 0,
      managedCount: () => 0,
    }
    const app = await createApp({
      logs: logs.service,
      docker: {
        available: true,
        socketReady: true,
        service: {
          listContainers: async () => [],
          listImages: async () => [],
          policy: async () => ({ mountRoot: '/srv', reservedPorts: [22] }),
          action: async (id) => ({
            id,
            name: 'c',
            status: 'running',
            imageId: 'i',
            ports: [],
            createdAt: '',
            command: '',
            env: [],
            volumes: [],
            restartPolicy: 'no',
          }),
          create: async () => ({
            id: 'a1b2c3d4e5f6',
            name: 'c',
            status: 'running',
            imageId: 'i',
            ports: [],
            createdAt: '',
            command: '',
            env: [],
            volumes: [],
            restartPolicy: 'no',
          }),
          pull: async () => ({
            id: 'i',
            name: 'n',
            tag: 't',
            digest: 'd',
            sizeMb: 1,
            pulledAt: null,
          }),
          removeImage: async () => undefined,
          removeContainer: async () => undefined,
        },
        transport,
        dockerExecSessions,
        upgradeWebSocket: () => sendJson(200, { ok: true }),
      },
    })

    const res = await app.request(
      new Request(`http://localhost:5173${DOCKER_MOUNT}/containers/a1b2c3d4e5f6/terminal`, {
        headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      }),
    )
    expect(res.status).toBe(200)

    expect(logs.operationRecords).toHaveLength(1)
    expect(logs.operationRecords[0]).toMatchObject({
      category: 'containers',
      action: '打开容器终端',
      target: '容器 a1b2c3d4e5f6',
      result: 'success',
      method: 'GET',
      path: `${DOCKER_MOUNT}/containers/a1b2c3d4e5f6/terminal`,
    })
    expect(logs.runtimeLogs).toContain('操作：打开容器终端（成功）')
  })
})

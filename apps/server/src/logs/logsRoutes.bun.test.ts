import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogStorageStats } from '@elysian/contracts'
import { endpointErrorHandler } from '../middleware/guard.ts'
import { createLogsHostDeps } from './logsHostDeps.ts'
import { LOGS_MOUNT, createLogsApp, type LogsAppDeps } from './logsRoutes.ts'
import type { LogsService } from './logsService.ts'

/*
 * 真实接线的端到端往返：临时 SQLite + 空分片根。
 * 必须跑在 Bun（bun:sqlite）；vitest 侧见 logsRoutes.test.ts 的 fake 路由测试。
 */

const ORIGIN = 'http://localhost:5173'

function mountedApp(deps: LogsAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.onError(endpointErrorHandler)
  parent.route(LOGS_MOUNT, createLogsApp(deps))
  return parent
}

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

async function tempHostDeps(): Promise<{ service: LogsService; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'elysian-logs-routes-'))
  const platformLogsDir = join(root, 'platform')
  await mkdir(platformLogsDir, { recursive: true })
  const { service } = await createLogsHostDeps({
    platformLogsDir,
    logsSqlitePath: join(root, 'logs.sqlite'),
  })
  return {
    service,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

describe('createLogsApp 接真实接线（临时根）', () => {
  it('写入 → 读取：两个类别的报告都取到刚写下的记录（都按时间倒序）', async () => {
    const { service, dispose } = await tempHostDeps()
    try {
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
      await service.runSweep('runtime', 'manual')

      const operation = (await (await app.request(requestOf('GET', '/operation'))).json()) as {
        entries: { action: string; target: string | null; summary: string }[]
      }
      expect(operation.entries[0]).toMatchObject({
        action: '修改 SSH 监听端口',
        target: 'sshd',
        summary: '端口 2222',
      })
    } finally {
      await dispose()
    }
  })

  it('清空不可恢复：只剩一条「已清空」留痕，重复清空状态等价', async () => {
    const { service, dispose } = await tempHostDeps()
    try {
      const app = mountedApp({ service })

      await service.log('info', 'server.lifecycle', '第一条')
      await service.log('info', 'server.lifecycle', '第二条')
      expect((await service.runtimeLog()).total).toBeGreaterThanOrEqual(2)

      const cleared = await app.request(jsonRequest('POST', '/runtime/clear', {}))
      expect(cleared.status).toBe(200)
      const report = ((await cleared.json()) as { cleared: { rowCount: number; totalBytes: number } }).cleared
      expect(report.rowCount).toBe(2)
      expect(report.totalBytes).toBeGreaterThan(0)

      const after = await service.runtimeLog()
      expect(after.entries).toHaveLength(1)
      expect(after.entries[0]).toMatchObject({ level: 'warning', source: 'logs.clear' })

      const second = await app.request(jsonRequest('POST', '/runtime/clear', {}))
      expect(second.status).toBe(200)
      expect(((await second.json()) as { cleared: { rowCount: number } }).cleared.rowCount).toBe(1)
      expect((await service.runtimeLog()).entries).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('清空只清本类别，另一个类别不受影响', async () => {
    const { service, dispose } = await tempHostDeps()
    try {
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

      expect((await app.request(jsonRequest('POST', '/runtime/clear', {}))).status).toBe(200)

      const operation = (await (await app.request(requestOf('GET', '/operation'))).json()) as {
        entries: { action: string }[]
      }
      expect(operation.entries.some((entry) => entry.action === '压缩文件')).toBe(true)
    } finally {
      await dispose()
    }
  })
})

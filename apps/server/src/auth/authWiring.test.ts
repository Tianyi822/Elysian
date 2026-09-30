import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import type { LogStorageStats, OperationLogCategory, PlatformLogCategory } from '@elysian/contracts'
import { createApp } from '../app.ts'
import type { LogsService } from '../logs/logsService.ts'
import { createMemoryCredentialsStore } from './credentialsStore.ts'
import { createMemorySessionStore } from './sessionStore.ts'
import { createScryptHasher } from './passwordHasher.ts'
import { SESSION_COOKIE_NAME } from './authConfig.ts'

/*
 * 鉴权接线端到端测试：createApp 以 enabled: true + 内存 fake store 装配，锚定
 * requireSession 在完整应用里的行为——无 Cookie 的各挂载点（读、写、SSE、WS 升级）
 * 一律 401 且不进路由 handler；四条豁免路径放行（含尾斜杠双形与无会话登出的幂等）；
 * 登录取 Cookie 后同一请求放行（容器边界下 503 亦可）；CLI 改密后旧会话 401（epoch
 * 失效端到端）；被 401 拒绝的写请求与登录尝试都落操作日志且密码不进任何记录。
 */

const EPOCH = '2026-09-30T00:00:00.000Z'
const ORIGIN = 'http://localhost:5173'

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

/** 记录型日志 fake：recordOperation 的输入原样保留供断言（操作审计接线）。 */
function createRecordingLogs(): { service: LogsService; records: Parameters<LogsService['recordOperation']>[0][] } {
  const records: Parameters<LogsService['recordOperation']>[0][] = []
  const service: LogsService = {
    runtimeLog: async () => ({ entries: [], truncated: false, skippedLines: 0, skippedFiles: 0, storage: LOGS_STORAGE }),
    operationLog: async () => ({
      entries: records.map((record, index) => ({
        id: `2026-09-30T00:00:00.000Z#${index + 1}`,
        at: '2026-09-30T00:00:00.000Z',
        category: 'auth' satisfies OperationLogCategory,
        action: record.action,
        target: record.target ?? null,
        summary: record.summary ?? '',
        result: record.result,
        actor: 'panel',
        method: record.method ?? null,
        path: record.path ?? null,
        httpStatus: record.httpStatus ?? null,
      })),
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: LOGS_STORAGE,
    }),
    clear: async (category: PlatformLogCategory) => ({
      category,
      fileCount: 0,
      totalBytes: 0,
      oldestAt: null,
      clearedAt: '2026-09-30T00:00:00.000Z',
    }),
    log: async () => undefined,
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
      at: '2026-09-30T00:00:00.000Z',
    }),
  }
  return { service, records }
}

async function buildApp() {
  const hasher = createScryptHasher()
  const credentials = createMemoryCredentialsStore({
    username: 'admin',
    passwordHash: await hasher.hash('e2e-password'),
    passwordChangedAt: EPOCH,
  })
  const sessions = createMemorySessionStore()
  const logs = createRecordingLogs()
  const app = await createApp({
    logs: logs.service,
    auth: { enabled: true, credentials, sessions, hasher },
  })
  return { app: clientOf(app), credentials, records: logs.records }
}

function clientOf(app: Hono) {
  return {
    get: (path: string, cookie?: string) =>
      app.request(new URL(path, ORIGIN).toString(), { headers: cookie === undefined ? {} : { cookie } }),
    postJson: (path: string, body: unknown, cookie?: string) =>
      app.request(new URL(path, ORIGIN).toString(), {
        method: 'POST',
        headers: {
          host: 'localhost:5173',
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    post: (path: string, cookie?: string) =>
      app.request(new URL(path, ORIGIN).toString(), {
        method: 'POST',
        headers: { host: 'localhost:5173', origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
      }),
  }
}

describe('requireSession 接线（enabled: true）', () => {
  it('无 Cookie 的读端点一律 401「未登录或会话已过期」，不进路由 handler（503/404 均不出现）', async () => {
    const { app } = await buildApp()
    for (const path of [
      '/api/security/firewall',       // 防火墙读（真实接线：非容器 503——鉴权在前应 401）
      '/api/logs/runtime',            // 日志读（无容器边界的片）
      '/api/platform/memory',         // 现状无守卫的读端点
      '/api/platform/dependencies',   // 现状无守卫的读端点
      '/api/security/ssh/overview',
      '/api/nothing-here',            // 未匹配路径也先挡在鉴权
    ]) {
      const res = await app.get(path)
      expect(res.status, path).toBe(401)
      expect(await res.json(), path).toEqual({ error: '未登录或会话已过期' })
    }
  })

  it('SSE 与 WS 升级路径在升级/开流之前被 401 短路（而非 503 或升级）', async () => {
    const { app } = await buildApp()
    const sse = await app.get('/api/docker/events')
    expect(sse.status).toBe(401)
    expect(await sse.json()).toEqual({ error: '未登录或会话已过期' })

    for (const wsPath of ['/api/terminals/ws', '/api/docker/containers/a1b2c3d4e5f6/terminal', '/api/databases/db-1/terminal']) {
      const res = await app.get(wsPath)
      expect(res.status, wsPath).toBe(401)
      expect(await res.json(), wsPath).toEqual({ error: '未登录或会话已过期' })
    }
  })

  it('写请求无 Cookie 同样 401，且以 failure 落操作日志（审计先于鉴权的次序）', async () => {
    const { app, records } = await buildApp()
    const res = await app.postJson('/api/logs/runtime/clear', {})
    expect(res.status).toBe(401)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      category: 'logs',
      action: '清空运行日志',
      result: 'failure',
      method: 'POST',
      httpStatus: 401,
    })
  })

  it('豁免四路径放行：health、session、login（含尾斜杠双形）、无会话 logout 幂等 200', async () => {
    const { app } = await buildApp()

    expect((await app.get('/api/health')).status).toBe(200)
    expect((await app.get('/api/health/')).status).toBe(200)

    const session = await app.get('/api/auth/session')
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual({ authenticated: false, devAccount: false })

    // 尾斜杠双形：strict:false 下都命中登录路由，豁免判定剥尾斜杠后放行。
    for (const path of ['/api/auth/login', '/api/auth/login/']) {
      const res = await app.postJson(path, { username: 'admin', password: 'e2e-password' })
      expect(res.status, path).toBe(200)
      expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`))
    }

    const logout = await app.post('/api/auth/logout')
    expect(logout.status).toBe(200)
    expect(await logout.json()).toEqual({ ok: true })
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('登录取 Cookie 后同一请求放行：日志片 200、容器边界片 503（均非 401）', async () => {
    const { app } = await buildApp()
    const loginRes = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    expect(loginRes.status).toBe(200)
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    const logs = await app.get('/api/logs/runtime', cookie)
    expect(logs.status).toBe(200)

    const firewall = await app.get('/api/security/firewall', cookie)
    expect(firewall.status).toBe(503)
    expect(await firewall.json()).toEqual({ error: '真实防火墙仅在 Docker 容器内可用' })
  })

  it('改密（passwordChangedAt 变化）后旧会话下一次请求即 401（epoch 失效端到端）', async () => {
    const { app, credentials } = await buildApp()
    const loginRes = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!
    expect((await app.get('/api/logs/runtime', cookie)).status).toBe(200)

    // CLI 改密等价于换哈希 + 新 passwordChangedAt（内存 store 直写）。
    await credentials.write(await createScryptHasher().hash('rotated-password'))
    expect((await app.get('/api/logs/runtime', cookie)).status).toBe(401)
  })

  it('设置端点不在豁免清单：无 Cookie 的 GET /sessions、POST /password、POST /sessions/logout-others 一律 401「未登录或会话已过期」', async () => {
    const { app } = await buildApp()
    const list = await app.get('/api/auth/sessions')
    expect(list.status).toBe(401)
    expect(await list.json()).toEqual({ error: '未登录或会话已过期' })
    const change = await app.postJson('/api/auth/password', {
      currentPassword: 'a',
      newPassword: 'b',
      confirmNewPassword: 'c',
    })
    expect(change.status).toBe(401)
    expect(await change.json()).toEqual({ error: '未登录或会话已过期' })
    const others = await app.post('/api/auth/sessions/logout-others')
    expect(others.status).toBe(401)
    expect(await others.json()).toEqual({ error: '未登录或会话已过期' })
  })

  it('带有效会话可达设置端点：GET /api/auth/sessions 回当前会话一行（current: true）', async () => {
    const { app } = await buildApp()
    const loginRes = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    const res = await app.get('/api/auth/sessions', cookie)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: Array<{ current: boolean }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]!.current).toBe(true)
  })

  it('面板改密端点（POST /api/auth/password）后旧会话下一次请求 401（epoch 失效端到端，与 CLI 改密同语义）、新密码可再登录', async () => {
    const { app } = await buildApp()
    const loginRes = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    const change = await app.postJson(
      '/api/auth/password',
      { currentPassword: 'e2e-password', newPassword: 'rotated-password', confirmNewPassword: 'rotated-password' },
      cookie,
    )
    expect(change.status).toBe(200)
    expect(change.headers.get('set-cookie')).toContain('Max-Age=0')

    // 旧 Cookie 下一次请求即 401（epoch 不匹配被 validate 删除）。
    expect((await app.get('/api/logs/runtime', cookie)).status).toBe(401)

    // 新密码可登录、旧密码 401。
    const relogin = await app.postJson('/api/auth/login', { username: 'admin', password: 'rotated-password' })
    expect(relogin.status).toBe(200)
    expect((await app.get('/api/logs/runtime', relogin.headers.get('set-cookie')!.split(';')[0]!)).status).toBe(200)
    const oldPassword = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    expect(oldPassword.status).toBe(401)
  })

  it('退出其他会话端点保留当前会话、其余会话下一次请求 401', async () => {
    const { app } = await buildApp()
    const firstLogin = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    const cookieA = firstLogin.headers.get('set-cookie')!.split(';')[0]!
    const secondLogin = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    const cookieB = secondLogin.headers.get('set-cookie')!.split(';')[0]!

    const res = await app.post('/api/auth/sessions/logout-others', cookieA)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // 当前会话不受影响；另一会话下一次请求即 401。
    expect(await (await app.get('/api/auth/session', cookieA)).json()).toEqual({ authenticated: true, devAccount: false })
    expect((await app.get('/api/logs/runtime', cookieB)).status).toBe(401)
  })

  it('登录成功与失败都落操作日志（auth 分类），密码与用户名不进任何记录', async () => {
    const { app, records } = await buildApp()

    const ok = await app.postJson('/api/auth/login', { username: 'admin', password: 'e2e-password' })
    expect(ok.status).toBe(200)
    const bad = await app.postJson('/api/auth/login', { username: 'admin', password: 'wrong-password' })
    expect(bad.status).toBe(401)

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ category: 'auth', action: '登录面板', result: 'success', method: 'POST', httpStatus: 200 })
    expect(records[1]).toMatchObject({ category: 'auth', action: '登录面板', result: 'failure', method: 'POST', httpStatus: 401 })
    // 凭据隔离：summary/target 恒空，任何字段都不含密码或用户名。
    for (const record of records) {
      expect(record.summary).toBeNull()
      expect(record.target).toBeNull()
    }
    expect(JSON.stringify(records)).not.toContain('e2e-password')
    expect(JSON.stringify(records)).not.toContain('wrong-password')
    expect(JSON.stringify(records)).not.toContain('admin')
  })

  it('enabled: false（注入覆盖）：中间件放行、登录片演示语义（既有测试形态）', async () => {
    const logs = createRecordingLogs()
    const app = await createApp({ logs: logs.service, auth: { enabled: false } })
    const client = clientOf(app)
    // 无 Cookie 也能拿到各片（回到无鉴权演示语义；非容器下安全片照旧 503）。
    const logsRes = await client.get('/api/logs/runtime')
    expect(logsRes.status).toBe(200)
    const session = await client.get('/api/auth/session')
    expect(await session.json()).toEqual({ authenticated: true, devAccount: false })
    const login = await client.postJson('/api/auth/login', { username: 'x', password: 'y' })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toBeNull()
  })
})

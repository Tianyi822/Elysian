import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type {
  HostUser,
  PlatformLogLevel,
  SshAuthSettings,
  SshLoginCounts,
  SshLoginKey,
  SshOverview,
  SshRootAuth,
  UserAdapter,
} from '@elysian/contracts'
import { endpointErrorHandler } from '../middleware/guard.ts'
import { SSH_MOUNT, createSshApp, type SshApiDeps } from '../ssh/sshRoutes.ts'
import { USERS_MOUNT, createUsersApp } from '../users/usersRoutes.ts'
import { DOCKER_MOUNT, createDockerApp, type DockerReadService } from '../docker/dockerRoutes.ts'
import { LOGS_MOUNT } from './logsRoutes.ts'
import {
  OPERATION_SUMMARY_BODY_MAX_BYTES,
  createOperationAudit,
  type OperationAuditLogs,
} from './operationAudit.ts'
import type { LogsService } from './logsService.ts'

/*
 * 操作日志采集的覆盖与防绕过测试：用**真实子应用**（真守卫链、真 404 兜底）挂到与
 * app.ts 同构的父应用上，采集中间件按 app.ts 的次序注册在最前，日志服务的 fake 把
 * 落盘前的记录收进数组供断言。
 *
 * 这里钉住的是「客户端不能绕开采集、也不能让客户端可控的字段变成审计事实」：
 * 记录字段全部来自服务端（描述符表 / 最终响应状态 / 服务端时钟），请求体只在声明了
 * summarize 的端点上被读取，且只按白名单取字段。
 */

type OperationInput = Parameters<LogsService['recordOperation']>[0]

type Sink = {
  operations: OperationInput[]
  logs: { level: PlatformLogLevel; source: string; message: string }[]
}

/** 日志服务 fake：把记录收进数组；可注入抛错的实现，验证「采集失败不影响业务响应」。 */
function createLogsSink(overrides: Partial<OperationAuditLogs> = {}): { logs: OperationAuditLogs; sink: Sink } {
  const sink: Sink = { operations: [], logs: [] }
  return {
    sink,
    logs: {
      recordOperation: async (input) => {
        sink.operations.push(input)
      },
      log: async (level, source, message) => {
        sink.logs.push({ level, source, message })
      },
      ...overrides,
    },
  }
}

const ZERO_COUNTS: SshLoginCounts = { succeeded: 0, failed: 0 }

const SSH_OVERVIEW: SshOverview = {
  enabled: true,
  status: 'running',
  changedAt: null,
  stats: { today: ZERO_COUNTS, yesterday: ZERO_COUNTS, last7Days: ZERO_COUNTS },
}

const SSH_SETTINGS: SshAuthSettings = { passwordAuthEnabled: true, keyAuthEnabled: true, port: 22 }

const SSH_ROOT_AUTH: SshRootAuth = { policy: 'prohibit-password', key: null, passwordResetAt: null }

const LOGIN_KEY: SshLoginKey = {
  id: 'k-1',
  name: '笔记本',
  userId: 'root',
  algorithm: 'ssh-ed25519 256',
  fingerprint: 'SHA256:abc',
  createdAt: '2026-09-23T00:00:00Z',
  publicKey: 'ssh-ed25519 AAAA 笔记本',
}

const HOST_USER: HostUser = {
  id: 'wangwu',
  name: 'wangwu',
  isAdmin: false,
  loginMethod: 'key',
  status: 'active',
  note: null,
  createdAt: null,
}

function createFakeSshService(): NonNullable<SshApiDeps['service']> {
  return {
    overview: async () => SSH_OVERVIEW,
    settings: async () => SSH_SETTINGS,
    rootAuth: async () => SSH_ROOT_AUTH,
    setServiceEnabled: async () => SSH_OVERVIEW,
    setAuthMethods: async () => SSH_SETTINGS,
    setPort: async () => SSH_SETTINGS,
    saveRootLoginPolicy: async () => SSH_ROOT_AUTH,
    resetRootPassword: async () => ({ auth: SSH_ROOT_AUTH, strength: 'strong' }),
    createRootKey: async () => SSH_ROOT_AUTH,
    listKeys: async () => [LOGIN_KEY],
    listKeysWithReport: async () => ({ keys: [LOGIN_KEY], ignoredInvalidLines: 0 }),
    listLoginRecords: async () => [],
    keyAccounts: async () => [],
    createKey: async () => LOGIN_KEY,
    removeKey: async () => undefined,
  }
}

function createFakeUserService(overrides: Partial<UserAdapter> = {}): UserAdapter {
  return {
    list: async () => [HOST_USER],
    create: async () => HOST_USER,
    update: async () => HOST_USER,
    remove: async () => undefined,
    syncFromSystem: async () => ({ total: 1 }),
    ...overrides,
  }
}

/** 与 app.ts 同构的父应用：采集中间件在最前，之后才是各片路由。 */
const SAMPLE_CONTAINER = {
  id: 'a1b2c3d4e5f6',
  name: 'redis-echo',
  status: 'running' as const,
  imageId: 'deadbeef',
  ports: [],
  createdAt: '2024-06-01T10:00:00.000000000Z',
  command: 'redis-server',
  env: [],
  volumes: [],
  restartPolicy: 'no' as const,
}

function createFakeDockerService(overrides: Partial<DockerReadService> = {}): DockerReadService {
  return {
    listContainers: async () => [],
    listImages: async () => [],
    policy: async () => ({ mountRoot: '/srv', reservedPorts: [22] }),
    action: async (id) => ({ ...SAMPLE_CONTAINER, id }),
    create: async () => SAMPLE_CONTAINER,
    pull: async () => ({
      id: 'img-1',
      name: 'nginx',
      tag: '1.27',
      digest: 'sha256:abcd',
      sizeMb: 1,
      pulledAt: '2024-05-01T08:00:00.000000000Z',
    }),
    removeImage: async () => undefined,
    removeContainer: async () => undefined,
    ...overrides,
  }
}

function auditApp(
  logs: OperationAuditLogs,
  options: { ssh?: SshApiDeps; users?: UserAdapter; docker?: DockerReadService } = {},
): Hono {
  const app = new Hono({ strict: false })
  app.onError(endpointErrorHandler)
  app.use('/api/*', createOperationAudit(logs))
  app.route(SSH_MOUNT, createSshApp(options.ssh ?? { available: true, service: createFakeSshService() }))
  app.route(USERS_MOUNT, createUsersApp({ available: true, service: options.users ?? createFakeUserService() }))
  app.route(
    DOCKER_MOUNT,
    createDockerApp({
      available: true,
      socketReady: true,
      service: options.docker ?? createFakeDockerService(),
    }),
  )
  return app
}

const ORIGIN = 'http://localhost:5173'

/** 发往挂载后端点的 Request：默认同源合法头；带体请求显式声明 JSON 与真实长度。 */
function requestOf(
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: 'localhost:5173', origin: ORIGIN, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })
}

function jsonRequest(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const payload = JSON.stringify(body)
  return requestOf(method, path, {
    body: payload,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload, 'utf8')),
      ...headers,
    },
  })
}

describe('createOperationAudit', () => {
  it('命中描述符的写请求记一条操作日志 + 一条运行日志镜像，字段全部来自服务端', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }))

    expect(res.status).toBe(200)
    expect(sink.operations).toEqual([
      {
        category: 'security',
        action: '修改 SSH 监听端口',
        target: 'sshd',
        result: 'success',
        summary: '端口 2222',
        method: 'PUT',
        path: `${SSH_MOUNT}/port`,
        httpStatus: 200,
      },
    ])
    expect(sink.logs).toEqual([
      { level: 'info', source: 'logs.operation', message: '操作：修改 SSH 监听端口（成功）' },
    ])
  })

  it('GET/HEAD 只读不谈：不记录、也不写运行日志镜像', async () => {
    const { logs, sink } = createLogsSink()
    const app = auditApp(logs)
    expect((await app.request(requestOf('GET', `${SSH_MOUNT}/settings`))).status).toBe(200)
    expect((await app.request(requestOf('HEAD', `${SSH_MOUNT}/settings`))).status).toBe(200)
    expect(sink.operations).toEqual([])
    expect(sink.logs).toEqual([])
  })

  it('业务 4xx 记 failure（点了按钮但没生效同样要留痕）', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(jsonRequest('PUT', `${SSH_MOUNT}/port`, {}))
    expect(res.status).toBe(400)
    expect(sink.operations[0]).toMatchObject({ result: 'failure', httpStatus: 400, action: '修改 SSH 监听端口' })
  })

  it('读体守卫 415 / 413 也记 failure，httpStatus 带上码', async () => {
    const { logs, sink } = createLogsSink()
    const app = auditApp(logs)

    const noType = await app.request(requestOf('PUT', `${SSH_MOUNT}/port`, { body: '{}' }))
    expect(noType.status).toBe(415)

    const tooLarge = await app.request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }, { 'content-length': String(64 * 1024 + 1) }),
    )
    expect(tooLarge.status).toBe(413)

    expect(sink.operations.map((input) => input.httpStatus)).toEqual([415, 413])
    expect(sink.operations.every((input) => input.result === 'failure')).toBe(true)
  })

  it('跨源 403 且命中具体路由时记录（越权尝试正是审计要看的东西）', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }, { origin: 'http://evil.example' }),
    )
    expect(res.status).toBe(403)
    expect(sink.operations).toEqual([
      {
        category: 'security',
        action: '修改 SSH 监听端口',
        target: 'sshd',
        result: 'failure',
        summary: '端口 2222',
        method: 'PUT',
        path: `${SSH_MOUNT}/port`,
        httpStatus: 403,
      },
    ])
  })

  it('跨源 403 但无具体路由时不记录（守卫在路由分发之前短路，没有可归属的动作）', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(
      jsonRequest('POST', `${SSH_MOUNT}/nope`, {}, { origin: 'http://evil.example' }),
    )
    expect(res.status).toBe(403)
    expect(sink.operations).toEqual([])
    expect(sink.logs).toEqual([])
  })

  it('404（未知路径）不记录', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(jsonRequest('POST', `${SSH_MOUNT}/nope`, {}))
    expect(res.status).toBe(404)
    expect(sink.operations).toEqual([])
    expect(sink.logs).toEqual([])
  })

  it('整片 503 不记录（服务根本不可用、动作没发生，宿主机本地开发下会刷屏）', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs, { ssh: { available: false } }).request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }),
    )
    expect(res.status).toBe(503)
    expect(sink.operations).toEqual([])
    expect(sink.logs).toEqual([])
  })

  it('子应用映射出的 5xx 记 failure，并补一条运行日志 error', async () => {
    const { logs, sink } = createLogsSink()
    const failing = createFakeSshService()
    failing.setPort = async () => {
      throw new Error('sshd 重启失败：/etc/ssh/sshd_config 不可写')
    }
    const res = await auditApp(logs, { ssh: { available: true, service: failing } }).request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }),
    )

    expect(res.status).toBe(500)
    expect(sink.operations[0]).toMatchObject({ result: 'failure', httpStatus: 500 })
    expect(sink.logs).toEqual([
      { level: 'warning', source: 'logs.operation', message: '操作：修改 SSH 监听端口（失败）' },
      { level: 'error', source: 'server.http', message: `请求处理失败：PUT ${SSH_MOUNT}/port — HTTP 500` },
    ])
  })

  it('next() 抛异常：按 500 记录、补 error 运行日志，异常继续上抛给上层错误映射', async () => {
    const { logs, sink } = createLogsSink()
    const app = new Hono({ strict: false })
    app.onError(endpointErrorHandler)
    app.use('/api/*', createOperationAudit(logs))
    // 父层中间件（子应用 onError 管不到它）抛错，且必须排在片路由之前才会被走到：
    // next() 把异常交给采集器，采集器记完原样抛出，最终由父 onError 映射成 500。
    app.use(`${SSH_MOUNT}/*`, () => {
      throw new Error('父层中间件炸了')
    })
    app.route(SSH_MOUNT, createSshApp({ available: true, service: createFakeSshService() }))

    const res = await app.request(jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }))
    expect(res.status).toBe(500)
    expect(sink.operations[0]).toMatchObject({
      action: '修改 SSH 监听端口',
      result: 'failure',
      httpStatus: 500,
      summary: '端口 2222',
    })
    expect(sink.logs).toContainEqual({
      level: 'error',
      source: 'server.http',
      message: `请求处理失败：PUT ${SSH_MOUNT}/port — HTTP 500`,
    })
  })

  it('摘要只取白名单字段：体里的额外字段不进摘要', async () => {
    const { logs, sink } = createLogsSink()
    await auditApp(logs).request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222, evil: '注入内容', 摘要: '伪造摘要' }),
    )
    expect(sink.operations[0]?.summary).toBe('端口 2222')
    const serialized = JSON.stringify(sink.operations)
    expect(serialized).not.toContain('evil')
    expect(serialized).not.toContain('注入内容')
    expect(serialized).not.toContain('伪造摘要')
  })

  it('体里伪造审计字段（category/action/result/actor/at）不改变落盘的记录', async () => {
    const { logs, sink } = createLogsSink()
    await auditApp(logs).request(
      jsonRequest('PUT', `${SSH_MOUNT}/port`, {
        port: 2222,
        category: 'database',
        action: '已批准的删除',
        result: 'success',
        actor: 'root',
        at: '2000-01-01T00:00:00.000Z',
      }),
    )
    expect(sink.operations[0]).toMatchObject({ category: 'security', action: '修改 SSH 监听端口', result: 'success' })
    const serialized = JSON.stringify(sink.operations[0])
    expect(serialized).not.toContain('database')
    expect(serialized).not.toContain('已批准的删除')
    expect(serialized).not.toContain('root')
    // 时间由服务层在写入时取服务端时钟：采集器交给服务层的输入里根本没有 at。
    expect(sink.operations[0]).not.toHaveProperty('at')
  })

  it('未声明 summarize 的端点是凭据隔离的：请求体里的密码不出现在任何记录里', async () => {
    const { logs, sink } = createLogsSink()
    const app = auditApp(logs)

    const rootPassword = await app.request(
      jsonRequest('POST', `${SSH_MOUNT}/root-password`, { password: 'Zh9aiphoo1aiya' }),
    )
    expect(rootPassword.status).toBe(200)

    const userCreate = await app.request(
      jsonRequest('POST', USERS_MOUNT, {
        name: 'wangwu',
        password: 'Eiph7eivai0ahth',
        loginMethod: 'password',
        status: 'active',
        isAdmin: false,
        note: null,
      }),
    )
    expect(userCreate.status).toBe(200)

    const userUpdate = await app.request(
      jsonRequest('PUT', `${USERS_MOUNT}/wangwu`, {
        password: 'Aiquu8uuc2eiv4o',
        loginMethod: 'password',
        status: 'active',
        isAdmin: false,
        note: null,
      }),
    )
    expect(userUpdate.status).toBe(200)

    const serialized = JSON.stringify(sink.operations)
    for (const secret of ['Zh9aiphoo1aiya', 'Eiph7eivai0ahth', 'Aiquu8uuc2eiv4o']) {
      expect(serialized).not.toContain(secret)
    }
    // 三个端点都没有摘要：未声明 summarize 的端点恒不读体，密码在结构上不可能进日志。
    // （路径里的 root-password 是端点名，不是凭据材料，因此这里断言的是摘要与字段集合。）
    expect(sink.operations.every((input) => input.summary === null)).toBe(true)
    for (const input of sink.operations) {
      expect(Object.keys(input).sort()).toEqual(
        ['action', 'category', 'httpStatus', 'method', 'path', 'result', 'summary', 'target'].sort(),
      )
    }
    // 动作与对象照常留痕（记录的不是「什么都没发生」）。
    expect(sink.operations.map((input) => input.action)).toEqual([
      '重置 Root 密码',
      '创建系统账号',
      '修改系统账号',
    ])
    expect(sink.operations[2]).toMatchObject({ target: '账号 wangwu', result: 'success' })
  })

  it('路径参数还原进 target；体里的对象名取白名单字段', async () => {
    const { logs, sink } = createLogsSink()
    const app = auditApp(logs)

    await app.request(jsonRequest('DELETE', `${SSH_MOUNT}/keys/k-9`, null))
    await app.request(jsonRequest('POST', `${SSH_MOUNT}/keys`, { name: '笔记本', userId: 'wangwu' }))

    expect(sink.operations[0]).toMatchObject({ action: '删除登录密钥', target: 'k-9', summary: null })
    expect(sink.operations[1]).toMatchObject({ action: '创建登录密钥', target: '账号 wangwu', summary: '名称 笔记本' })
  })

  it('摘要在体超过读取上限时退化为无（不为了摘要去解析任意大小的体）', async () => {
    const { logs, sink } = createLogsSink()
    const padding = 'x'.repeat(OPERATION_SUMMARY_BODY_MAX_BYTES + 1)
    await auditApp(logs).request(jsonRequest('POST', `${SSH_MOUNT}/keys`, { name: padding, userId: 'wangwu' }))
    expect(sink.operations[0]).toMatchObject({ summary: null, action: '创建登录密钥' })
  })

  it('坏 JSON 体不影响记录本身：摘要为空、结果按最终状态码判定', async () => {
    const { logs, sink } = createLogsSink()
    const res = await auditApp(logs).request(
      requestOf('PUT', `${SSH_MOUNT}/port`, {
        body: '{',
        headers: { 'content-type': 'application/json', 'content-length': '1' },
      }),
    )
    expect(res.status).toBe(400)
    expect(sink.operations[0]).toMatchObject({ result: 'failure', httpStatus: 400, summary: null })
  })

  it('采集写盘失败不影响业务响应（动作已经真实执行，回 500 是撒谎）', async () => {
    const { logs } = createLogsSink({
      recordOperation: async () => {
        throw new Error('磁盘满')
      },
      log: async () => {
        throw new Error('磁盘满')
      },
    })
    const res = await auditApp(logs).request(jsonRequest('PUT', `${SSH_MOUNT}/port`, { port: 2222 }))
    expect(res.status).toBe(200)
  })

  it('创建容器摘要不含环境变量值', async () => {
    const { logs, sink } = createLogsSink()
    const imageHex = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    const res = await auditApp(logs).request(
      jsonRequest('POST', `${DOCKER_MOUNT}/containers`, {
        imageId: imageHex,
        name: 'redis-echo',
        ports: [],
        env: [{ key: 'DB_PASSWORD', value: 'super-secret' }],
        volumes: [],
        restartPolicy: 'no',
      }),
    )
    expect(res.status).toBe(201)
    expect(sink.operations[0]).toMatchObject({
      action: '创建容器',
      target: 'redis-echo',
      summary: `镜像 ${imageHex}`,
      result: 'success',
    })
    const serialized = JSON.stringify(sink.operations[0])
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('DB_PASSWORD')
  })

  it('清空日志这条写请求本身也留痕（想抹掉痕迹只会留下「抹掉痕迹」这条痕迹）', async () => {
    const { logs, sink } = createLogsSink()
    const app = new Hono({ strict: false })
    app.onError(endpointErrorHandler)
    app.use('/api/*', createOperationAudit(logs))
    // 日志片在这里以最小形状顶替：本用例只关心采集器对这条写请求的处置。
    app.route(LOGS_MOUNT, new Hono().post('/runtime/clear', (c) => c.json({ cleared: {} })))

    const res = await app.request(jsonRequest('POST', `${LOGS_MOUNT}/runtime/clear`, {}))
    expect(res.status).toBe(200)
    expect(sink.operations[0]).toMatchObject({
      category: 'logs',
      action: '清空运行日志',
      result: 'success',
      method: 'POST',
      path: `${LOGS_MOUNT}/runtime/clear`,
      httpStatus: 200,
    })
  })
})

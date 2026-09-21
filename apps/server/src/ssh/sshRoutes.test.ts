import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { SshLoginKey, SshLoginRecord, SshOverview, SshPasswordResetResult, SshRootAuth, SshAdapter, SshKeyAccount } from '@elysian/contracts'
import { invalidRequest } from '../shared/errors'
import { SSH_MOUNT, createSshApp, type SshApiDeps } from './sshRoutes'
import type { SshListKeysReport } from './sshService'

/*
 * SSH 端点路由的行为测试：fake service 不执行任何真实命令，请求经 Hono 的
 * app.request 驱动（守卫链在路由内真实走一遍）。守卫用例与防火墙端点同源
 * （跨源 403 先于读体、415、413 双拦、大小写归一放行）。
 */

const SAMPLE_OVERVIEW: SshOverview = {
  enabled: true,
  status: 'running',
  changedAt: null,
  stats: { today: { succeeded: 1, failed: 2 }, yesterday: { succeeded: 0, failed: 0 }, last7Days: { succeeded: 3, failed: 9 } },
}

const SAMPLE_ROOT_AUTH: SshRootAuth = {
  policy: 'prohibit-password',
  key: null,
  passwordResetAt: null,
}

const SAMPLE_KEY: SshLoginKey = {
  id: 'sshkey-0000abcd',
  name: '部署机',
  userId: 'ops',
  algorithm: 'ssh-ed25519 256',
  fingerprint: 'SHA256:abcd',
  createdAt: '2026-09-18T12:00:00.000Z',
  publicKey: 'ssh-ed25519 AAAA占位 elysian-部署机',
}

const SAMPLE_ACCOUNTS: readonly SshKeyAccount[] = [{ id: 'ops', name: 'ops' }]

const SAMPLE_RECORDS: readonly SshLoginRecord[] = [
  { id: 'login-1', ip: '1.2.3.4', port: 111, at: '2026-09-18T11:00:00.000Z', user: 'root', result: 'failed' },
]

/** 与真实装配同形的服务句柄：SshAdapter 契约之外附带密钥列表的脏行报告。 */
type FakeSshService = SshAdapter & {
  listKeysWithReport(): Promise<SshListKeysReport>
}

function createFakeService(overrides: Partial<FakeSshService> = {}): FakeSshService {
  return {
    overview: async () => ({ ...SAMPLE_OVERVIEW, stats: { ...SAMPLE_OVERVIEW.stats } }),
    settings: async () => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 73 }),
    rootAuth: async () => ({ ...SAMPLE_ROOT_AUTH }),
    setServiceEnabled: async (enabled) => ({ ...SAMPLE_OVERVIEW, enabled, status: enabled ? 'running' : 'stopped' }),
    setAuthMethods: async (methods) => ({ ...methods, port: 73 }),
    setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    saveRootLoginPolicy: async (policy) => ({ ...SAMPLE_ROOT_AUTH, policy }),
    resetRootPassword: async (): Promise<SshPasswordResetResult> => ({
      auth: { ...SAMPLE_ROOT_AUTH, passwordResetAt: '2026-09-18T12:00:00.000Z' },
      strength: 'strong',
    }),
    listKeys: async () => [SAMPLE_KEY],
    listKeysWithReport: async () => ({ keys: [SAMPLE_KEY], ignoredInvalidLines: 0 }),
    listLoginRecords: async () => SAMPLE_RECORDS,
    keyAccounts: async () => SAMPLE_ACCOUNTS,
    createKey: async () => ({ ...SAMPLE_KEY, privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n占位\n-----END OPENSSH PRIVATE KEY-----' }),
    createRootKey: async () => ({
      ...SAMPLE_ROOT_AUTH,
      key: {
        algorithm: 'ssh-ed25519 256',
        fingerprint: 'SHA256:rootkey',
        createdAt: '2026-09-18T12:00:00.000Z',
        publicKey: 'ssh-ed25519 AAAAroot elysian-root',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nroot 占位\n-----END OPENSSH PRIVATE KEY-----',
      },
    }),
    removeKey: async () => undefined,
    ...overrides,
  }
}

const AVAILABLE: SshApiDeps = { available: true, service: createFakeService() }

/** 组请求描述：默认同源合法头（Origin 与 Host 一致），带体请求声明 JSON 与真实长度；用 headers 覆盖可构造守卫用例。 */
async function call(
  deps: SshApiDeps,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: unknown }> {
  const payload = body ?? ''
  const res = await createSshApp(deps).request(path, {
    method,
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      ...(body !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) }
        : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: payload } : {}),
  })
  return { statusCode: res.status, body: await res.json() }
}

/** JSON 请求体快捷封装：对象序列化为字符串后走 call。 */
function json(value: unknown): string {
  return JSON.stringify(value)
}

describe('createSshApp', () => {
  it('不可用时一律 503（容器边界保护，未知路径同样 503）', async () => {
    const deps: SshApiDeps = { available: false }
    for (const [method, url] of [
      ['GET', '/overview'],
      ['PUT', '/port'],
      ['POST', '/root-key'],
      ['DELETE', '/keys/sshkey-0000abcd'],
      ['GET', '/nowhere'],
    ] as const) {
      const { statusCode, body } = await call(deps, method, url, method === 'PUT' ? json({ port: 22 }) : method === 'POST' ? json({}) : undefined)
      expect(statusCode).toBe(503)
      expect(body).toEqual({ error: '真实 SSH 管理仅在 Docker 容器内可用' })
    }
  })

  it('GET /overview、/settings、/root-auth、/keys、/key-accounts、/login-records 各回各的数据', async () => {
    const overview = await call(AVAILABLE, 'GET', '/overview')
    expect(overview.statusCode).toBe(200)
    expect(overview.body).toEqual(SAMPLE_OVERVIEW)

    const settings = await call(AVAILABLE, 'GET', '/settings')
    expect(settings.body).toEqual({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 73 })

    const rootAuth = await call(AVAILABLE, 'GET', '/root-auth')
    expect(rootAuth.body).toEqual(SAMPLE_ROOT_AUTH)

    const keys = await call(AVAILABLE, 'GET', '/keys')
    expect(keys.body).toEqual({ keys: [SAMPLE_KEY], ignoredInvalidLines: 0 })

    const accounts = await call(AVAILABLE, 'GET', '/key-accounts')
    expect(accounts.body).toEqual({ accounts: SAMPLE_ACCOUNTS })

    const records = await call(AVAILABLE, 'GET', '/login-records')
    expect(records.body).toEqual({ records: SAMPLE_RECORDS })
  })

  it('PUT /service-enabled、/auth-methods、/port、/root-login-policy 透传给 service', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      setServiceEnabled: async (enabled) => {
        calls.push(['service-enabled', enabled])
        return SAMPLE_OVERVIEW
      },
      setAuthMethods: async (methods) => {
        calls.push(['auth-methods', methods])
        return { ...methods, port: 73 }
      },
      setPort: async (port) => {
        calls.push(['port', port])
        return { passwordAuthEnabled: false, keyAuthEnabled: true, port }
      },
      saveRootLoginPolicy: async (policy) => {
        calls.push(['policy', policy])
        return { ...SAMPLE_ROOT_AUTH, policy }
      },
    })
    const deps: SshApiDeps = { available: true, service }

    await call(deps, 'PUT', '/service-enabled', json({ enabled: false }))
    await call(deps, 'PUT', '/auth-methods', json({ passwordAuthEnabled: true, keyAuthEnabled: false }))
    await call(deps, 'PUT', '/port', json({ port: 2202 }))
    await call(deps, 'PUT', '/root-login-policy', json({ policy: 'no' }))

    expect(calls).toEqual([
      ['service-enabled', false],
      ['auth-methods', { passwordAuthEnabled: true, keyAuthEnabled: false }],
      ['port', 2202],
      ['policy', 'no'],
    ])
  })

  it('GET /keys 响应附带忽略的无效行数：authorized_keys 有脏行时列表仍可用', async () => {
    const service = createFakeService({
      listKeysWithReport: async () => ({ keys: [], ignoredInvalidLines: 2 }),
    })
    const { statusCode, body } = await call({ available: true, service }, 'GET', '/keys')
    expect(statusCode).toBe(200)
    expect(body).toEqual({ keys: [], ignoredInvalidLines: 2 })
  })

  it('POST /root-password 透传密码，创建响应携带一次性私钥', async () => {
    const passwords: string[] = []
    const service = createFakeService({
      resetRootPassword: async (password) => {
        passwords.push(password)
        return { auth: SAMPLE_ROOT_AUTH, strength: 'strong' }
      },
    })
    const deps: SshApiDeps = { available: true, service }

    const { statusCode, body } = await call(deps, 'POST', '/root-password', json({ password: 'Elysian#2026Root' }))
    expect(statusCode).toBe(200)
    expect(passwords).toEqual(['Elysian#2026Root'])
    expect((body as SshPasswordResetResult).strength).toBe('strong')

    const created = await call(deps, 'POST', '/keys', json({ name: '部署机', userId: 'ops' }))
    expect(created.statusCode).toBe(200)
    expect((created.body as { key: SshLoginKey }).key.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('POST /root-key 生成 Root 密钥，响应一次性携带私钥', async () => {
    let calls = 0
    const service = createFakeService({
      createRootKey: async () => {
        calls += 1
        return {
          ...SAMPLE_ROOT_AUTH,
          key: {
            algorithm: 'ssh-ed25519 256',
            fingerprint: 'SHA256:rootkey',
            createdAt: '2026-09-18T12:00:00.000Z',
            publicKey: 'ssh-ed25519 AAAAroot elysian-root',
            privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nroot 占位\n-----END OPENSSH PRIVATE KEY-----',
          },
        }
      },
    })
    const deps: SshApiDeps = { available: true, service }

    const { statusCode, body } = await call(deps, 'POST', '/root-key', json({}))
    expect(statusCode).toBe(200)
    expect(calls).toBe(1)
    expect((body as SshRootAuth).key?.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')

    // 空请求体被守卫拦下（读体走同一套 Content-Type 与非空校验）。
    const empty = await call(deps, 'POST', '/root-key', '')
    expect(empty.statusCode).toBe(400)
    expect((empty.body as { error: string }).error).toBe('请求体不能为空')
  })

  it('POST /keys 与 DELETE /keys/:id 传递名称、账号与解码后的 id', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      createKey: async (input) => {
        calls.push(['create', input])
        return SAMPLE_KEY
      },
      removeKey: async (keyId) => {
        calls.push(['remove', keyId])
      },
    })
    const deps: SshApiDeps = { available: true, service }

    await call(deps, 'POST', '/keys', json({ name: '部署机', userId: 'ops' }))
    await call(deps, 'DELETE', `/keys/${encodeURIComponent('sshkey-0000abcd')}`)
    expect(calls).toEqual([['create', { name: '部署机', userId: 'ops' }], ['remove', 'sshkey-0000abcd']])
  })

  it('形状不对的请求体以中文错误返回 400', async () => {
    const enabled = await call(AVAILABLE, 'PUT', '/service-enabled', json({ enabled: '是' }))
    expect(enabled.statusCode).toBe(400)
    expect((enabled.body as { error: string }).error).toBe('开关值无效')

    const methods = await call(AVAILABLE, 'PUT', '/auth-methods', json({ passwordAuthEnabled: true }))
    expect((methods.body as { error: string }).error).toBe('登录方式开关需为布尔值')

    const policy = await call(AVAILABLE, 'PUT', '/root-login-policy', json({ policy: '随便' }))
    expect((policy.body as { error: string }).error).toBe('无效的 Root 登录策略：随便')

    const key = await call(AVAILABLE, 'POST', '/keys', json({ name: 42 }))
    expect((key.body as { error: string }).error).toBe('密钥请求体无效')
  })

  it('请求被拒（校验不通过）按 400 返回，系统侧失败才是 500', async () => {
    const rejected = createFakeService({
      setPort: async () => {
        throw invalidRequest('sshd 配置预检未通过，已回滚原配置：Bad 配置取值')
      },
    })
    const rejectedResponse = await call({ available: true, service: rejected }, 'PUT', '/port', json({ port: 70000 }))
    expect(rejectedResponse.statusCode).toBe(400)
    expect(rejectedResponse.body).toEqual({ error: 'sshd 配置预检未通过，已回滚原配置：Bad 配置取值' })

    const broken = createFakeService({
      setServiceEnabled: async () => {
        throw new Error('启动 sshd 失败：ssh-keygen 不存在')
      },
    })
    const brokenResponse = await call({ available: true, service: broken }, 'PUT', '/service-enabled', json({ enabled: true }))
    expect(brokenResponse.statusCode).toBe(500)
    expect(brokenResponse.body).toEqual({ error: '启动 sshd 失败：ssh-keygen 不存在' })
  })

  it('未知端点返回 404，文案为剥离挂载前缀后的相对路径', async () => {
    const { statusCode, body } = await call(AVAILABLE, 'GET', '/nowhere')
    expect(statusCode).toBe(404)
    expect(body).toEqual({ error: '未知 SSH 端点：GET /nowhere' })

    // 经父应用挂载后（app.route(SSH_MOUNT, …)）子应用拿到的是全路径，文案仍须剥前缀；
    // 这里自建父应用复现同一挂载机制，不引入防火墙片的 bun:sqlite 接线。
    const parent = new Hono()
    parent.route(SSH_MOUNT, createSshApp(AVAILABLE))
    const mounted = await parent.request('/api/security/ssh/nowhere', { method: 'GET' })
    expect(mounted.status).toBe(404)
    expect(await mounted.json()).toEqual({ error: '未知 SSH 端点：GET /nowhere' })
  })

  it('跨源 PUT 在读体之前返回 403', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      setPort: async (port) => {
        calls.push(port)
        return { passwordAuthEnabled: false, keyAuthEnabled: true, port }
      },
    })
    const deps: SshApiDeps = { available: true, service }
    // 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 400 的解析错误而非 403。
    const { statusCode, body } = await call(deps, 'PUT', '/port', 'not-json', {
      origin: 'http://evil.example',
    })
    expect(statusCode).toBe(403)
    expect(body).toEqual({ error: '请求来源不允许' })
    expect(calls).toEqual([])
  })

  it('text/plain 的写请求返回 415', async () => {
    const { statusCode, body } = await call(AVAILABLE, 'PUT', '/port', '{}', {
      'content-type': 'text/plain',
    })
    expect(statusCode).toBe(415)
    expect(body).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('请求体超过 64 KiB 返回 413（申报与实读都拦）', async () => {
    // 申报即超限：不看流直接拒。
    const declared = await call(AVAILABLE, 'PUT', '/port', '{}', {
      'content-length': String(64 * 1024 + 1),
    })
    expect(declared.statusCode).toBe(413)

    // 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const lied = await call(AVAILABLE, 'PUT', '/port', oversized, {
      'content-length': '2',
    })
    expect(lied.statusCode).toBe(413)
    expect(lied.body).toEqual({ error: '请求体过大' })
  })

  it('同源 application/json 写请求正常通过守卫；大小写归一放行', async () => {
    const { statusCode } = await call(AVAILABLE, 'PUT', '/port', json({ port: 2202 }))
    expect(statusCode).toBe(200)

    // 大小写归一：Host 大小写不同仍视为同源；带 charset 的 Content-Type 前缀匹配放行。
    const relaxed = await call(AVAILABLE, 'PUT', '/service-enabled', '{"enabled":false}', {
      host: 'LOCALHOST:5173',
      'content-type': 'application/json; charset=utf-8',
    })
    expect(relaxed.statusCode).toBe(200)
  })
})

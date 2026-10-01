import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthApp, type AuthAppDeps } from './authRoutes.ts'
import { DUMMY_HASH, SESSION_COOKIE_NAME, SESSION_IDLE_TTL_MS } from './authConfig.ts'
import { createFileCredentialsStore, createMemoryCredentialsStore, type CredentialsStore } from './credentialsStore.ts'
import { createFileSessionStore, createMemorySessionStore } from './sessionStore.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'
import { createMemoryReturnOriginRegistry } from './returnOriginRegistry.ts'

/*
 * 登录片路由测试：内存 fake（真实 scrypt hasher——时序与往返行为本身就是被测对象），
 * app.request 驱动。锚定 Cookie 属性逐项、401 文案逐字、哑哈希时序纪律、限流、
 * logout 幂等与 /session 三种组合。
 */

const ORIGIN = 'http://localhost:5173'
const EPOCH = '2026-09-30T00:00:00.000Z'

/** 记录型 hasher：包住真实 scrypt 实现，记录每次 verify 的 stored（断言哑哈希纪律）。 */
function recordingHasher(): { hasher: PasswordHasher; verifyCalls: string[] } {
  const real = createScryptHasher()
  const verifyCalls: string[] = []
  const hasher: PasswordHasher = {
    hash: (plain) => real.hash(plain),
    verify: async (plain, stored) => {
      verifyCalls.push(stored)
      return real.verify(plain, stored)
    },
  }
  return { hasher, verifyCalls }
}

type Fixture = {
  deps: AuthAppDeps
  verifyCalls: string[]
  setCredentials: (hash: string | null) => void
}

function fixture(overrides: Partial<AuthAppDeps> = {}): Fixture {
  const { hasher, verifyCalls } = recordingHasher()
  const deps: AuthAppDeps = {
    enabled: true,
    devAccount: false,
    credentials: createMemoryCredentialsStore(),
    sessions: createMemorySessionStore(),
    hasher,
    returnOrigins: createMemoryReturnOriginRegistry(),
    ...overrides,
  }
  return {
    deps,
    verifyCalls,
    /** 换凭据：null 表示「凭据文件缺失」（新内存 store 即空）。 */
    setCredentials: (hash) => {
      deps.credentials = hash === null
        ? createMemoryCredentialsStore()
        : createMemoryCredentialsStore({ username: 'admin', passwordHash: hash, passwordChangedAt: EPOCH })
    },
  }
}

function loginRequest(body: unknown, path = '/login'): Request {
  return new Request(`http://localhost:5173${path}`, {
    method: 'POST',
    headers: { host: 'localhost:5173', origin: ORIGIN, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function login(app: ReturnType<typeof createAuthApp>, body: unknown): Promise<Response> {
  return app.request(loginRequest(body))
}

describe('POST /api/auth/login', () => {
  it('admin 正确密码：200 { ok: true }，Set-Cookie 属性逐项正确（HttpOnly/SameSite=Lax/Path=/；无 Secure）', async () => {
    const { hasher } = recordingHasher()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('right-password'), passwordChangedAt: EPOCH }),
      sessions: createMemorySessionStore(),
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const res = await login(app, { username: 'admin', password: 'right-password' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800$`))
  })

  it('密码错：401 文案逐字「用户名或密码错误」', async () => {
    const f = fixture()
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'admin', password: 'wrong-password' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: '用户名或密码错误' })
  })

  it('用户名错：同样 401 同文案，且恰好对哑哈希调用一次 verify（防时序分支回归）', async () => {
    const f = fixture()
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'nosuch', password: 'whatever' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: '用户名或密码错误' })
    expect(f.verifyCalls).toEqual([DUMMY_HASH])
  })

  it('凭据文件缺失：admin 登录 401 同文案，verify 恰好一次（哑哈希）', async () => {
    const f = fixture()
    f.setCredentials(null)
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'admin', password: 'whatever' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: '用户名或密码错误' })
    expect(f.verifyCalls).toEqual([DUMMY_HASH])
  })

  it('dev 开关关：dev 账号 401，与任意错误口令无异（无可探测差异）', async () => {
    const f = fixture()
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'dev', password: 'dev-elysian' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: '用户名或密码错误' })
    expect(f.verifyCalls).toEqual([DUMMY_HASH])
  })

  it('dev 开关开：dev / dev-elysian 可登录且走同一会话机制；epoch 取凭据文件当前值', async () => {
    const f = fixture({ devAccount: true })
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'dev', password: 'dev-elysian' })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43}`))

    // dev 登录的会话与 admin 凭据同 epoch：改密后同样失效（epoch 机制对所有会话一致）。
    const sessionId = cookie!.split(';')[0]!.slice(`${SESSION_COOKIE_NAME}=`.length)
    const sessionRes = await app.request(`http://localhost:5173/session`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
    })
    expect(await sessionRes.json()).toEqual({ authenticated: true, devAccount: true })
  })

  it('dev 开关开但密码错：401 且 verify 恰好一次（哑哈希）', async () => {
    const f = fixture({ devAccount: true })
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'dev', password: 'not-dev-password' })
    expect(res.status).toBe(401)
    expect(f.verifyCalls).toEqual([DUMMY_HASH])
  })

  it('请求体形状不合法：400 { error: \'请求体不合法\' }', async () => {
    // 放宽限额：本用例连发多次，锚定的是形状校验而不是限流（限流另有专测）。
    const f = fixture({ loginRateLimit: 20 })
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    for (const body of [
      {},
      { username: 'admin' },
      { username: '', password: 'x' },
      { username: 'admin', password: '' },
      { username: 1, password: 'x' },
      { username: 'a'.repeat(257), password: 'x' },
      ['admin', 'x'],
    ]) {
      const res = await login(app, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: '请求体不合法' })
    }
  })

  it('Content-Type 不是 JSON：415（readJsonBody 双拦语义保留）', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(new Request(`http://localhost:5173/login`, {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN, 'content-type': 'text/plain' },
      body: 'username=admin&password=x',
    }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('限流在前：超限尝试 429 + Retry-After（整秒 ≥ 1）与中文文案，窗口滚动后恢复', async () => {
    // 窗口必须显著大于单次 scrypt 校验耗时（三次登录都在窗口内），等待窗口滚过后再验证恢复。
    const f = fixture({ loginRateLimit: 2, loginRateWindowMs: 1500 })
    f.setCredentials(await createScryptHasher().hash('right-password'))
    const app = createAuthApp(f.deps)
    expect((await login(app, { username: 'admin', password: 'right-password' })).status).toBe(200)
    expect((await login(app, { username: 'admin', password: 'wrong' })).status).toBe(401)

    const limited = await login(app, { username: 'admin', password: 'right-password' })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: '登录尝试过于频繁，请稍后再试' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)

    await new Promise((resolve) => setTimeout(resolve, 1600))
    expect((await login(app, { username: 'admin', password: 'right-password' })).status).toBe(200)
  })

  it('ELYSIAN_COOKIE_SECURE=1 时会话 Cookie 追加 Secure', async () => {
    const previous = process.env.ELYSIAN_COOKIE_SECURE
    process.env.ELYSIAN_COOKIE_SECURE = '1'
    try {
      const hasher = createScryptHasher()
      const deps: AuthAppDeps = {
        enabled: true,
        devAccount: false,
        credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('right-password'), passwordChangedAt: EPOCH }),
        sessions: createMemorySessionStore(),
        hasher,
        returnOrigins: createMemoryReturnOriginRegistry(),
      }
      const app = createAuthApp(deps)
      const res = await login(app, { username: 'admin', password: 'right-password' })
      expect(res.headers.get('set-cookie')).toMatch(
        new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$`),
      )
    } finally {
      if (previous === undefined) delete process.env.ELYSIAN_COOKIE_SECURE
      else process.env.ELYSIAN_COOKIE_SECURE = previous
    }
  })

  it('跨源写请求被同源守卫 403（登录片自带 sameOriginGuard）', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(new Request(`http://localhost:5173/login`, {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
  })

  it('enabled: false（无鉴权演示）：/login 恒成功、不下发 Cookie', async () => {
    const f = fixture({ enabled: false })
    const app = createAuthApp(f.deps)
    const res = await login(app, { username: 'whatever', password: 'whatever' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('POST /api/auth/logout', () => {
  it('有会话时销毁会话并清 Cookie', async () => {
    const hasher = createScryptHasher()
    const sessions = createMemorySessionStore()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('p'), passwordChangedAt: EPOCH }),
      sessions,
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const loginRes = await login(app, { username: 'admin', password: 'p' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    const res = await app.request(`http://localhost:5173/logout`, {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN, cookie },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toBe(`${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)

    const sessionRes = await app.request(`http://localhost:5173/session`, { headers: { cookie } })
    expect(await sessionRes.json()).toEqual({ authenticated: false, devAccount: false })
  })

  it('无会话也幂等 200 并清 Cookie（豁免鉴权、避免过期后登出 401 死循环）', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(`http://localhost:5173/logout`, {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('GET /api/auth/session', () => {
  async function appWithPassword(password: string): Promise<{ app: ReturnType<typeof createAuthApp>; cookie: string }> {
    const hasher = createScryptHasher()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash(password), passwordChangedAt: EPOCH }),
      sessions: createMemorySessionStore(),
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const loginRes = await login(app, { username: 'admin', password })
    return { app, cookie: loginRes.headers.get('set-cookie')!.split(';')[0]! }
  }

  it('未登录：{ authenticated: false, devAccount: false }，Cache-Control no-store', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(`http://localhost:5173/session`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ authenticated: false, devAccount: false })
  })

  it('已登录：{ authenticated: true, devAccount: false }', async () => {
    const { app, cookie } = await appWithPassword('right-password')
    const res = await app.request(`http://localhost:5173/session`, { headers: { cookie } })
    expect(await res.json()).toEqual({ authenticated: true, devAccount: false })
  })

  it('改密后（epoch 变化）：旧 Cookie 的 /session 回 authenticated:false', async () => {
    const hasher = createScryptHasher()
    const credentials = createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('old-password'), passwordChangedAt: EPOCH })
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials,
      sessions: createMemorySessionStore(),
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const loginRes = await login(app, { username: 'admin', password: 'old-password' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    // CLI 改密等价于凭据换哈希 + 新 passwordChangedAt。
    await credentials.write(await hasher.hash('new-password'))
    const res = await app.request(`http://localhost:5173/session`, { headers: { cookie } })
    expect(await res.json()).toEqual({ authenticated: false, devAccount: false })
  })

  it('enabled: false：恒 { authenticated: true, devAccount: <开关> }', async () => {
    for (const devAccount of [false, true]) {
      const f = fixture({ enabled: false, devAccount })
      const app = createAuthApp(f.deps)
      const res = await app.request(`http://localhost:5173/session`)
      expect(await res.json()).toEqual({ authenticated: true, devAccount })
    }
  })
})

describe('GET /api/auth/session 的回跳裁决', () => {
  const TOOL = 'http://127.0.0.1:5173'

  async function sessionApp(origins: readonly string[]): Promise<{ app: ReturnType<typeof createAuthApp>; cookie: string }> {
    const hasher = createScryptHasher()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({
        username: 'admin',
        passwordHash: await hasher.hash('return-password'),
        passwordChangedAt: EPOCH,
      }),
      sessions: createMemorySessionStore(),
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(origins),
    }
    const app = createAuthApp(deps)
    const loginRes = await login(app, { username: 'admin', password: 'return-password' })
    return { app, cookie: loginRes.headers.get('set-cookie')!.split(';')[0]! }
  }

  it('不带 returnTo 参数：响应键与改动前逐字相同（不含 returnTo）', async () => {
    const { app, cookie } = await sessionApp([TOOL])
    const res = await app.request('http://localhost:5173/session', { headers: { cookie } })
    expect(Object.keys(await res.json() as Record<string, unknown>).sort()).toEqual(['authenticated', 'devAccount'])
  })

  it('带 returnTo 且命中名单：authenticated 与裁决结果一起回答', async () => {
    const { app, cookie } = await sessionApp([TOOL])
    const res = await app.request(
      `http://localhost:5173/session?returnTo=${encodeURIComponent(`${TOOL}/projects/42`)}`,
      { headers: { cookie } },
    )
    expect(await res.json()).toEqual({
      authenticated: true,
      devAccount: false,
      returnTo: `${TOOL}/projects/42`,
    })
  })

  it('带 returnTo 但不在名单：回 null，而 authenticated 如实', async () => {
    const { app, cookie } = await sessionApp([TOOL])
    const res = await app.request(
      `http://localhost:5173/session?returnTo=${encodeURIComponent('http://127.0.0.1:9999/x')}`,
      { headers: { cookie } },
    )
    expect(await res.json()).toEqual({ authenticated: true, devAccount: false, returnTo: null })
  })

  it('未登录时也回答裁决：跳转判定与会话有效性是两件独立的事', async () => {
    const { app } = await sessionApp([TOOL])
    const res = await app.request(`http://localhost:5173/session?returnTo=${encodeURIComponent(`${TOOL}/x`)}`)
    expect(await res.json()).toEqual({ authenticated: false, devAccount: false, returnTo: `${TOOL}/x` })
  })

  it('白名单读取抛错：探测回答不受累，returnTo 按空名单判 null', async () => {
    const { app, cookie } = await sessionApp([TOOL])
    const broken = createAuthApp({
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore(),
      sessions: createMemorySessionStore(),
      hasher: createScryptHasher(),
      returnOrigins: {
        list: async () => {
          throw new Error('模拟 IO 故障')
        },
      },
    })
    const res = await broken.request(`http://localhost:5173/session?returnTo=${encodeURIComponent(`${TOOL}/x`)}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { returnTo: string | null }).returnTo).toBeNull()
    expect((await app.request('http://localhost:5173/session')).status).toBe(200)
  })

  it('enabled:false 的演示语义不回答 returnTo（面板不充当跳转器）', async () => {
    const app = createAuthApp({
      enabled: false,
      devAccount: false,
      credentials: createMemoryCredentialsStore(),
      sessions: createMemorySessionStore(),
      hasher: createScryptHasher(),
      returnOrigins: createMemoryReturnOriginRegistry([TOOL]),
    })
    const res = await app.request(`http://localhost:5173/session?returnTo=${encodeURIComponent(`${TOOL}/x`)}`)
    expect(Object.keys(await res.json() as Record<string, unknown>).sort()).toEqual(['authenticated', 'devAccount'])
  })
})

/*
 * 设置页三个端点（POST /password、GET /sessions、POST /sessions/logout-others）：
 * 内存 fake 直驱 createAuthApp（不经 requireSession——鉴权接线回归在 authWiring.test.ts）。
 * 锚定改密的校验次序与中文 400 文案、Cookie 清除、凭据落盘、会话列表的三字段投影、
 * 退出其他会话的保留语义，以及 enabled:false 时三端点一律 503 且不碰任何文件。
 */

/** 记录型凭据 store：包住内存版，记录每次 write 收到的哈希（断言改密真实落盘内容）。 */
function recordingCredentialsStore(initialHash?: string): { credentials: CredentialsStore; writes: string[] } {
  const inner = createMemoryCredentialsStore(
    initialHash === undefined ? undefined : { username: 'admin', passwordHash: initialHash, passwordChangedAt: EPOCH },
  )
  const writes: string[] = []
  const credentials: CredentialsStore = {
    current: () => inner.current(),
    write: async (hash) => {
      writes.push(hash)
      return inner.write(hash)
    },
  }
  return { credentials, writes }
}

/** 改密请求：与 loginRequest 同源同形（JSON + Origin/Host）。 */
function changeRequest(body: unknown): Request {
  return new Request('http://localhost:5173/password', {
    method: 'POST',
    headers: { host: 'localhost:5173', origin: ORIGIN, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** 已登录的改密 fixture：凭据密码 current-password，记录型凭据 store + 内存会话 store。 */
async function passwordFixture(overrides: Partial<AuthAppDeps> = {}): Promise<{
  app: ReturnType<typeof createAuthApp>
  deps: AuthAppDeps
  writes: string[]
  cookie: string
}> {
  const hasher = createScryptHasher()
  const { credentials, writes } = recordingCredentialsStore(await hasher.hash('current-password'))
  const deps: AuthAppDeps = {
    enabled: true,
    devAccount: false,
    credentials,
    sessions: createMemorySessionStore(),
    hasher,
    returnOrigins: createMemoryReturnOriginRegistry(),
    ...overrides,
  }
  const app = createAuthApp(deps)
  const loginRes = await login(app, { username: 'admin', password: 'current-password' })
  return { app, deps, writes, cookie: loginRes.headers.get('set-cookie')!.split(';')[0]! }
}

const AUTH_DISABLED_MESSAGE = { error: '鉴权未启用，会话管理不可用' }

let settingsTempDir: string | undefined

afterEach(async () => {
  if (settingsTempDir) await rm(settingsTempDir, { recursive: true, force: true }).catch(() => undefined)
  settingsTempDir = undefined
})

describe('POST /api/auth/password', () => {
  it('成功：200 { ok: true }，Set-Cookie Max-Age=0 清 Cookie，credentials.write 收到可验证的新哈希且 passwordChangedAt 前移', async () => {
    const { app, deps, writes } = await passwordFixture()
    const before = (await deps.credentials.current())!.passwordChangedAt

    const res = await app.request(changeRequest({
      currentPassword: 'current-password',
      newPassword: 'brand-new-password',
      confirmNewPassword: 'brand-new-password',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toBe(`${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)

    expect(writes).toHaveLength(1)
    expect(await createScryptHasher().verify('brand-new-password', writes[0]!)).toBe(true)
    expect((await deps.credentials.current())!.passwordChangedAt).not.toBe(before)
  })

  it('当前密码错：400「当前密码不正确」，凭据不被改写', async () => {
    const { app, writes } = await passwordFixture()
    const res = await app.request(changeRequest({
      currentPassword: 'wrong-password',
      newPassword: 'brand-new-password',
      confirmNewPassword: 'brand-new-password',
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '当前密码不正确' })
    expect(writes).toHaveLength(0)
  })

  it('两次不一致：400「两次输入的密码不一致」，凭据不被改写', async () => {
    const { app, writes } = await passwordFixture()
    const res = await app.request(changeRequest({
      currentPassword: 'current-password',
      newPassword: 'brand-new-password',
      confirmNewPassword: 'different-password',
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '两次输入的密码不一致' })
    expect(writes).toHaveLength(0)
  })

  it('新密码不足 8 位：400「密码至少需要 8 位」，凭据不被改写', async () => {
    const { app, writes } = await passwordFixture()
    const res = await app.request(changeRequest({
      currentPassword: 'current-password',
      newPassword: 'short',
      confirmNewPassword: 'short',
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '密码至少需要 8 位' })
    expect(writes).toHaveLength(0)
  })

  it('请求体形状不合法（缺字段、类型错、空串、超 256）：400「请求体不合法」，凭据不被改写', async () => {
    const { app, writes } = await passwordFixture()
    for (const body of [
      {},
      { newPassword: 'brand-new-password', confirmNewPassword: 'brand-new-password' },
      { currentPassword: '', newPassword: 'brand-new-password', confirmNewPassword: 'brand-new-password' },
      { currentPassword: 'current-password', newPassword: '', confirmNewPassword: 'brand-new-password' },
      { currentPassword: 'current-password', newPassword: 'brand-new-password', confirmNewPassword: 'brand-new-password'.repeat(20) },
      { currentPassword: 1, newPassword: 'brand-new-password', confirmNewPassword: 'brand-new-password' },
      ['current-password'],
    ]) {
      const res = await app.request(changeRequest(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: '请求体不合法' })
    }
    expect(writes).toHaveLength(0)
  })

  it('Content-Type 不是 JSON：415（readJsonBody 双拦语义保留）', async () => {
    const { app } = await passwordFixture()
    const res = await app.request(new Request('http://localhost:5173/password', {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN, 'content-type': 'text/plain' },
      body: 'currentPassword=a',
    }))
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('凭据不可用（文件缺失/损坏）：400「面板凭据不可用，无法修改密码」', async () => {
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore(),
      sessions: createMemorySessionStore(),
      hasher: createScryptHasher(),
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const res = await app.request(changeRequest({
      currentPassword: 'whatever',
      newPassword: 'brand-new-password',
      confirmNewPassword: 'brand-new-password',
    }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '面板凭据不可用，无法修改密码' })
  })

  it('写盘 IO 故障：500 服务端错误而非 400（fs 原文不伪装成校验文案）', async () => {
    const hasher = createScryptHasher()
    const credentials: CredentialsStore = {
      current: async () => ({ username: 'admin', passwordHash: await hasher.hash('current-password'), passwordChangedAt: EPOCH }),
      write: async () => {
        throw new Error("EACCES: permission denied, open '/root/.Elysian/config/panel-credentials.json.tmp'")
      },
    }
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials,
      sessions: createMemorySessionStore(),
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const loginRes = await login(app, { username: 'admin', password: 'current-password' })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

    const res = await app.request('http://localhost:5173/password', {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN, 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        currentPassword: 'current-password',
        newPassword: 'brand-new-password',
        confirmNewPassword: 'brand-new-password',
      }),
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "EACCES: permission denied, open '/root/.Elysian/config/panel-credentials.json.tmp'",
    })
  })
})

describe('GET /api/auth/sessions', () => {
  it('回 ISO 三字段行、按最近活跃倒序、恰一行 current:true；JSON 不含 id/pwdEpoch，带 Cache-Control no-store', async () => {
    let now = 1_760_000_000_000
    const sessions = createMemorySessionStore({ now: () => now })
    await sessions.create(EPOCH) // oldest：随后过期
    now += 60_000
    await sessions.create(EPOCH) // middle：仍有效、非当前
    // oldest 距上次使用已超 12h，middle 还差半分钟未超时。
    now += SESSION_IDLE_TTL_MS - 30_000
    const current = await sessions.create(EPOCH)

    const hasher = createScryptHasher()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('p'), passwordChangedAt: EPOCH }),
      sessions,
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const res = await app.request('http://localhost:5173/sessions', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${current.id}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json() as { sessions: Array<Record<string, unknown>> }
    // 过期会话不出现：只剩 current 与 middle 两行。
    expect(body.sessions).toHaveLength(2)
    for (const row of body.sessions) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'current', 'lastUsedAt'])
      expect(Number.isNaN(Date.parse(row['createdAt'] as string))).toBe(false)
      expect(Number.isNaN(Date.parse(row['lastUsedAt'] as string))).toBe(false)
    }
    expect(JSON.stringify(body)).not.toContain('pwdEpoch')

    // 恰一行 current:true 且排最前（最近活跃倒序）。
    expect(body.sessions.map((row) => row['current'])).toEqual([true, false])
    const lastUsedAt = body.sessions.map((row) => Date.parse(row['lastUsedAt'] as string))
    expect(lastUsedAt[0]!).toBeGreaterThan(lastUsedAt[1]!)
    // 倒序首行的 lastUsedAt 就是当前会话的滑动时刻（可控时钟的 now）。
    expect(lastUsedAt[0]).toBe(now)
  })
})

describe('POST /api/auth/sessions/logout-others', () => {
  it('销毁除当前会话外的全部会话并 200 { ok: true }；随后 GET /sessions 只剩当前行（current:true）', async () => {
    const hasher = createScryptHasher()
    const sessions = createMemorySessionStore()
    const deps: AuthAppDeps = {
      enabled: true,
      devAccount: false,
      credentials: createMemoryCredentialsStore({ username: 'admin', passwordHash: await hasher.hash('p'), passwordChangedAt: EPOCH }),
      sessions,
      hasher,
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)
    const first = await sessions.create(EPOCH)
    const second = await sessions.create(EPOCH)
    const third = await sessions.create(EPOCH)

    // 无请求体：与 logout 同形态。
    const res = await app.request('http://localhost:5173/sessions/logout-others', {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${second.id}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await expect(deps.sessions.validate(first.id, EPOCH)).resolves.toBeNull()
    await expect(deps.sessions.validate(second.id, EPOCH)).resolves.not.toBeNull()
    await expect(deps.sessions.validate(third.id, EPOCH)).resolves.toBeNull()

    const list = await app.request('http://localhost:5173/sessions', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${second.id}` },
    })
    const body = await list.json() as { sessions: Array<{ current: boolean }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]!.current).toBe(true)
  })
})

describe('设置端点在 enabled: false 时', () => {
  it('三端点均 503 且文案逐字「鉴权未启用，会话管理不可用」，不写任何文件', async () => {
    const dir = join(tmpdir(), `elysian-auth-settings-off-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    settingsTempDir = dir
    const deps: AuthAppDeps = {
      enabled: false,
      devAccount: false,
      credentials: createFileCredentialsStore(join(dir, 'config', 'panel-credentials.json')),
      sessions: createFileSessionStore(join(dir, 'state', 'panel-sessions.json')),
      hasher: createScryptHasher(),
      returnOrigins: createMemoryReturnOriginRegistry(),
    }
    const app = createAuthApp(deps)

    const change = await app.request(changeRequest({ currentPassword: 'a', newPassword: 'b', confirmNewPassword: 'c' }))
    expect(change.status).toBe(503)
    expect(await change.json()).toEqual(AUTH_DISABLED_MESSAGE)

    const list = await app.request('http://localhost:5173/sessions')
    expect(list.status).toBe(503)
    expect(await list.json()).toEqual(AUTH_DISABLED_MESSAGE)

    const others = await app.request('http://localhost:5173/sessions/logout-others', {
      method: 'POST',
      headers: { host: 'localhost:5173', origin: ORIGIN },
    })
    expect(others.status).toBe(503)
    expect(await others.json()).toEqual(AUTH_DISABLED_MESSAGE)

    expect(existsSync(join(dir, 'config', 'panel-credentials.json'))).toBe(false)
    expect(existsSync(join(dir, 'state', 'panel-sessions.json'))).toBe(false)
  })
})

describe('未知端点', () => {
  it('404 文案与各片同构', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(`http://localhost:5173/nowhere`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知鉴权端点：GET /nowhere' })
  })
})

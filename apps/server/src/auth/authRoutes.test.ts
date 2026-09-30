import { describe, expect, it } from 'vitest'
import { createAuthApp, type AuthAppDeps } from './authRoutes.ts'
import { DUMMY_HASH, SESSION_COOKIE_NAME } from './authConfig.ts'
import { createMemoryCredentialsStore } from './credentialsStore.ts'
import { createMemorySessionStore } from './sessionStore.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'

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

describe('未知端点', () => {
  it('404 文案与各片同构', async () => {
    const f = fixture()
    const app = createAuthApp(f.deps)
    const res = await app.request(`http://localhost:5173/nowhere`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知鉴权端点：GET /nowhere' })
  })
})

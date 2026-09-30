import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { endpointErrorHandler, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { AUTH_MOUNT } from '../shared/apiMounts.ts'
import {
  DEFAULT_LOGIN_RATE_LIMIT,
  DEFAULT_LOGIN_RATE_WINDOW_MS,
  DEV_ACCOUNT_PASSWORD,
  DEV_ACCOUNT_USERNAME,
  DUMMY_HASH,
  LOGIN_FIELD_MAX_LENGTH,
  PANEL_USERNAME,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  isCookieSecureEnabled,
  isDevAccountEnabled,
} from './authConfig.ts'
import { createFileCredentialsStore, type CredentialsStore } from './credentialsStore.ts'
import { createFileSessionStore, type SessionStore } from './sessionStore.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'
import { currentPwdEpoch, parseSessionCookie } from './authMiddleware.ts'

/*
 * 登录鉴权片（/api/auth/*）：POST /login、POST /logout、GET /session。
 * 自带 sameOriginGuard（写端点同源校验；GET /session 按既有 GET 豁免语义放行）与
 * endpointErrorHandler，与各片同构。登录限流 5 次/60 秒固定窗口（照
 * platformDependencies 先例：计数挂在 app 工厂闭包内、每实例独立、每次登录尝试都
 * 计数——成功也计，单用户一分钟五次对人类充裕）。
 *
 * 时序纪律：用户名不匹配（或凭据不可用）时先对固定哑哈希 DUMMY_HASH 跑一次
 * hasher.verify 再回 401——否则用户名错短路 scrypt，回包虽同文但时序可区分用户名
 * 命中。用户名错与密码错的回包逐字相同：401 { error: '用户名或密码错误' }。
 * dev 账号命中后同样补跑一次哑哈希校验，让每条失败/成功路径都恰好付出一次派生成本。
 */

export type AuthAppDeps = {
  /** false 时整片退化为「无鉴权」演示语义：/session 恒答 authenticated:true、/login 恒成功。 */
  enabled: boolean
  /** 开发固定账号开关（ELYSIAN_AUTH_DEV=1）。 */
  devAccount: boolean
  credentials: CredentialsStore
  sessions: SessionStore
  hasher: PasswordHasher
  /** 登录限流（次/窗口），缺省 5；测试注入小值。 */
  loginRateLimit?: number
  /** 限流窗口毫秒，缺省 60_000；测试注入小值。 */
  loginRateWindowMs?: number
}

/** 缺省装配：enabled 缺省真、devAccount 读环境开关、两个真实文件版 store（惰性 IO）、scrypt hasher。 */
export function resolveAuthDeps(partial: Partial<AuthAppDeps> = {}): AuthAppDeps {
  return {
    enabled: partial.enabled ?? true,
    devAccount: partial.devAccount ?? isDevAccountEnabled(),
    credentials: partial.credentials ?? createFileCredentialsStore(),
    sessions: partial.sessions ?? createFileSessionStore(),
    hasher: partial.hasher ?? createScryptHasher(),
    loginRateLimit: partial.loginRateLimit,
    loginRateWindowMs: partial.loginRateWindowMs,
  }
}

/** 恒定时间字符串比较：比对 sha256 摘要（等长），内容差异不产生时间信号。 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestOf = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  const first = digestOf(a)
  const second = digestOf(b)
  return first.length === second.length && timingSafeEqual(first, second)
}

/** 会话 Cookie 串：登录下发与登出清共用同一形状（Max-Age 0 即清除）。 */
function sessionCookie(value: string, maxAgeSeconds: number): string {
  const secure = isCookieSecureEnabled() ? '; Secure' : ''
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const response = sendJson(status, body)
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}

/** 登录请求体的形状校验：{ username, password }，两者非空字符串且 ≤ 256 字符。
 * Content-Type 与体积双拦由 readJsonBody 完成（415/413 原样抛给 onError），这里只管形状。 */
async function readLoginBody(raw: Request): Promise<{ username: string; password: string } | null> {
  const parsed: unknown = await readJsonBody(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const username = (parsed as Record<string, unknown>)['username']
  const password = (parsed as Record<string, unknown>)['password']
  if (typeof username !== 'string' || typeof password !== 'string') return null
  if (username.length === 0 || password.length === 0) return null
  if (username.length > LOGIN_FIELD_MAX_LENGTH || password.length > LOGIN_FIELD_MAX_LENGTH) return null
  return { username, password }
}

export function createAuthApp(deps: AuthAppDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)
  app.use('*', sameOriginGuard())

  const limit = deps.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT
  const windowMs = deps.loginRateWindowMs ?? DEFAULT_LOGIN_RATE_WINDOW_MS
  // 限流状态在 app 实例闭包内：每个 createAuthApp 独立计数（照 platformDependencies 先例）。
  let windowStartAt = Date.now()
  let served = 0

  app.post('/login', async (c) => {
    if (!deps.enabled) return jsonResponse(200, { ok: true })

    const now = Date.now()
    if (now - windowStartAt >= windowMs) {
      windowStartAt = now
      served = 0
    }
    if (served >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStartAt + windowMs - now) / 1000))
      return jsonResponse(429, { error: '登录尝试过于频繁，请稍后再试' }, { 'retry-after': String(retryAfterSeconds) })
    }
    // 每次登录尝试都计数（成功也计；体不合法也计）。
    served += 1

    const body = await readLoginBody(c.req.raw)
    if (body === null) return jsonResponse(400, { error: '请求体不合法' })

    const credentials = await deps.credentials.current()
    let authenticated = false
    if (
      deps.devAccount &&
      constantTimeEquals(body.username, DEV_ACCOUNT_USERNAME) &&
      constantTimeEquals(body.password, DEV_ACCOUNT_PASSWORD)
    ) {
      // dev 账号命中：补跑一次哑哈希校验，时序形状与 admin 路径一致。
      await deps.hasher.verify(body.password, DUMMY_HASH)
      authenticated = true
    } else if (credentials !== null && constantTimeEquals(body.username, PANEL_USERNAME)) {
      authenticated = await deps.hasher.verify(body.password, credentials.passwordHash)
    } else {
      // 用户名不匹配或凭据不可用：仍跑一次哑哈希校验，消除「用户名命中与否」的时序差异。
      await deps.hasher.verify(body.password, DUMMY_HASH)
    }
    if (!authenticated) return jsonResponse(401, { error: '用户名或密码错误' })

    const pwdEpoch = credentials?.passwordChangedAt ?? 'none'
    const session = await deps.sessions.create(pwdEpoch)
    return jsonResponse(200, { ok: true }, { 'set-cookie': sessionCookie(session.id, SESSION_COOKIE_MAX_AGE) })
  })

  app.post('/logout', async (c) => {
    // 幂等：鉴权豁免清单内，无有效会话同样可达；无论如何清浏览器侧 Cookie。
    if (deps.enabled) {
      const sessionId = parseSessionCookie(c.req.header('cookie'))
      if (sessionId !== null) await deps.sessions.destroy(sessionId)
    }
    return jsonResponse(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
  })

  app.get('/session', async (c) => {
    if (!deps.enabled) return jsonResponse(200, { authenticated: true, devAccount: deps.devAccount }, { 'cache-control': 'no-store' })
    const sessionId = parseSessionCookie(c.req.header('cookie'))
    const authenticated = sessionId === null
      ? false
      : (await deps.sessions.validate(sessionId, await currentPwdEpoch(deps.credentials))) !== null
    return jsonResponse(200, { authenticated, devAccount: deps.devAccount }, { 'cache-control': 'no-store' })
  })

  // 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与各片格式逐字一致
  //（独立 request 驱动时路径本就不带前缀，照 logsRoutes 的 relativePath 处理）。
  app.all('*', (c) => {
    const path = c.req.path.startsWith(AUTH_MOUNT) ? c.req.path.slice(AUTH_MOUNT.length) : c.req.path
    return sendJson(404, { error: `未知鉴权端点：${c.req.method} ${path || '/'}` })
  })
  return app
}

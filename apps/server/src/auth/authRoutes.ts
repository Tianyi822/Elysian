import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { endpointErrorHandler, invalidRequest, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
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
  SSO_ORIGINS_UNAVAILABLE,
  isCookieSecureEnabled,
  isDevAccountEnabled,
} from './authConfig.ts'
import { createFileCredentialsStore, type CredentialsStore } from './credentialsStore.ts'
import { createFileSessionStore, type SessionStore } from './sessionStore.ts'
import { changePanelPassword } from './passwordChange.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'
import { adjudicateReturnTo } from './returnTo.ts'
import { createFileReturnOriginRegistry, type ReturnOriginRegistry } from './returnOriginRegistry.ts'
import { errorReason } from '../shared/errorReason.ts'
import { currentPwdEpoch, parseSessionCookie } from './authMiddleware.ts'
import type { SessionConnections } from './sessionConnections.ts'

/*
 * 登录鉴权片（/api/auth/*）：POST /login、POST /logout、GET /session，以及设置页的
 * POST /password、GET /sessions、POST /sessions/logout-others。
 * 自带 sameOriginGuard（写端点同源校验；GET 按既有 GET 豁免语义放行）与
 * endpointErrorHandler，与各片同构。登录限流 5 次/60 秒固定窗口（照
 * platformDependencies 先例：计数挂在 app 工厂闭包内、每实例独立、每次登录尝试都
 * 计数——成功也计，单用户一分钟五次对人类充裕）。
 *
 * 时序纪律：用户名不匹配（或凭据不可用）时先对固定哑哈希 DUMMY_HASH 跑一次
 * hasher.verify 再回 401——否则用户名错短路 scrypt，回包虽同文但时序可区分用户名
 * 命中。用户名错与密码错的回包逐字相同：401 { error: '用户名或密码错误' }。
 * dev 账号命中后同样补跑一次哑哈希校验，让每条失败/成功路径都恰好付出一次派生成本。
 *
 * 设置端点（须有效会话，requireSession 已挡在片外）：改密核心复用 passwordChange.ts
 * 的纯函数，校验失败一律 400 中文 InvalidRequestError；成功不显式删会话——新
 * passwordChangedAt 即新 epoch，全部既有会话在下一次 validate 时被惰性删除，当前
 * 浏览器由 Set-Cookie Max-Age=0 收尾。会话列表只回创建时间/最近活跃/当前标记三字段：
 * 会话 id 是不透明凭据不下发浏览器，服务端记录里也没有设备信息可回。
 */

export type AuthAppDeps = {
  /** false 时整片退化为「无鉴权」演示语义：/session 恒答 authenticated:true、/login 恒成功。 */
  enabled: boolean
  /** 开发固定账号开关（ELYSIAN_AUTH_DEV=1）。 */
  devAccount: boolean
  credentials: CredentialsStore
  sessions: SessionStore
  hasher: PasswordHasher
  /** 回跳白名单：只服务 GET /session 的 returnTo 裁决，不参与任何鉴权判定。 */
  returnOrigins: ReturnOriginRegistry
  /** 登录限流（次/窗口），缺省 5；测试注入小值。 */
  loginRateLimit?: number
  /** 限流窗口毫秒，缺省 60_000；测试注入小值。 */
  loginRateWindowMs?: number
  /**
   * 会话连接撤销表（可选）：登出/改密/退出其他会话三条显式失效路径在销毁服务端
   * 会话的同时关闭该会话名下已建立的终端连接。app.ts 把同一实例穿给 auth 片与
   * terminals 片；不传即无撤销（独立驱动本片的既有测试零改动）。
   */
  sessionConnections?: SessionConnections
}

/** 缺省装配：enabled 缺省真、devAccount 读环境开关、两个真实文件版 store（惰性 IO）、scrypt hasher。 */
export function resolveAuthDeps(partial: Partial<AuthAppDeps> = {}): AuthAppDeps {
  return {
    enabled: partial.enabled ?? true,
    devAccount: partial.devAccount ?? isDevAccountEnabled(),
    credentials: partial.credentials ?? createFileCredentialsStore(),
    sessions: partial.sessions ?? createFileSessionStore(),
    hasher: partial.hasher ?? createScryptHasher(),
    returnOrigins: partial.returnOrigins ?? createFileReturnOriginRegistry(),
    loginRateLimit: partial.loginRateLimit,
    loginRateWindowMs: partial.loginRateWindowMs,
    sessionConnections: partial.sessionConnections,
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

/** 鉴权未启用（enabled:false 演示语义）时设置端点的统一 503 文案：不读写任何凭据与会话文件。 */
const AUTH_DISABLED_MESSAGE = '鉴权未启用，会话管理不可用'

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

/** 改密请求体的形状校验：{ currentPassword, newPassword, confirmNewPassword }，三者非空字符串且 ≤ 256 字符。 */
async function readPasswordChangeBody(
  raw: Request,
): Promise<{ currentPassword: string; newPassword: string; confirmNewPassword: string } | null> {
  const parsed: unknown = await readJsonBody(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const isField = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= LOGIN_FIELD_MAX_LENGTH
  if (!isField(record['currentPassword']) || !isField(record['newPassword']) || !isField(record['confirmNewPassword'])) {
    return null
  }
  return {
    currentPassword: record['currentPassword'],
    newPassword: record['newPassword'],
    confirmNewPassword: record['confirmNewPassword'],
  }
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
      if (sessionId !== null) {
        await deps.sessions.destroy(sessionId)
        // 会话销毁即撤销：该会话名下已建立的终端连接一并关闭，不等到自然断开。
        deps.sessionConnections?.revoke(sessionId)
      }
    }
    return jsonResponse(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
  })

  app.get('/session', async (c) => {
    // 演示语义：恒已登录，且不回答回跳——面板本身没有鉴权时充当跳转器毫无意义。
    if (!deps.enabled) {
      return jsonResponse(200, { authenticated: true, devAccount: deps.devAccount }, { 'cache-control': 'no-store' })
    }
    const sessionId = parseSessionCookie(c.req.header('cookie'))
    const authenticated = sessionId === null
      ? false
      : (await deps.sessions.validate(sessionId, await currentPwdEpoch(deps.credentials))) !== null
    const requestedReturnTo = c.req.query('returnTo')
    // 不带 returnTo 参数时响应形状与既往逐字相同：面板前端探测与外部消费方共用本端点，形状不无谓扩张。
    if (requestedReturnTo === undefined) {
      return jsonResponse(200, { authenticated, devAccount: deps.devAccount }, { 'cache-control': 'no-store' })
    }
    // 白名单读取自身故障按空表处理：回跳关掉了，但登录与探测照常。
    // 退化不静默：读不到名单又永不跳转恰是最难自查的故障，先落一行与 registry 同前缀的
    // 中文诊断（带 errno code 或 message）再回空表；响应形状与状态码不受任何影响。
    const allowed = await deps.returnOrigins.list().catch((error: unknown) => {
      console.error(`${SSO_ORIGINS_UNAVAILABLE}：会话探测按空表回跳（${errorReason(error)}）`)
      return [] as readonly string[]
    })
    return jsonResponse(
      200,
      { authenticated, devAccount: deps.devAccount, returnTo: adjudicateReturnTo(requestedReturnTo, allowed) },
      { 'cache-control': 'no-store' },
    )
  })

  // —— 设置页端点（requireSession 覆盖之下，豁免清单不含任何一条）——

  app.post('/password', async (c) => {
    // 先于 readJsonBody：演示语义下写凭据文件会凭空造出真凭据，也不读体。
    if (!deps.enabled) return jsonResponse(503, { error: AUTH_DISABLED_MESSAGE })
    const body = await readPasswordChangeBody(c.req.raw)
    if (body === null) throw invalidRequest('请求体不合法')

    const credentials = await deps.credentials.current()
    // 无用户名分支：错误路径成本恒定为一次 verify（登录片的哑哈希纪律只针对用户名命中时序）。
    if (credentials === null) throw invalidRequest('面板凭据不可用，无法修改密码')
    if (!(await deps.hasher.verify(body.currentPassword, credentials.passwordHash))) {
      throw invalidRequest('当前密码不正确')
    }

    // 纯函数内部完成校验（两次一致、≥8 位）、scrypt 哈希与 credentials.write 原子落盘。
    // 错误按类型分流：校验失败抛 InvalidRequestError(400) 原文经 endpointErrorHandler 映射
    // 400；hash 与写盘的 IO 故障是普通 Error，同样上抛但落 500 分支——服务端故障不得
    // 伪装成客户端 400，也避免把 fs 错误原文（英文 + 绝对路径）按校验文案回给浏览器。
    await changePanelPassword(deps, body.newPassword, body.confirmNewPassword)

    // 会话失效不靠显式删除：新 passwordChangedAt 即新 epoch，全部既有会话在下一次
    // validate 时被删除；这里只给当前浏览器清 Cookie 作 UX 收尾。
    // 连接层不等 epoch 惰性失效：改密成功立即关闭全部会话名下已建立的终端连接。
    deps.sessionConnections?.revokeAll()
    return jsonResponse(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
  })

  app.get('/sessions', async (c) => {
    if (!deps.enabled) return jsonResponse(503, { error: AUTH_DISABLED_MESSAGE })
    const currentId = parseSessionCookie(c.req.header('cookie'))
    const sessions = await deps.sessions.list()
    // 三字段投影：id 是 bearer 凭据不下发，epoch 是内部失效基准无呈现价值；按最近活跃倒序。
    const rows = [...sessions]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((session) => ({
        createdAt: new Date(session.createdAt).toISOString(),
        lastUsedAt: new Date(session.lastUsedAt).toISOString(),
        current: session.id === currentId,
      }))
    return jsonResponse(200, { sessions: rows }, { 'cache-control': 'no-store' })
  })

  app.post('/sessions/logout-others', async (c) => {
    if (!deps.enabled) return jsonResponse(503, { error: AUTH_DISABLED_MESSAGE })
    const currentId = parseSessionCookie(c.req.header('cookie'))
    // requireSession 刚校验过当前会话，currentId 必非 null；null 只出现在绕过中间件
    // 直驱本片的场景，无从判定保留谁，按不动任何会话收尾（不放大故障半径）。
    if (currentId !== null) {
      await deps.sessions.destroyOthers(currentId)
      // 其他会话名下已建立的终端连接一并关闭，保留当前会话的连接。
      deps.sessionConnections?.revokeOthers(currentId)
    }
    return jsonResponse(200, { ok: true })
  })

  // 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与各片格式逐字一致
  //（独立 request 驱动时路径本就不带前缀，照 logsRoutes 的 relativePath 处理）。
  app.all('*', (c) => {
    const path = c.req.path.startsWith(AUTH_MOUNT) ? c.req.path.slice(AUTH_MOUNT.length) : c.req.path
    return sendJson(404, { error: `未知鉴权端点：${c.req.method} ${path || '/'}` })
  })
  return app
}

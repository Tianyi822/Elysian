import type { MiddlewareHandler } from 'hono'
import { sendJson } from '../middleware/guard.ts'
import { AUTH_EXEMPT_PATHS, SESSION_COOKIE_NAME } from './authConfig.ts'
import type { CredentialsStore } from './credentialsStore.ts'
import type { SessionStore } from './sessionStore.ts'

/*
 * 鉴权中间件：app.ts 以 `app.use('/api/*', requireSession(auth))` 挂在
 * createOperationAudit 之后、全部片路由之前——中间件先于路由 handler 执行，因此
 * 三个 WS 升级端点与 SSE /api/docker/events 在升级/开流之前就先过鉴权；401 以普通
 * Response 短路返回，恰好避开「拒绝 Response 写进升级回调会被吞」的坑。各升级端点
 * 既有的 isSameOriginUpgrade 前置校验原样保留，作为第二道防线。
 *
 * 豁免判定：先剥**单个**尾部斜杠再精确匹配（strict:false 下 `POST /api/auth/login/`
 * 与无尾斜杠形都命中登录路由，豁免不剥尾斜杠会自相矛盾）。豁免之外读写全挡。
 *
 * 请求经手次序：401（鉴权）→ 503（各片可用性）→ 403（同源）→ 端点 → 404。鉴权先于
 * 可用性是显式决定：不向未登录方暴露各片可用性事实。
 */

export type SessionAuth = {
  enabled: boolean
  sessions: SessionStore
  credentials: CredentialsStore
}

/**
 * 解析 Cookie 头里的会话 id：按 `;` 分段、去首空格后找 `elysian_session=` 前缀，
 * 不引任何依赖。无 Cookie 头（Hono 取不到时是 undefined）或没有该键回 null。
 *
 * 取**最后一个**匹配而非首条：浏览器回送同名 Cookie 时按 path 长度降序排列，
 * 更深层 Path 植入的条目排在前、面板自身 Path=/ 的 Cookie 恒排同名最后（HttpOnly
 * 拦截同 name+domain+path 的 JS 覆写，攻击者拿不到排位更后的条目）。取末个匹配
 * 即天然免疫更深层 Path 的植入 Cookie 遮蔽面板真会话；末条命中为空串仍回 null。
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (cookieHeader === null || cookieHeader === undefined) return null
  let matched: string | null = null
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const value = trimmed.slice(SESSION_COOKIE_NAME.length + 1)
      matched = value === '' ? null : value
    }
  }
  return matched
}

/** 豁免判定：剥单个尾斜杠后精确匹配四条豁免路径。 */
export function isAuthExemptPath(path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  return (AUTH_EXEMPT_PATHS as readonly string[]).includes(normalized)
}

/** 当前凭据的会话失效 epoch：凭据不可用（文件缺失/损坏）时取哨兵 'none'。 */
export async function currentPwdEpoch(credentials: CredentialsStore): Promise<string> {
  return (await credentials.current())?.passwordChangedAt ?? 'none'
}

/** 401 响应：统一中文文案，不进路由 handler。 */
export function unauthorizedResponse(): Response {
  return sendJson(401, { error: '未登录或会话已过期' })
}

export function requireSession(auth: SessionAuth): MiddlewareHandler {
  return async (c, next) => {
    // enabled === false：既有测试与无鉴权演示语义，直接放行（中间件与登录片短路）。
    if (!auth.enabled) {
      await next()
      return
    }
    if (isAuthExemptPath(c.req.path)) {
      await next()
      return
    }
    const sessionId = parseSessionCookie(c.req.header('cookie'))
    if (sessionId === null) return unauthorizedResponse()
    const epoch = await currentPwdEpoch(auth.credentials)
    const session = await auth.sessions.validate(sessionId, epoch)
    if (session === null) return unauthorizedResponse()
    // 会话身份不注入路由上下文：单用户，没有任何端点需要区分身份。
    await next()
  }
}

import { withRequestDeadline } from './requestDeadline'
import type { PanelPasswordChangeInput, SessionAdapter, SessionListRow, SessionStatus } from '../../contracts/adapters'
import { reportUnauthorized } from './unauthorized'

/*
 * Docker 运行时的会话 adapter（/api/auth）。登录/登出/探测三个端点全部用本文件私有
 * fetch，不经共享 401 拦截（unauthorized.ts）：它们的 401 是业务结果（登录失败、
 * 探测出未登录），上报反而会把用户从登录页再踢一次。
 *
 * 设置页三方法（listSessions/changePassword/logoutOtherSessions）不同：它们是登录后
 * 的管理端点，401 不是业务结果而是会话失效，故经 reportUnauthorized 上报后抛
 * 「登录状态已失效，请重新登录」，走全局统一的「清会话 → 跳 /login」路径。
 * Cookie 由浏览器自动携带（Path=/、同源），这里不读也不写任何凭据。
 */

/**
 * returnTo 的良构校验：字符串形态的回跳值必须能解析为绝对 http/https URL，否则视为响应形状漂移。
 * 只查线格式、不重新裁决——不读白名单、不比 origin、不复制服务端规则；这一层拦的是版本错配
 * （新前端配旧容器）下的畸形值，避免 LoginPage 渲染期 new URL(adjudicated) 抛错整页白屏。
 */
function isWellFormedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 校验 GET /session 响应：authenticated 与 devAccount 都必须是布尔；returnTo 只接受 null 或良构的绝对 http/https URL 字符串。形状漂移抛中文错误。 */
export function parseSessionStatus(body: unknown): SessionStatus {
  if (!body || typeof body !== 'object') throw new Error('登录状态响应无效')
  const row = body as Record<string, unknown>
  if (typeof row.authenticated !== 'boolean' || typeof row.devAccount !== 'boolean') {
    throw new Error('登录状态响应无效')
  }
  const returnTo = row['returnTo']
  // undefined（缺键，未回答）与 null（被拦截）都是合法线格式；字符串必须是绝对 http/https URL，
  // 数字/数组/非 URL 串/其它 scheme 一律抛错——probe 会把它吸收成 phase: 'error'。
  if (returnTo !== undefined && returnTo !== null) {
    if (typeof returnTo !== 'string' || !isWellFormedHttpUrl(returnTo)) {
      throw new Error('登录状态响应无效')
    }
  }
  const status: SessionStatus = { mode: 'real', authenticated: row.authenticated, devAccount: row.devAccount }
  // 缺键时不写该字段：undefined 与「服务端回答被拦截」的 null 是两件事。
  if (returnTo !== undefined) status.returnTo = returnTo
  return status
}

/** 校验 GET /sessions 响应：外层 sessions 数组、每行 createdAt/lastUsedAt 字符串与 current 布尔，漂移抛中文错误。 */
export function parseSessionList(body: unknown): readonly SessionListRow[] {
  const sessions = body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['sessions'])
    ? ((body as Record<string, unknown>)['sessions'] as unknown[])
    : null
  if (sessions === null) throw new Error('会话列表响应无效')
  const rows: SessionListRow[] = []
  for (const item of sessions) {
    if (!item || typeof item !== 'object') throw new Error('会话列表响应无效')
    const row = item as Record<string, unknown>
    if (typeof row.createdAt !== 'string' || typeof row.lastUsedAt !== 'string' || typeof row.current !== 'boolean') {
      throw new Error('会话列表响应无效')
    }
    rows.push({ createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, current: row.current })
  }
  return rows
}

async function readErrorDetail(response: Response): Promise<string | null> {
  return response
    .json()
    .then((body) =>
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : null,
    )
    .catch(() => null)
}

export function createHttpSessionAdapter(baseUrl = '/api/auth'): SessionAdapter {
  const status: SessionAdapter['status'] = (returnTo, options) => withRequestDeadline(undefined, async (init) => {
    // 编码交给 URLSearchParams：冒号与斜杠一律转义，回跳地址不破坏查询串结构。
    const params = new URLSearchParams()
    if (returnTo !== undefined && returnTo !== '') params.set('returnTo', returnTo)
    if (options?.passive) params.set('passive', '1')
    const query = params.size === 0 ? '' : `?${params.toString()}`
    let response: Response
    try {
      response = await fetch(`${baseUrl}/session${query}`, { ...init, cache: 'no-store' })
    } catch {
      throw new Error('登录状态检查失败：面板服务不可达')
    }
    if (!response.ok) {
      throw new Error(`登录状态检查失败：HTTP ${response.status}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('登录状态响应不是有效 JSON')
    }
    return parseSessionStatus(body)
  })

  return {
    /** 页面级权限占位：真实会话已通过即放行（单用户面板，粒度见 contracts/adapters.ts）。 */
    canView: async () => (await status()).authenticated,

    status,

    login(username, password) {
      return withRequestDeadline({ method: 'POST' }, async (bounded) => {
        const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: bounded.signal })
        let response: Response
        try {
          response = await timedFetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password }),
          })
        } catch {
          throw new Error('登录请求失败：面板服务不可达')
        }
        if (!response.ok) {
          // 透传服务端中文文案（「用户名或密码错误」「登录尝试过于频繁，请稍后再试」等）。
          const detail = await readErrorDetail(response)
          throw new Error(detail ?? `登录失败：HTTP ${response.status}`)
        }
      })
    },

    logout() {
      return withRequestDeadline({ method: 'POST' }, async (bounded) => {
        const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: bounded.signal })
        let response: Response
        try {
          response = await timedFetch(`${baseUrl}/logout`, { method: 'POST' })
        } catch {
          throw new Error('退出登录失败：面板服务不可达')
        }
        if (!response.ok) {
          throw new Error(`退出登录失败：HTTP ${response.status}`)
        }
      })
    },

    listSessions() {
      return withRequestDeadline(undefined, async (bounded) => {
        const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: bounded.signal })
        let response: Response
        try {
          response = await timedFetch(`${baseUrl}/sessions`, { cache: 'no-store' })
        } catch {
          throw new Error('会话列表获取失败：面板服务不可达')
        }
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        if (!response.ok) {
          const detail = await readErrorDetail(response)
          throw new Error(detail ?? `会话列表获取失败：HTTP ${response.status}`)
        }
        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new Error('会话列表响应不是有效 JSON')
        }
        return parseSessionList(body)
      })
    },

    changePassword(input: PanelPasswordChangeInput) {
      return withRequestDeadline({ method: 'POST' }, async (bounded) => {
        const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: bounded.signal })
        let response: Response
        try {
          response = await timedFetch(`${baseUrl}/password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              currentPassword: input.currentPassword,
              newPassword: input.newPassword,
              confirmNewPassword: input.confirmNewPassword,
            }),
          })
        } catch {
          throw new Error('修改密码失败：面板服务不可达')
        }
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        if (!response.ok) {
          // 透传服务端中文文案（「当前密码不正确」「两次输入的密码不一致」「密码至少需要 8 位」等）。
          const detail = await readErrorDetail(response)
          throw new Error(detail ?? `修改密码失败：HTTP ${response.status}`)
        }
      })
    },

    logoutOtherSessions() {
      return withRequestDeadline({ method: 'POST' }, async (bounded) => {
        const timedFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: bounded.signal })
        let response: Response
        try {
          // 无请求体（与 logout 同形态）。
          response = await timedFetch(`${baseUrl}/sessions/logout-others`, { method: 'POST' })
        } catch {
          throw new Error('退出其他会话失败：面板服务不可达')
        }
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        if (!response.ok) {
          const detail = await readErrorDetail(response)
          throw new Error(detail ?? `退出其他会话失败：HTTP ${response.status}`)
        }
      })
    },
  }
}

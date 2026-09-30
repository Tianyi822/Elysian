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

/** 校验 GET /session 响应：authenticated 与 devAccount 都必须是布尔，形状漂移抛中文错误。 */
export function parseSessionStatus(body: unknown): SessionStatus {
  if (!body || typeof body !== 'object') throw new Error('登录状态响应无效')
  const row = body as Record<string, unknown>
  if (typeof row.authenticated !== 'boolean' || typeof row.devAccount !== 'boolean') {
    throw new Error('登录状态响应无效')
  }
  return { mode: 'real', authenticated: row.authenticated, devAccount: row.devAccount }
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
  const status = async (): Promise<SessionStatus> => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/session`, { cache: 'no-store' })
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
  }

  return {
    /** 页面级权限占位：真实会话已通过即放行（单用户面板，粒度见 contracts/adapters.ts）。 */
    canView: async () => (await status()).authenticated,

    status,

    async login(username, password) {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/login`, {
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
    },

    async logout() {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/logout`, { method: 'POST' })
      } catch {
        throw new Error('退出登录失败：面板服务不可达')
      }
      if (!response.ok) {
        throw new Error(`退出登录失败：HTTP ${response.status}`)
      }
    },

    async listSessions() {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/sessions`, { cache: 'no-store' })
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
    },

    async changePassword(input: PanelPasswordChangeInput) {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/password`, {
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
    },

    async logoutOtherSessions() {
      let response: Response
      try {
        // 无请求体（与 logout 同形态）。
        response = await fetch(`${baseUrl}/sessions/logout-others`, { method: 'POST' })
      } catch {
        throw new Error('退出其他会话失败：面板服务不可达')
      }
      if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        throw new Error(detail ?? `退出其他会话失败：HTTP ${response.status}`)
      }
    },
  }
}

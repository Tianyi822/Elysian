import type { SessionAdapter, SessionStatus } from '../../contracts/adapters'

/*
 * Docker 运行时的会话 adapter（/api/auth）。三个端点全部用本文件私有 fetch，
 * 不经共享 401 拦截（unauthorized.ts）：登录/登出/探测自身的 401 是业务结果，
 * 上报反而会把用户从登录页再踢一次。Cookie 由浏览器自动携带（Path=/、同源），
 * 这里不读也不写任何凭据。
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
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOST_USER_LOGIN_METHODS, HOST_USER_STATUSES, type HostUserLoginMethod, type HostUserStatus } from '@elysian/contracts'
import type { UserAdapter } from '../../contracts/adapters'
import { EndpointGuardError, isSameOrigin, readJsonBody, sendError, sendJson } from '../endpointGuard/guard'

/*
 * 用户管理真实端点：/api/security/users/*（dev/preview 的 Node 中间件，仅容器内可用）。
 * 创建、修改、删除与系统同步都走真实 useradd/usermod/userdel/gpasswd/chpasswd；
 * 非 Docker 环境浏览器侧走内存 mock，端点本身不挂载。handler 依赖全部注入，
 * 测试用 fake service 驱动，不执行任何真实命令。
 */

export type UsersApiDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 api.node 的 /.dockerenv 校验）。 */
  available: boolean
  service?: UserAdapter
}

export function createUsersApiHandler(deps: UsersApiDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, deps).catch((error: unknown) => {
      // handler 同步交给 connect，异步错误自己兜底成 500。
      sendError(res, 500, error)
    })
  }
}

/** 请求体形状校验：loginMethod 与 status 限契约枚举，note 限 string|null。 */
function parseUserInput(row: Record<string, unknown>): { loginMethod: HostUserLoginMethod; status: HostUserStatus; isAdmin: boolean; note: string | null; password?: string | null } {
  const { loginMethod, status, isAdmin, note, password } = row
  if (typeof loginMethod !== 'string' || !HOST_USER_LOGIN_METHODS.includes(loginMethod as HostUserLoginMethod)) {
    throw new Error(`无效的登录方式：${String(loginMethod)}`)
  }
  if (typeof status !== 'string' || !HOST_USER_STATUSES.includes(status as HostUserStatus)) {
    throw new Error(`无效的账号状态：${String(status)}`)
  }
  if (typeof isAdmin !== 'boolean') throw new Error('管理员归属需为布尔值')
  if (note !== null && typeof note !== 'string') throw new Error('备注需为字符串或 null')
  if (password !== undefined && password !== null && typeof password !== 'string') {
    throw new Error('密码需为字符串')
  }
  return {
    loginMethod: loginMethod as HostUserLoginMethod,
    status: status as HostUserStatus,
    isAdmin,
    note,
    ...(password === undefined ? {} : { password }),
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: UsersApiDeps): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0] ?? '/'

  if (!deps.available || !deps.service) {
    sendJson(res, 503, { error: '真实用户管理仅在 Docker 容器内可用' })
    return
  }
  const service = deps.service

  // 同源守卫先于读体：跨源写请求在解析任何请求体之前就被拒绝。
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: '请求来源不允许' })
    return
  }

  try {
    if (method === 'GET' && (path === '/' || path === '')) {
      sendJson(res, 200, { users: await service.list() })
      return
    }

    if (method === 'POST' && (path === '/' || path === '')) {
      const body = await readJsonBody(req)
      const row = body as Record<string, unknown>
      if (typeof row.name !== 'string' || !row.name) throw new Error('用户名请求体无效')
      sendJson(res, 200, { user: await service.create({ name: row.name, ...parseUserInput(row) }) })
      return
    }

    const userMatch = /^\/([^/]+)$/.exec(path)
    if (userMatch && method === 'PUT') {
      const body = await readJsonBody(req)
      sendJson(res, 200, { user: await service.update(decodeURIComponent(userMatch[1] ?? ''), parseUserInput(body as Record<string, unknown>)) })
      return
    }

    if (userMatch && method === 'DELETE') {
      await service.remove(decodeURIComponent(userMatch[1] ?? ''))
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && path === '/sync') {
      sendJson(res, 200, await service.syncFromSystem())
      return
    }

    sendJson(res, 404, { error: `未知用户管理端点：${method} ${path}` })
  } catch (error) {
    // 业务性失败（弱密码、保护边界、账号不存在）带中文消息返回给界面呈现；守卫错误按自带状态码返回。
    sendError(res, error instanceof EndpointGuardError ? error.status : 500, error)
  }
}

import { Hono } from 'hono'
import {
  HOST_USER_LOGIN_METHODS,
  HOST_USER_STATUSES,
  type HostUserLoginMethod,
  type HostUserStatus,
  type UserAdapter,
} from '@elysian/contracts'
import { endpointErrorHandler, invalidRequest, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { USERS_MOUNT } from '../shared/apiMounts.ts'

/*
 * 用户管理路由（/api/security/users/*）：只做路由分发、守卫调用、请求体解析与 service
 * 调用，业务校验留在服务层。创建、修改、删除与系统同步都走真实 useradd/usermod/
 * userdel/gpasswd/chpasswd（经 usersHostDeps 注入）；服务用 fake 注入驱动路由测试，
 * 不执行任何真实命令。守卫链顺序有既定契约：不可用整片 503「真实用户管理仅在
 * Docker 容器内可用」→ 同源 403「请求来源不允许」→ 读体（415/413/400）→ 端点 →
 * 未知路径 404「未知用户管理端点：METHOD path」。
 */

/** 挂载路径：定义在 shared/apiMounts.ts，此处 re-export 保持既有 import 路径。 */
export { USERS_MOUNT }

/** 路由装配入参：available=false 时整片 503；service 缺失同样 503（有可用性没服务也不许答）。 */
export type UsersAppDeps = {
  available: boolean
  service?: UserAdapter
}

/** 请求体形状校验：loginMethod 与 status 限契约枚举，note 限 string|null。 */
function parseUserInput(row: Record<string, unknown>): {
  loginMethod: HostUserLoginMethod
  status: HostUserStatus
  isAdmin: boolean
  note: string | null
  password?: string | null
} {
  const { loginMethod, status, isAdmin, note, password } = row
  if (typeof loginMethod !== 'string' || !HOST_USER_LOGIN_METHODS.includes(loginMethod as HostUserLoginMethod)) {
    throw invalidRequest(`无效的登录方式：${String(loginMethod)}`)
  }
  if (typeof status !== 'string' || !HOST_USER_STATUSES.includes(status as HostUserStatus)) {
    throw invalidRequest(`无效的账号状态：${String(status)}`)
  }
  if (typeof isAdmin !== 'boolean') throw invalidRequest('管理员归属需为布尔值')
  if (note !== null && typeof note !== 'string') throw invalidRequest('备注需为字符串或 null')
  if (password !== undefined && password !== null && typeof password !== 'string') {
    throw invalidRequest('密码需为字符串')
  }
  return {
    loginMethod: loginMethod as HostUserLoginMethod,
    status: status as HostUserStatus,
    isAdmin,
    note,
    ...(password === undefined ? {} : { password }),
  }
}

/** 用户管理子应用工厂：app.ts 挂到 USERS_MOUNT；测试直接 request 驱动。 */
export function createUsersApp(deps: UsersAppDeps): Hono {
  const app = new Hono()
  // 错误映射：EndpointGuardError/InvalidRequestError 按自带 status 回 4xx，系统侧一律 500。
  app.onError(endpointErrorHandler)

  if (!deps.available || !deps.service) {
    // 不可用整片换 503 分支：任意方法、含未知路径，与容器外的强制保护一致。
    app.all('*', () => sendJson(503, { error: '真实用户管理仅在 Docker 容器内可用' }))
    return app
  }
  const service = deps.service

  // 同源守卫先于读体与路由分发：跨源写请求在解析任何请求体之前就被拒绝（未知路径同样先 403 后 404）。
  app.use('*', sameOriginGuard())

  app.get('/', async () => sendJson(200, { users: await service.list() }))

  app.post('/', async (c) => {
    const row = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    if (typeof row.name !== 'string' || !row.name) throw invalidRequest('用户名请求体无效')
    return sendJson(200, { user: await service.create({ name: row.name, ...parseUserInput(row) }) })
  })

  app.put('/:id', async (c) => {
    // 路径参数已由路由层完成 URL 解码，与原中间件的 decodeURIComponent 语义一致。
    const body = await readJsonBody(c.req.raw)
    return sendJson(200, { user: await service.update(c.req.param('id'), parseUserInput(body as Record<string, unknown>)) })
  })

  app.delete('/:id', async (c) => {
    await service.remove(c.req.param('id'))
    return sendJson(200, { ok: true })
  })

  app.post('/sync', async () => sendJson(200, await service.syncFromSystem()))

  // 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与端点时代的文案逐字一致。
  app.all('*', (c) => {
    const path = c.req.path.slice(USERS_MOUNT.length) || '/'
    return sendJson(404, { error: `未知用户管理端点：${c.req.method} ${path}` })
  })
  return app
}

import { Hono } from 'hono'
import { SSH_ROOT_LOGIN_POLICIES, type SshRootLoginPolicy, type SshAdapter } from '@elysian/contracts'
import { endpointErrorHandler, invalidRequest, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import type { SshListKeysReport } from './sshService.ts'

/*
 * SSH 真实端点：/api/security/ssh/*（Hono 子应用，仅容器内可用）。
 * 服务启停、sshd_config 补丁、Root 密码、Root 密钥与登录密钥都走真实 sshd/ssh-keygen/chpasswd；
 * 非 Docker 环境浏览器侧走内存 mock，装配层直接不挂真实服务。路由层薄：守卫调用、
 * 请求体读取与内联形状校验、service 透传；业务校验在服务层，测试用 fake service 驱动，
 * 不执行任何真实命令。
 */

/** 本片在主应用上的挂载前缀：404 文案里的路径剥离它，保持与子路径路由一致的相对写法。 */
export const SSH_MOUNT = '/api/security/ssh'

export type SshApiDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 sshHostDeps 的容器边界判定）。 */
  available: boolean
  /**
   * 面板服务：真实装配来自 createSshHostDeps，除 SshAdapter 契约外还附带密钥列表
   * 的脏行报告（ignoredInvalidLines 随 GET /keys 响应带出，界面暂不渲染）。
   */
  service?: SshAdapter & {
    listKeysWithReport(): Promise<SshListKeysReport>
  }
}

/** 不可用时整片换成的 503 应答：任意方法、任意子路径（含未知路径）都命中它。 */
function unavailableResponse(): Response {
  return sendJson(503, { error: '真实 SSH 管理仅在 Docker 容器内可用' })
}

/** 404 文案用的相对路径：子应用经 app.route 挂载后 c.req.path 是全路径，剥掉前缀逐字对齐。 */
function relativePath(fullPath: string): string {
  return (fullPath.startsWith(SSH_MOUNT) ? fullPath.slice(SSH_MOUNT.length) : fullPath) || '/'
}

export function createSshApp(deps: SshApiDeps): Hono {
  const app = new Hono()
  app.onError(endpointErrorHandler)

  if (!deps.available || !deps.service) {
    // 通配兜底而非 notFound：子应用经 app.route 挂载后 notFound 不随之迁移，
    // 通配路由随路由表复制，任意方法、任意子路径（含未知路径）都命中 503。
    app.all('*', () => unavailableResponse())
    return app
  }
  const service = deps.service

  // 同源守卫先于路由与读体：跨源写请求在解析任何请求体之前就被拒绝（GET/HEAD 放行）。
  app.use('*', sameOriginGuard())

  app.get('/overview', async () => sendJson(200, await service.overview()))
  app.get('/settings', async () => sendJson(200, await service.settings()))
  app.get('/root-auth', async () => sendJson(200, await service.rootAuth()))

  app.put('/service-enabled', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { enabled?: unknown }
    const enabled = body.enabled
    if (typeof enabled !== 'boolean') throw invalidRequest('开关值无效')
    return sendJson(200, await service.setServiceEnabled(enabled))
  })

  app.put('/auth-methods', async (c) => {
    const row = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    if (typeof row.passwordAuthEnabled !== 'boolean' || typeof row.keyAuthEnabled !== 'boolean') {
      throw invalidRequest('登录方式开关需为布尔值')
    }
    return sendJson(
      200,
      await service.setAuthMethods({
        passwordAuthEnabled: row.passwordAuthEnabled,
        keyAuthEnabled: row.keyAuthEnabled,
      }),
    )
  })

  app.put('/port', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { port?: unknown }
    const port = Number(body.port)
    if (!Number.isFinite(port)) throw invalidRequest('端口请求体无效')
    return sendJson(200, await service.setPort(port))
  })

  app.put('/root-login-policy', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { policy?: unknown }
    const policy = body.policy
    if (typeof policy !== 'string' || !SSH_ROOT_LOGIN_POLICIES.includes(policy as SshRootLoginPolicy)) {
      throw invalidRequest(`无效的 Root 登录策略：${String(policy)}`)
    }
    return sendJson(200, await service.saveRootLoginPolicy(policy as SshRootLoginPolicy))
  })

  app.post('/root-password', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { password?: unknown }
    const password = body.password
    if (typeof password !== 'string' || !password) throw invalidRequest('密码请求体无效')
    return sendJson(200, await service.resetRootPassword(password))
  })

  // 生成（或重新生成）Root 密钥：没有要校验的输入，读体只为走同一套守卫（同源、Content-Type、体积上限）。
  app.post('/root-key', async (c) => {
    await readJsonBody(c.req.raw)
    return sendJson(200, await service.createRootKey())
  })

  app.get('/keys', async () => {
    const report = await service.listKeysWithReport()
    return sendJson(200, { keys: report.keys, ignoredInvalidLines: report.ignoredInvalidLines })
  })

  app.get('/key-accounts', async () => sendJson(200, { accounts: await service.keyAccounts() }))

  app.post('/keys', async (c) => {
    const row = (await readJsonBody(c.req.raw)) as Record<string, unknown>
    if (typeof row.name !== 'string' || typeof row.userId !== 'string') {
      throw invalidRequest('密钥请求体无效')
    }
    return sendJson(200, { key: await service.createKey({ name: row.name, userId: row.userId }) })
  })

  app.delete('/keys/:id', async (c) => {
    await service.removeKey(c.req.param('id'))
    return sendJson(200, { ok: true })
  })

  app.get('/login-records', async () => sendJson(200, { records: await service.listLoginRecords() }))

  // 未知端点兜底：注册在具体路由之后，通配只在无具体匹配时命中；经 app.route 挂载后
  // 随路由表迁移（notFound 不会），404 文案与守卫链行为因此与独立挂载时一致。
  app.all('*', (c) => sendJson(404, { error: `未知 SSH 端点：${c.req.method} ${relativePath(c.req.path)}` }))
  return app
}

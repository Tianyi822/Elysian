import type { IncomingMessage, ServerResponse } from 'node:http'
import { SSH_ROOT_LOGIN_POLICIES, type SshRootLoginPolicy } from '@elysian/contracts'
import type { SshAdapter } from '../../contracts/adapters'
import { EndpointGuardError, isSameOrigin, readJsonBody, sendError, sendJson } from '../endpointGuard/guard'

/*
 * SSH 真实端点：/api/security/ssh/*（dev/preview 的 Node 中间件，仅容器内可用）。
 * 服务启停、sshd_config 补丁、Root 密码与登录密钥都走真实 sshd/ssh-keygen/chpasswd；
 * 非 Docker 环境浏览器侧走内存 mock，端点本身不挂载。handler 依赖全部注入，
 * 测试用 fake service 驱动，不执行任何真实命令。
 */

export type SshApiDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 api.node 的 /.dockerenv 校验）。 */
  available: boolean
  service?: SshAdapter
}

export function createSshApiHandler(deps: SshApiDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, deps).catch((error: unknown) => {
      // handler 同步交给 connect，异步错误自己兜底成 500。
      sendError(res, 500, error)
    })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: SshApiDeps): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0] ?? '/'

  if (!deps.available || !deps.service) {
    sendJson(res, 503, { error: '真实 SSH 管理仅在 Docker 容器内可用' })
    return
  }
  const service = deps.service

  // 同源守卫先于读体：跨源写请求在解析任何请求体之前就被拒绝。
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: '请求来源不允许' })
    return
  }

  try {
    if (method === 'GET' && path === '/overview') {
      sendJson(res, 200, await service.overview())
      return
    }

    if (method === 'GET' && path === '/settings') {
      sendJson(res, 200, await service.settings())
      return
    }

    if (method === 'GET' && path === '/root-auth') {
      sendJson(res, 200, await service.rootAuth())
      return
    }

    if (method === 'PUT' && path === '/service-enabled') {
      const body = await readJsonBody(req)
      const enabled = (body as { enabled?: unknown }).enabled
      if (typeof enabled !== 'boolean') throw new Error('开关值无效')
      sendJson(res, 200, await service.setServiceEnabled(enabled))
      return
    }

    if (method === 'PUT' && path === '/auth-methods') {
      const body = await readJsonBody(req)
      const row = body as Record<string, unknown>
      if (typeof row.passwordAuthEnabled !== 'boolean' || typeof row.keyAuthEnabled !== 'boolean') {
        throw new Error('登录方式开关需为布尔值')
      }
      sendJson(
        res,
        200,
        await service.setAuthMethods({
          passwordAuthEnabled: row.passwordAuthEnabled,
          keyAuthEnabled: row.keyAuthEnabled,
        }),
      )
      return
    }

    if (method === 'PUT' && path === '/port') {
      const body = await readJsonBody(req)
      const port = Number((body as { port?: unknown }).port)
      if (!Number.isFinite(port)) throw new Error('端口请求体无效')
      sendJson(res, 200, await service.setPort(port))
      return
    }

    if (method === 'PUT' && path === '/root-login-policy') {
      const body = await readJsonBody(req)
      const policy = (body as { policy?: unknown }).policy
      if (typeof policy !== 'string' || !SSH_ROOT_LOGIN_POLICIES.includes(policy as SshRootLoginPolicy)) {
        throw new Error(`无效的 Root 登录策略：${String(policy)}`)
      }
      sendJson(res, 200, await service.saveRootLoginPolicy(policy as SshRootLoginPolicy))
      return
    }

    if (method === 'POST' && path === '/root-password') {
      const body = await readJsonBody(req)
      const password = (body as { password?: unknown }).password
      if (typeof password !== 'string' || !password) throw new Error('密码请求体无效')
      sendJson(res, 200, await service.resetRootPassword(password))
      return
    }

    if (method === 'GET' && path === '/keys') {
      sendJson(res, 200, { keys: await service.listKeys() })
      return
    }

    if (method === 'GET' && path === '/key-accounts') {
      sendJson(res, 200, { accounts: await service.keyAccounts() })
      return
    }

    if (method === 'POST' && path === '/keys') {
      const body = await readJsonBody(req)
      const row = body as Record<string, unknown>
      if (typeof row.name !== 'string' || typeof row.userId !== 'string') {
        throw new Error('密钥请求体无效')
      }
      sendJson(res, 200, { key: await service.createKey({ name: row.name, userId: row.userId }) })
      return
    }

    const keyMatch = /^\/keys\/([^/]+)$/.exec(path)
    if (keyMatch && method === 'DELETE') {
      await service.removeKey(decodeURIComponent(keyMatch[1] ?? ''))
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'GET' && path === '/login-records') {
      sendJson(res, 200, { records: await service.listLoginRecords() })
      return
    }

    sendJson(res, 404, { error: `未知 SSH 端点：${method} ${path}` })
  } catch (error) {
    // 业务性失败（弱密码、预检回滚、账号不存在）带中文消息返回给界面呈现；守卫错误按自带状态码返回。
    sendError(res, error instanceof EndpointGuardError ? error.status : 500, error)
  }
}

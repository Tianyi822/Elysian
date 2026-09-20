import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  FirewallForwardInput,
  FirewallIpRuleInput,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallToggles,
} from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'
import { EndpointGuardError, isSameOrigin, readJsonBody, sendError, sendJson } from '../endpointGuard/guard'

/*
 * 防火墙真实端点：/api/security/firewall/*（dev/preview 的 Node 中间件，仅容器内可用）。
 * 端口规则、开关与防扫描都走真实 ufw/iptables service；非 Docker 环境浏览器侧走内存 mock，
 * 端点本身不挂载。handler 依赖全部注入，测试用 fake service 驱动，不执行任何真实命令。
 */

export type FirewallApiDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 api.node 的 /.dockerenv 校验）。 */
  available: boolean
  service?: FirewallAdapter
}

export function createFirewallApiHandler(deps: FirewallApiDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, deps).catch((error: unknown) => {
      // handler 同步交给 connect，异步错误自己兜底成 500。
      sendError(res, 500, error)
    })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: FirewallApiDeps): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0] ?? '/'

  if (!deps.available || !deps.service) {
    sendJson(res, 503, { error: '真实防火墙仅在 Docker 容器内可用' })
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
      const [toggles, rules] = await Promise.all([service.toggles(), service.list()])
      sendJson(res, 200, { toggles, rules })
      return
    }

    if (method === 'PUT' && path === '/toggles') {
      const body = await readJsonBody(req)
      const toggles = parseToggles(body)
      sendJson(res, 200, { toggles: await service.setToggles(toggles) })
      return
    }

    if (method === 'POST' && path === '/rules') {
      const input = parseRuleInput(await readJsonBody(req))
      sendJson(res, 200, { rule: await service.create(input) })
      return
    }

    const ruleMatch = /^\/rules\/([^/]+)$/.exec(path)
    if (ruleMatch) {
      const ruleId = decodeURIComponent(ruleMatch[1] ?? '')
      if (method === 'PUT') {
        const input = parseRuleInput(await readJsonBody(req))
        sendJson(res, 200, { rule: await service.update(ruleId, input) })
        return
      }
      if (method === 'DELETE') {
        await service.remove(ruleId)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    if (method === 'POST' && path === '/rules/import') {
      const body = await readJsonBody(req)
      const inputs = parseRuleInputList(body)
      sendJson(res, 200, await service.importRules(inputs))
      return
    }

    if (method === 'POST' && path === '/sync') {
      sendJson(res, 200, await service.syncFromSystem())
      return
    }

    // IP 规则（纯来源封禁）。
    if (method === 'GET' && path === '/ip-rules') {
      sendJson(res, 200, { rules: await service.listIpRules() })
      return
    }
    if (method === 'POST' && path === '/ip-rules') {
      const input = parseIpRuleInput(await readJsonBody(req))
      sendJson(res, 200, { rule: await service.createIpRule(input) })
      return
    }
    const ipRuleMatch = /^\/ip-rules\/([^/]+)$/.exec(path)
    if (ipRuleMatch) {
      const ruleId = decodeURIComponent(ipRuleMatch[1] ?? '')
      if (method === 'PUT') {
        const input = parseIpRuleInput(await readJsonBody(req))
        sendJson(res, 200, { rule: await service.updateIpRule(ruleId, input) })
        return
      }
      if (method === 'DELETE') {
        await service.removeIpRule(ruleId)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    // 端口转发（DNAT）。
    if (method === 'GET' && path === '/forwards') {
      sendJson(res, 200, { rules: await service.listForwards() })
      return
    }
    if (method === 'POST' && path === '/forwards') {
      const input = parseForwardInput(await readJsonBody(req))
      sendJson(res, 200, { rule: await service.createForward(input) })
      return
    }
    const forwardMatch = /^\/forwards\/([^/]+)$/.exec(path)
    if (forwardMatch) {
      const ruleId = decodeURIComponent(forwardMatch[1] ?? '')
      if (method === 'PUT') {
        const input = parseForwardInput(await readJsonBody(req))
        sendJson(res, 200, { rule: await service.updateForward(ruleId, input) })
        return
      }
      if (method === 'DELETE') {
        await service.removeForward(ruleId)
        sendJson(res, 200, { ok: true })
        return
      }
    }

    // 防扫描：与规则同源的真实实现（内核 xt_recent 双名单 jail + iptables 计数）。
    if (method === 'GET' && path === '/scan') {
      sendJson(res, 200, await service.scanProtection())
      return
    }
    if (method === 'POST' && path === '/scan/toggle') {
      const body = await readJsonBody(req)
      const enabled = (body as { enabled?: unknown }).enabled
      if (typeof enabled !== 'boolean') throw new Error('开关值无效')
      sendJson(res, 200, await service.setScanProtection(enabled))
      return
    }
    if (method === 'PUT' && path === '/scan/config') {
      sendJson(res, 200, await service.setScanConfig(parseScanConfigBody(await readJsonBody(req))))
      return
    }
    if (method === 'POST' && path === '/scan/unblock') {
      const body = await readJsonBody(req)
      const ip = (body as { ip?: unknown }).ip
      if (typeof ip !== 'string' || !ip.trim()) throw new Error('IP 无效')
      sendJson(res, 200, await service.unblockIp(ip.trim()))
      return
    }

    sendJson(res, 404, { error: `未知防火墙端点：${method} ${path}` })
  } catch (error) {
    // 业务性失败（重复规则、ufw 报错）带中文消息返回给界面呈现；守卫错误按自带状态码返回。
    sendError(res, error instanceof EndpointGuardError ? error.status : 500, error)
  }
}

function parseToggles(body: unknown): FirewallToggles {
  if (!body || typeof body !== 'object') throw new Error('开关请求体无效')
  const row = body as Record<string, unknown>
  if (typeof row.firewallEnabled !== 'boolean' || typeof row.pingBlocked !== 'boolean') {
    throw new Error('开关请求体缺少布尔字段')
  }
  // 默认策略是系统侧只读事实：请求里的取值不采信，service 回读真实状态。
  return {
    firewallEnabled: row.firewallEnabled,
    pingBlocked: row.pingBlocked,
    defaultIncoming: null,
    defaultOutgoing: null,
  }
}

/** 宽进：结构校验交给 service（specFromInput 的中文报错），这里只保证形状可传递。 */
function parseRuleInput(body: unknown): FirewallRuleInput {
  if (!body || typeof body !== 'object') throw new Error('规则请求体无效')
  const row = body as Record<string, unknown>
  return {
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    port: Number(row.port),
    portTo: row.portTo === undefined || row.portTo === null ? undefined : Number(row.portTo),
    family: row.family === 'ipv6' ? 'ipv6' : 'ipv4',
    policy: parsePolicy(row.policy),
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    source: typeof row.source === 'string' ? row.source : '',
    note: typeof row.note === 'string' ? row.note : null,
  }
}

function parsePolicy(value: unknown): 'allow' | 'deny' | 'limit' {
  return value === 'deny' ? 'deny' : value === 'limit' ? 'limit' : 'allow'
}

function parseIpRuleInput(body: unknown): FirewallIpRuleInput {
  if (!body || typeof body !== 'object') throw new Error('IP 规则请求体无效')
  const row = body as Record<string, unknown>
  return {
    policy: parsePolicy(row.policy),
    source: typeof row.source === 'string' ? row.source : '',
    note: typeof row.note === 'string' ? row.note : null,
  }
}

function parseForwardInput(body: unknown): FirewallForwardInput {
  if (!body || typeof body !== 'object') throw new Error('转发请求体无效')
  const row = body as Record<string, unknown>
  return {
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    port: Number(row.port),
    portTo: row.portTo === undefined || row.portTo === null ? undefined : Number(row.portTo),
    targetHost: typeof row.targetHost === 'string' ? row.targetHost : '',
    targetPort: Number(row.targetPort),
    note: typeof row.note === 'string' ? row.note : null,
  }
}

function parseScanConfigBody(body: unknown): FirewallScanConfig {
  if (!body || typeof body !== 'object') throw new Error('防扫描配置请求体无效')
  const row = body as Record<string, unknown>
  const ports = Array.isArray(row.ports) ? row.ports.map(Number) : []
  return {
    ports,
    windowSeconds: Number(row.windowSeconds),
    hitCount: Number(row.hitCount),
    banSeconds: Number(row.banSeconds),
  }
}

function parseRuleInputList(body: unknown): readonly FirewallRuleInput[] {
  if (!body || typeof body !== 'object') throw new Error('导入请求体无效')
  const rules = (body as { rules?: unknown }).rules
  if (!Array.isArray(rules)) throw new Error('导入请求体缺少规则数组')
  return rules.map(parseRuleInput)
}

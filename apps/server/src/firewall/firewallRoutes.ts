import { Hono } from 'hono'
import type {
  FirewallAdapter,
  FirewallForwardInput,
  FirewallIpRuleInput,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallToggles,
} from '@elysian/contracts'
import { invalidRequest, readJsonBody, sameOriginGuard, sendJson } from '../middleware/guard.ts'
import { FIREWALL_MOUNT } from '../shared/apiMounts.ts'
import type { FirewallHostDeps } from './firewallService.ts'

/*
 * 防火墙真实路由：/api/security/firewall/*（apps/server 的 Hono 子应用，仅容器内可用）。
 * 端口规则、开关与防扫描都走真实 ufw/iptables service；非 Docker 环境整片 503。
 * 路由层保持薄：只做分发、守卫调用、请求体解析与 service 调用，业务校验留在 service 层。
 * handler 依赖全部注入，测试用 fake service 经 app.request 驱动，不执行任何真实命令。
 */

/** 挂载前缀：定义在 shared/apiMounts.ts，此处 re-export 保持既有 import 路径。 */
export { FIREWALL_MOUNT }

export type FirewallAppDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 firewallHostDeps 的 /.dockerenv 校验）。 */
  available: boolean
  service?: FirewallAdapter
  /** 真实接线（可用时恒有）：装配层用它构造端口自动开放闭包注入其他域；测试注入 fake 时不带。 */
  hostDeps?: FirewallHostDeps
}

export function createFirewallApp(deps: FirewallAppDeps): Hono {
  const app = new Hono()

  if (!deps.available || !deps.service) {
    // 整片 503：任意方法、含未知路径，容器边界保护先于一切守卫。
    app.all('*', () => sendJson(503, { error: '真实防火墙仅在 Docker 容器内可用' }))
    return app
  }
  const service = deps.service

  // 同源守卫先于读体：跨源写请求在解析任何请求体之前就被拒绝（未知路径同样先过守卫）。
  app.use('*', sameOriginGuard())

  app.get('/', async () => {
    const [toggles, rules] = await Promise.all([service.toggles(), service.list()])
    return sendJson(200, { toggles, rules })
  })

  app.put('/toggles', async (c) => {
    const toggles = parseToggles(await readJsonBody(c.req.raw))
    return sendJson(200, { toggles: await service.setToggles(toggles) })
  })

  app.post('/rules', async (c) => {
    const input = parseRuleInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.create(input) })
  })

  app.put('/rules/:id', async (c) => {
    const input = parseRuleInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.update(c.req.param('id'), input) })
  })

  app.delete('/rules/:id', async (c) => {
    await service.remove(c.req.param('id'))
    return sendJson(200, { ok: true })
  })

  app.post('/rules/import', async (c) => {
    const inputs = parseRuleInputList(await readJsonBody(c.req.raw))
    return sendJson(200, await service.importRules(inputs))
  })

  app.post('/sync', async () => {
    return sendJson(200, await service.syncFromSystem())
  })

  // IP 规则（纯来源封禁）。
  app.get('/ip-rules', async () => {
    return sendJson(200, { rules: await service.listIpRules() })
  })
  app.post('/ip-rules', async (c) => {
    const input = parseIpRuleInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.createIpRule(input) })
  })
  app.put('/ip-rules/:id', async (c) => {
    const input = parseIpRuleInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.updateIpRule(c.req.param('id'), input) })
  })
  app.delete('/ip-rules/:id', async (c) => {
    await service.removeIpRule(c.req.param('id'))
    return sendJson(200, { ok: true })
  })

  // 端口转发（DNAT）。
  app.get('/forwards', async () => {
    return sendJson(200, { rules: await service.listForwards() })
  })
  app.post('/forwards', async (c) => {
    const input = parseForwardInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.createForward(input) })
  })
  app.put('/forwards/:id', async (c) => {
    const input = parseForwardInput(await readJsonBody(c.req.raw))
    return sendJson(200, { rule: await service.updateForward(c.req.param('id'), input) })
  })
  app.delete('/forwards/:id', async (c) => {
    await service.removeForward(c.req.param('id'))
    return sendJson(200, { ok: true })
  })

  // 防扫描：与规则同源的真实实现（内核 xt_recent 双名单 jail + iptables 计数）。
  app.get('/scan', async () => {
    return sendJson(200, await service.scanProtection())
  })
  app.post('/scan/toggle', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { enabled?: unknown }
    const enabled = body.enabled
    if (typeof enabled !== 'boolean') throw invalidRequest('开关值无效')
    return sendJson(200, await service.setScanProtection(enabled))
  })
  app.put('/scan/config', async (c) => {
    return sendJson(200, await service.setScanConfig(parseScanConfigBody(await readJsonBody(c.req.raw))))
  })
  app.post('/scan/unblock', async (c) => {
    const body = (await readJsonBody(c.req.raw)) as { ip?: unknown }
    const ip = body.ip
    if (typeof ip !== 'string' || !ip.trim()) throw invalidRequest('IP 无效')
    return sendJson(200, await service.unblockIp(ip.trim()))
  })

  // 未知端点兜底：挂载后 c.req.path 是含前缀的全路径，剥前缀后与
  // 「未知防火墙端点：METHOD path」逐字一致（path 为相对路径）。
  app.all('*', (c) => {
    const path = c.req.path.slice(FIREWALL_MOUNT.length) || '/'
    return sendJson(404, { error: `未知防火墙端点：${c.req.method} ${path}` })
  })

  return app
}

function parseToggles(body: unknown): FirewallToggles {
  if (!body || typeof body !== 'object') throw invalidRequest('开关请求体无效')
  const row = body as Record<string, unknown>
  if (typeof row.firewallEnabled !== 'boolean' || typeof row.pingBlocked !== 'boolean') {
    throw invalidRequest('开关请求体缺少布尔字段')
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
  if (!body || typeof body !== 'object') throw invalidRequest('规则请求体无效')
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
  if (!body || typeof body !== 'object') throw invalidRequest('IP 规则请求体无效')
  const row = body as Record<string, unknown>
  return {
    policy: parsePolicy(row.policy),
    source: typeof row.source === 'string' ? row.source : '',
    note: typeof row.note === 'string' ? row.note : null,
  }
}

function parseForwardInput(body: unknown): FirewallForwardInput {
  if (!body || typeof body !== 'object') throw invalidRequest('转发请求体无效')
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
  if (!body || typeof body !== 'object') throw invalidRequest('防扫描配置请求体无效')
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
  if (!body || typeof body !== 'object') throw invalidRequest('导入请求体无效')
  const rules = (body as { rules?: unknown }).rules
  if (!Array.isArray(rules)) throw invalidRequest('导入请求体缺少规则数组')
  return rules.map(parseRuleInput)
}

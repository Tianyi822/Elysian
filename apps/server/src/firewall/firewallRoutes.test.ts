import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { DEFAULT_SCAN_CONFIG } from '@elysian/contracts'
import type {
  FirewallAdapter,
  FirewallForwardRule,
  FirewallIpRule,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import { InvalidRequestError, endpointErrorHandler, invalidRequest } from '../middleware/guard.ts'
import { createFirewallApp, FIREWALL_MOUNT, type FirewallAppDeps } from './firewallRoutes.ts'
import { createFirewallService, type FirewallHostDeps } from './firewallService.ts'

/*
 * 防火墙路由的行为测试：挂载到与 app.ts 同构的父应用（strict:false + 统一错误映射），
 * 用 app.request(new Request(...)) 驱动；fake service 不执行任何真实命令。
 */

const SAMPLE_RULE: FirewallRule = {
  id: 'ufw-allow-in-tcp-8080-any.ipv4',
  protocol: 'tcp',
  port: 8080,
  portTo: null,
  family: 'ipv4',
  status: 'unused',
  policy: 'allow',
  direction: 'inbound',
  source: '所有IP',
  note: null,
  updatedAt: null,
}

const SAMPLE_IP_RULE: FirewallIpRule = {
  id: 'ufwip-deny-from-203.0.113.9.ipv4',
  source: '203.0.113.9',
  family: 'ipv4',
  policy: 'deny',
  note: null,
  updatedAt: null,
}

const SAMPLE_FORWARD: FirewallForwardRule = {
  id: 'fwd-tcp-8080-10.0.0.5-80',
  protocol: 'tcp',
  port: 8080,
  portTo: null,
  targetHost: '10.0.0.5',
  targetPort: 80,
  note: null,
  updatedAt: null,
}

const SAMPLE_TOGGLES: FirewallToggles = {
  firewallEnabled: false,
  pingBlocked: false,
  defaultIncoming: 'deny',
  defaultOutgoing: 'allow',
}

function scanFixture(enabled = true): FirewallScanProtection {
  return {
    enabled,
    config: { ...DEFAULT_SCAN_CONFIG, ports: [...DEFAULT_SCAN_CONFIG.ports] },
    stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
    blocked: [],
  }
}

function createFakeService(overrides: Partial<FirewallAdapter> = {}): FirewallAdapter {
  return {
    list: async () => [SAMPLE_RULE],
    toggles: async () => ({ ...SAMPLE_TOGGLES }),
    setToggles: async (toggles) => toggles,
    create: async () => SAMPLE_RULE,
    update: async () => SAMPLE_RULE,
    remove: async () => undefined,
    importRules: async () => ({ added: [SAMPLE_RULE], skipped: 0 }),
    listIpRules: async () => [SAMPLE_IP_RULE],
    createIpRule: async () => SAMPLE_IP_RULE,
    updateIpRule: async () => SAMPLE_IP_RULE,
    removeIpRule: async () => undefined,
    listForwards: async () => [SAMPLE_FORWARD],
    createForward: async () => SAMPLE_FORWARD,
    updateForward: async () => SAMPLE_FORWARD,
    removeForward: async () => undefined,
    scanProtection: async () => scanFixture(),
    setScanProtection: async (enabled) => scanFixture(enabled),
    setScanConfig: async (config) => ({ ...scanFixture(), config }),
    unblockIp: async () => scanFixture(),
    syncFromSystem: async () => ({ total: 2 }),
    ...overrides,
  }
}

/** 与 app.ts 同构的父应用：strict:false（尾斜杠适配）+ endpointErrorHandler 统一错误映射。 */
function mountApp(deps: FirewallAppDeps): Hono {
  const parent = new Hono({ strict: false })
  parent.onError(endpointErrorHandler)
  parent.route(FIREWALL_MOUNT, createFirewallApp(deps))
  return parent
}

const ORIGIN = 'http://localhost:5173'

/**
 * 构造发往挂载后端点的 Request：默认同源合法头（Origin 与 Host 一致）；
 * 带体请求显式声明 JSON 与真实长度，与浏览器 adapter 的真实请求形一致。
 */
function requestOf(
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${ORIGIN}${FIREWALL_MOUNT}${path}`, {
    method,
    headers: { host: 'localhost:5173', origin: ORIGIN, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })
}

function jsonRequest(method: string, path: string, body?: unknown): Request {
  const payload = JSON.stringify(body)
  return requestOf(method, path, {
    body: payload,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload, 'utf8')) },
  })
}

const AVAILABLE: FirewallAppDeps = { available: true, service: createFakeService() }

describe('createFirewallApp', () => {
  it('不可用时一律 503（容器边界保护，含未知路径）', async () => {
    const app = mountApp({ available: false })
    const root = await app.request(requestOf('GET', ''))
    expect(root.status).toBe(503)
    expect(await root.json()).toEqual({ error: '真实防火墙仅在 Docker 容器内可用' })

    const unknown = await app.request(requestOf('POST', '/nope/deeper', { body: '{}', headers: { 'content-type': 'application/json' } }))
    expect(unknown.status).toBe(503)
  })

  it('GET 挂载根（无尾斜杠形）返回开关（含默认策略）与规则全量', async () => {
    const res = await mountApp(AVAILABLE).request(requestOf('GET', ''))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      toggles: SAMPLE_TOGGLES,
      rules: [SAMPLE_RULE],
    })
  })

  it('PUT /toggles 传递开关值（默认策略由 service 回读）', async () => {
    const setToggles = async (toggles: FirewallToggles) => toggles
    const service = createFakeService({ setToggles })
    const app = mountApp({ available: true, service })

    const res = await app.request(jsonRequest('PUT', '/toggles', { firewallEnabled: true, pingBlocked: true }))
    expect(res.status).toBe(200)
    // 请求里带来的默认策略不采信：端点只转发两个布尔开关，策略留空由 service 回读真实态。
    expect(await res.json()).toEqual({
      toggles: { firewallEnabled: true, pingBlocked: true, defaultIncoming: null, defaultOutgoing: null },
    })
  })

  it('POST /rules 创建规则（端口段透传）', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      create: async (input) => {
        calls.push(input)
        return SAMPLE_RULE
      },
    })
    const app = mountApp({ available: true, service })

    const res = await app.request(
      jsonRequest('POST', '/rules', { protocol: 'tcp', port: 1000, portTo: 2000, policy: 'limit', source: '所有IP' }),
    )
    expect(res.status).toBe(200)
    expect(calls[0]).toMatchObject({ protocol: 'tcp', port: 1000, portTo: 2000, policy: 'limit', source: '所有IP' })
  })

  it('DELETE /rules/:id 解码规则标识', async () => {
    const removed: string[] = []
    const service = createFakeService({
      remove: async (ruleId) => {
        removed.push(ruleId)
      },
    })
    const app = mountApp({ available: true, service })

    const encoded = encodeURIComponent('ufw-allow-in-tcp-8080-any.ipv4')
    const res = await app.request(requestOf('DELETE', `/rules/${encoded}`))
    expect(res.status).toBe(200)
    expect(removed).toEqual(['ufw-allow-in-tcp-8080-any.ipv4'])
  })

  it('POST /rules/import 转发批量导入', async () => {
    const service = createFakeService()
    const app = mountApp({ available: true, service })

    const res = await app.request(jsonRequest('POST', '/rules/import', { rules: [{ protocol: 'tcp', port: 3306 }] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ added: [SAMPLE_RULE], skipped: 0 })
  })

  it('POST /sync 返回同步总数', async () => {
    const res = await mountApp(AVAILABLE).request(requestOf('POST', '/sync'))
    expect(await res.json()).toEqual({ total: 2 })
  })

  it('GET /scan 与 POST /scan/toggle 走真实 service', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      scanProtection: async () => {
        calls.push('read')
        return {
          ...scanFixture(),
          stats: { totalBlockedIps: 1, totalFailedConnections: 9, currentBlockedIps: 1, currentFailedConnections: 9 },
          blocked: [{ ip: '203.0.113.9', blockedAt: '2026-09-19T00:00:00.000Z' }],
        }
      },
      setScanProtection: async (enabled) => {
        calls.push(enabled)
        return scanFixture(enabled)
      },
    })
    const app = mountApp({ available: true, service })

    const read = await app.request(requestOf('GET', '/scan'))
    expect(read.status).toBe(200)
    expect(((await read.json()) as { stats: { totalBlockedIps: number } }).stats.totalBlockedIps).toBe(1)

    const toggled = await app.request(jsonRequest('POST', '/scan/toggle', { enabled: false }))
    expect(toggled.status).toBe(200)
    expect(((await toggled.json()) as { enabled: boolean }).enabled).toBe(false)
    expect(calls).toEqual(['read', false])
  })

  it('PUT /scan/config 传递防扫描配置', async () => {
    const configs: unknown[] = []
    const service = createFakeService({
      setScanConfig: async (config) => {
        configs.push(config)
        return { ...scanFixture(), config }
      },
    })
    const app = mountApp({ available: true, service })

    const res = await app.request(
      jsonRequest('PUT', '/scan/config', { ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 }),
    )
    expect(res.status).toBe(200)
    expect(configs[0]).toEqual({ ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
    expect(((await res.json()) as { config: { hitCount: number } }).config.hitCount).toBe(5)
  })

  it('IP 规则端点：列表、创建、修改、删除', async () => {
    const calls: string[] = []
    const service = createFakeService({
      listIpRules: async () => {
        calls.push('list')
        return [SAMPLE_IP_RULE]
      },
      createIpRule: async (input) => {
        calls.push(`create:${input.source}`)
        return SAMPLE_IP_RULE
      },
      updateIpRule: async (ruleId, input) => {
        calls.push(`update:${ruleId}:${input.policy}`)
        return SAMPLE_IP_RULE
      },
      removeIpRule: async (ruleId) => {
        calls.push(`remove:${ruleId}`)
      },
    })
    const app = mountApp({ available: true, service })

    const list = await app.request(requestOf('GET', '/ip-rules'))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ rules: [SAMPLE_IP_RULE] })

    await app.request(jsonRequest('POST', '/ip-rules', { policy: 'deny', source: '203.0.113.9' }))
    await app.request(
      jsonRequest('PUT', `/ip-rules/${encodeURIComponent(SAMPLE_IP_RULE.id)}`, { policy: 'allow', source: '203.0.113.9' }),
    )
    await app.request(requestOf('DELETE', `/ip-rules/${encodeURIComponent(SAMPLE_IP_RULE.id)}`))
    expect(calls).toEqual([
      'list',
      'create:203.0.113.9',
      `update:${SAMPLE_IP_RULE.id}:allow`,
      `remove:${SAMPLE_IP_RULE.id}`,
    ])
  })

  it('端口转发端点：列表、创建、修改、删除', async () => {
    const calls: string[] = []
    const service = createFakeService({
      listForwards: async () => {
        calls.push('list')
        return [SAMPLE_FORWARD]
      },
      createForward: async (input) => {
        calls.push(`create:${input.port}->${input.targetHost}:${input.targetPort}`)
        return SAMPLE_FORWARD
      },
      updateForward: async (ruleId) => {
        calls.push(`update:${ruleId}`)
        return SAMPLE_FORWARD
      },
      removeForward: async (ruleId) => {
        calls.push(`remove:${ruleId}`)
      },
    })
    const app = mountApp({ available: true, service })

    const list = await app.request(requestOf('GET', '/forwards'))
    expect(await list.json()).toEqual({ rules: [SAMPLE_FORWARD] })

    await app.request(
      jsonRequest('POST', '/forwards', { protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80 }),
    )
    await app.request(
      jsonRequest('PUT', `/forwards/${encodeURIComponent(SAMPLE_FORWARD.id)}`, {
        protocol: 'tcp',
        port: 8080,
        targetHost: '10.0.0.5',
        targetPort: 80,
      }),
    )
    await app.request(requestOf('DELETE', `/forwards/${encodeURIComponent(SAMPLE_FORWARD.id)}`))
    expect(calls).toEqual(['list', 'create:8080->10.0.0.5:80', `update:${SAMPLE_FORWARD.id}`, `remove:${SAMPLE_FORWARD.id}`])
  })

  it('请求被拒（校验不通过 / 前置状态不满足）按自带状态码返回 4xx，中文原因原样带回', async () => {
    const service = createFakeService({
      createForward: async () => {
        throw invalidRequest('面板端口不允许配置转发：外部端口段覆盖 5173（工作台自身的访问通道）')
      },
      setScanConfig: async () => {
        throw new InvalidRequestError(409, '防扫描未启用：先开启开关再调整配置')
      },
    })
    const app = mountApp({ available: true, service })

    const forward = await app.request(
      jsonRequest('POST', '/forwards', { protocol: 'tcp', port: 5173, targetHost: '10.0.0.5', targetPort: 8080 }),
    )
    expect(forward.status).toBe(400)
    expect(await forward.json()).toEqual({
      error: '面板端口不允许配置转发：外部端口段覆盖 5173（工作台自身的访问通道）',
    })

    const scan = await app.request(
      jsonRequest('PUT', '/scan/config', { ports: [22], windowSeconds: 60, hitCount: 8, banSeconds: 3600 }),
    )
    expect(scan.status).toBe(409)
    expect(await scan.json()).toEqual({ error: '防扫描未启用：先开启开关再调整配置' })
  })

  it('系统侧失败（ufw 执行失败等）仍以中文错误返回 500', async () => {
    const service = createFakeService({
      create: async () => {
        throw new Error('ufw 执行失败（allow 8080/tcp）：ERROR: problem running ufw init')
      },
    })
    const app = mountApp({ available: true, service })

    const res = await app.request(jsonRequest('POST', '/rules', { protocol: 'tcp', port: 8080, source: '所有IP' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'ufw 执行失败（allow 8080/tcp）：ERROR: problem running ufw init' })
  })

  it('未知端点返回 404，文案剥挂载前缀后与相对路径逐字一致', async () => {
    const res = await mountApp(AVAILABLE).request(requestOf('GET', '/nowhere'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知防火墙端点：GET /nowhere' })
  })

  it('请求体不是 JSON 返回 400 带中文错误', async () => {
    const res = await mountApp(AVAILABLE).request(
      requestOf('PUT', '/toggles', { body: 'not-json', headers: { 'content-type': 'application/json', 'content-length': '8' } }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('请求体不是有效 JSON')
  })

  it('规则输入缺形状时按缺省转发给 service 校验', async () => {
    const calls: FirewallRuleInput[] = []
    const service = createFakeService({
      create: async (input) => {
        calls.push(input)
        throw new Error('端口无效：NaN（应为 1–65535 的整数）')
      },
    })
    const app = mountApp({ available: true, service })

    await app.request(jsonRequest('POST', '/rules', {}))
    expect(calls[0]).toMatchObject({ protocol: 'tcp', source: '' })
  })

  it('跨源 PUT 在读体之前返回 403', async () => {
    const calls: unknown[] = []
    const service = createFakeService({
      setToggles: async (toggles) => {
        calls.push(toggles)
        return toggles
      },
    })
    const app = mountApp({ available: true, service })
    // 请求体故意不是合法 JSON：若守卫晚于读体，这里会变成 500 的解析错误而非 403。
    const res = await app.request(
      requestOf('PUT', '/toggles', {
        body: 'not-json',
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: '请求来源不允许' })
    expect(calls).toEqual([])
  })

  it('text/plain 的写请求返回 415', async () => {
    const res = await mountApp(AVAILABLE).request(
      requestOf('POST', '/rules', { body: '{}', headers: { 'content-type': 'text/plain' } }),
    )
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type 必须为 application/json' })
  })

  it('请求体超过 64 KiB 返回 413（申报与实读都拦）', async () => {
    const app = mountApp(AVAILABLE)

    // 申报即超限：不看流直接拒。
    const declared = await app.request(
      requestOf('POST', '/rules', {
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) },
      }),
    )
    expect(declared.status).toBe(413)

    // 谎报 content-length：实读累计字节数兜底。体本身是合法 JSON，只有体积守卫能拒。
    const oversized = `{"note":"${'a'.repeat(64 * 1024)}"}`
    const lied = await app.request(
      requestOf('POST', '/rules', {
        body: oversized,
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }),
    )
    expect(lied.status).toBe(413)
    expect(await lied.json()).toEqual({ error: '请求体过大' })
  })

  it('同源 application/json 写请求正常通过守卫', async () => {
    const app = mountApp(AVAILABLE)
    const ok = await app.request(jsonRequest('PUT', '/toggles', { firewallEnabled: true, pingBlocked: false }))
    expect(ok.status).toBe(200)

    // 大小写归一：Host 大小写不同仍视为同源；带 charset 的 Content-Type 前缀匹配放行。
    const relaxed = await app.request(
      requestOf('POST', '/scan/toggle', {
        body: '{"enabled":false}',
        headers: { host: 'LOCALHOST:5173', 'content-type': 'application/json; charset=utf-8' },
      }),
    )
    expect(relaxed.status).toBe(200)
  })
})

/*
 * 路由接真实 service（非替身）时的状态码回归：容器里被拒的请求必须是 4xx，
 * 而不是把「请求写错了」报成 500 服务端故障。deps 全部替身，不执行任何真实命令；
 * 这些拒绝都发生在读系统之前，替身实现只用于满足类型与记录「有没有被动过」。
 */
describe('createFirewallApp + 真实 service 的状态码', () => {
  const writes: string[] = []
  const deps: FirewallHostDeps = {
    runUfw: async (args) => {
      throw new Error(`测试里不应执行 ufw：${args.join(' ')}`)
    },
    runSs: async () => '',
    runIptables: async () => '',
    runIp6tables: async () => '',
    // 无防扫描段的普通规则文件：读状态据此回报「防扫描未启用」。
    readText: async () => '# before.rules\n*filter\n:ufw-before-input - [0:0]\nCOMMIT\n',
    writeText: async (path) => {
      writes.push(path)
    },
    exists: async () => false,
    nowIso: () => '2026-09-19T00:00:00.000Z',
  }
  const app = mountApp({ available: true, service: createFirewallService(deps) })

  it('POST /forwards 命中面板端口：400 + 中文原因，不落盘', async () => {
    writes.length = 0
    const res = await app.request(
      jsonRequest('POST', '/forwards', { protocol: 'tcp', port: 5173, targetHost: '10.0.0.5', targetPort: 8080 }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: '面板端口不允许配置转发：外部端口段覆盖 5173（工作台自身的访问通道）',
    })
    expect(writes).toEqual([])
  })

  it('POST /forwards 目标地址是网段：400 + 中文原因', async () => {
    writes.length = 0
    const res = await app.request(
      jsonRequest('POST', '/forwards', { protocol: 'tcp', port: 9090, targetHost: '10.0.0.0/24', targetPort: 8080 }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '目标地址无效：10.0.0.0/24（应为单个 IPv4 地址，不含网段）' })
    expect(writes).toEqual([])
  })

  it('PUT /scan/config 防扫描未启用：409（前置状态不满足，不是请求体错误）', async () => {
    const res = await app.request(
      jsonRequest('PUT', '/scan/config', { ports: [22], windowSeconds: 60, hitCount: 8, banSeconds: 3600 }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: '防扫描未启用：先开启开关再调整配置' })
  })

  it('PUT /scan/config 含面板端口：400，且校验先于开关状态（未启用也按面板端口拒绝）', async () => {
    writes.length = 0
    const res = await app.request(
      jsonRequest('PUT', '/scan/config', { ports: [22, 5173], windowSeconds: 60, hitCount: 8, banSeconds: 3600 }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '面板端口不允许加入防扫描监控：5173 是工作台自身的访问通道' })
    expect(writes).toEqual([])
  })
})

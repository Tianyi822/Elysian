import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { DEFAULT_SCAN_CONFIG } from '@elysian/contracts'
import { createFirewallApiHandler, type FirewallApiDeps } from './api'
import type { FirewallAdapter } from '../../contracts/adapters'
import type { FirewallForwardRule, FirewallIpRule, FirewallRule, FirewallRuleInput, FirewallScanProtection, FirewallToggles } from '@elysian/contracts'

/*
 * 防火墙端点 handler 的行为测试：fake service 不执行任何真实命令。
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

async function readResponse(handler: (req: IncomingMessage, res: ServerResponse) => void, req: IncomingMessage) {
  let statusCode = 0
  let body = ''
  const res = {
    writeHead(status: number) {
      statusCode = status
    },
    end(text?: string) {
      body = text ?? ''
    },
    setHeader() {},
  } as unknown as ServerResponse
  handler(req, res)
  // handler 内部异步：让微任务队列跑完再读响应。
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { statusCode, body: JSON.parse(body) as unknown }
}

async function fakeReq(method: string, url: string, body?: unknown): Promise<IncomingMessage> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  return Object.assign(stream, { method, url }) as unknown as IncomingMessage
}

const AVAILABLE: FirewallApiDeps = { available: true, service: createFakeService() }

describe('createFirewallApiHandler', () => {
  it('不可用时一律 503（容器边界保护）', async () => {
    const handler = createFirewallApiHandler({ available: false })
    const { statusCode, body } = await readResponse(handler, await fakeReq('GET', '/'))
    expect(statusCode).toBe(503)
    expect(body).toEqual({ error: '真实防火墙仅在 Docker 容器内可用' })
  })

  it('GET / 返回开关（含默认策略）与规则全量', async () => {
    const { statusCode, body } = await readResponse(
      createFirewallApiHandler(AVAILABLE),
      await fakeReq('GET', '/'),
    )
    expect(statusCode).toBe(200)
    expect(body).toEqual({
      toggles: SAMPLE_TOGGLES,
      rules: [SAMPLE_RULE],
    })
  })

  it('PUT /toggles 传递开关值（默认策略由 service 回读）', async () => {
    const setToggles = async (toggles: FirewallToggles) => toggles
    const service = createFakeService({ setToggles })
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('PUT', '/toggles', { firewallEnabled: true, pingBlocked: true }),
    )
    expect(statusCode).toBe(200)
    expect(body).toEqual({
      toggles: { firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' },
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
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode } = await readResponse(
      handler,
      await fakeReq('POST', '/rules', { protocol: 'tcp', port: 1000, portTo: 2000, policy: 'limit', source: '所有IP' }),
    )
    expect(statusCode).toBe(200)
    expect(calls[0]).toMatchObject({ protocol: 'tcp', port: 1000, portTo: 2000, policy: 'limit', source: '所有IP' })
  })

  it('DELETE /rules/:id 解码规则标识', async () => {
    const removed: string[] = []
    const service = createFakeService({
      remove: async (ruleId) => {
        removed.push(ruleId)
      },
    })
    const handler = createFirewallApiHandler({ available: true, service })

    const encoded = encodeURIComponent('ufw-allow-in-tcp-8080-any.ipv4')
    const { statusCode } = await readResponse(handler, await fakeReq('DELETE', `/rules/${encoded}`))
    expect(statusCode).toBe(200)
    expect(removed).toEqual(['ufw-allow-in-tcp-8080-any.ipv4'])
  })

  it('POST /rules/import 转发批量导入', async () => {
    const service = createFakeService()
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('POST', '/rules/import', { rules: [{ protocol: 'tcp', port: 3306 }] }),
    )
    expect(statusCode).toBe(200)
    expect(body).toEqual({ added: [SAMPLE_RULE], skipped: 0 })
  })

  it('POST /sync 返回同步总数', async () => {
    const { body } = await readResponse(createFirewallApiHandler(AVAILABLE), await fakeReq('POST', '/sync'))
    expect(body).toEqual({ total: 2 })
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
    const handler = createFirewallApiHandler({ available: true, service })

    const read = await readResponse(handler, await fakeReq('GET', '/scan'))
    expect(read.statusCode).toBe(200)
    expect((read.body as { stats: { totalBlockedIps: number } }).stats.totalBlockedIps).toBe(1)

    const toggled = await readResponse(handler, await fakeReq('POST', '/scan/toggle', { enabled: false }))
    expect(toggled.statusCode).toBe(200)
    expect((toggled.body as { enabled: boolean }).enabled).toBe(false)
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
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('PUT', '/scan/config', { ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 }),
    )
    expect(statusCode).toBe(200)
    expect(configs[0]).toEqual({ ports: [22, 8080], windowSeconds: 120, hitCount: 5, banSeconds: 1800 })
    expect((body as { config: { hitCount: number } }).config.hitCount).toBe(5)
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
    const handler = createFirewallApiHandler({ available: true, service })

    const list = await readResponse(handler, await fakeReq('GET', '/ip-rules'))
    expect(list.statusCode).toBe(200)
    expect(list.body).toEqual({ rules: [SAMPLE_IP_RULE] })

    await readResponse(handler, await fakeReq('POST', '/ip-rules', { policy: 'deny', source: '203.0.113.9' }))
    await readResponse(
      handler,
      await fakeReq('PUT', `/ip-rules/${encodeURIComponent(SAMPLE_IP_RULE.id)}`, { policy: 'allow', source: '203.0.113.9' }),
    )
    await readResponse(handler, await fakeReq('DELETE', `/ip-rules/${encodeURIComponent(SAMPLE_IP_RULE.id)}`))
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
    const handler = createFirewallApiHandler({ available: true, service })

    const list = await readResponse(handler, await fakeReq('GET', '/forwards'))
    expect(list.body).toEqual({ rules: [SAMPLE_FORWARD] })

    await readResponse(
      handler,
      await fakeReq('POST', '/forwards', { protocol: 'tcp', port: 8080, targetHost: '10.0.0.5', targetPort: 80 }),
    )
    await readResponse(
      handler,
      await fakeReq('PUT', `/forwards/${encodeURIComponent(SAMPLE_FORWARD.id)}`, {
        protocol: 'tcp',
        port: 8080,
        targetHost: '10.0.0.5',
        targetPort: 80,
      }),
    )
    await readResponse(handler, await fakeReq('DELETE', `/forwards/${encodeURIComponent(SAMPLE_FORWARD.id)}`))
    expect(calls).toEqual(['list', 'create:8080->10.0.0.5:80', `update:${SAMPLE_FORWARD.id}`, `remove:${SAMPLE_FORWARD.id}`])
  })

  it('业务失败以中文错误返回 500', async () => {
    const service = createFakeService({
      create: async () => {
        throw new Error('端口规则已存在：tcp 8080（ipv4）')
      },
    })
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('POST', '/rules', { protocol: 'tcp', port: 8080, source: '所有IP' }),
    )
    expect(statusCode).toBe(500)
    expect(body).toEqual({ error: '端口规则已存在：tcp 8080（ipv4）' })
  })

  it('未知端点返回 404', async () => {
    const { statusCode } = await readResponse(
      createFirewallApiHandler(AVAILABLE),
      await fakeReq('GET', '/nowhere'),
    )
    expect(statusCode).toBe(404)
  })

  it('请求体不是 JSON 返回 500 带中文错误', async () => {
    const handler = createFirewallApiHandler(AVAILABLE)
    const stream = Readable.from([Buffer.from('not-json', 'utf8')])
    const req = Object.assign(stream, { method: 'PUT', url: '/toggles' }) as unknown as IncomingMessage
    const { body } = await readResponse(handler, req)
    expect((body as { error: string }).error).toBe('请求体不是有效 JSON')
  })

  it('规则输入缺形状时按缺省转发给 service 校验', async () => {
    const calls: FirewallRuleInput[] = []
    const service = createFakeService({
      create: async (input) => {
        calls.push(input)
        throw new Error('端口无效：NaN（应为 1–65535 的整数）')
      },
    })
    const handler = createFirewallApiHandler({ available: true, service })

    await readResponse(handler, await fakeReq('POST', '/rules', {}))
    expect(calls[0]).toMatchObject({ protocol: 'tcp', source: '' })
  })
})

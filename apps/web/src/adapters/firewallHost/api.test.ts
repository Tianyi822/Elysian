import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createFirewallApiHandler, type FirewallApiDeps } from './api'
import type { FirewallAdapter } from '../../contracts/adapters'
import type { FirewallRule, FirewallRuleInput, FirewallToggles } from '@elysian/contracts'

/*
 * 防火墙端点 handler 的行为测试：fake service 不执行任何真实命令。
 */

const SAMPLE_RULE: FirewallRule = {
  id: 'ufw-allow-in-tcp-8080-any.ipv4',
  protocol: 'tcp',
  port: 8080,
  family: 'ipv4',
  status: 'unused',
  policy: 'allow',
  direction: 'inbound',
  source: '所有IP',
  note: null,
  updatedAt: null,
}

function createFakeService(overrides: Partial<FirewallAdapter> = {}): FirewallAdapter {
  return {
    list: async () => [SAMPLE_RULE],
    toggles: async () => ({ firewallEnabled: false, pingBlocked: false }),
    setToggles: async (toggles) => toggles,
    create: async () => SAMPLE_RULE,
    update: async () => SAMPLE_RULE,
    remove: async () => undefined,
    importRules: async () => ({ added: [SAMPLE_RULE], skipped: 0 }),
    scanProtection: async () => ({
      enabled: true,
      stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
      blocked: [],
    }),
    setScanProtection: async (enabled) => ({
      enabled,
      stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
      blocked: [],
    }),
    unblockIp: async () => ({
      enabled: true,
      stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
      blocked: [],
    }),
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

  it('GET / 返回开关与规则全量', async () => {
    const { statusCode, body } = await readResponse(
      createFirewallApiHandler(AVAILABLE),
      await fakeReq('GET', '/'),
    )
    expect(statusCode).toBe(200)
    expect(body).toEqual({
      toggles: { firewallEnabled: false, pingBlocked: false },
      rules: [SAMPLE_RULE],
    })
  })

  it('PUT /toggles 传递开关值', async () => {
    const setToggles = async (toggles: FirewallToggles) => toggles
    const service = createFakeService({ setToggles })
    const handler = createFirewallApiHandler({ available: true, service })

    const { statusCode, body } = await readResponse(
      handler,
      await fakeReq('PUT', '/toggles', { firewallEnabled: true, pingBlocked: true }),
    )
    expect(statusCode).toBe(200)
    expect(body).toEqual({ toggles: { firewallEnabled: true, pingBlocked: true } })
  })

  it('POST /rules 创建规则', async () => {
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
      await fakeReq('POST', '/rules', { protocol: 'tcp', port: 8080, source: '所有IP' }),
    )
    expect(statusCode).toBe(200)
    expect(calls[0]).toMatchObject({ protocol: 'tcp', port: 8080, source: '所有IP' })
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
          enabled: true,
          stats: { totalBlockedIps: 1, totalFailedConnections: 9, currentBlockedIps: 1, currentFailedConnections: 9 },
          blocked: [{ ip: '203.0.113.9', blockedAt: '2026-09-19T00:00:00.000Z' }],
        }
      },
      setScanProtection: async (enabled) => {
        calls.push(enabled)
        return {
          enabled,
          stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
          blocked: [],
        }
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

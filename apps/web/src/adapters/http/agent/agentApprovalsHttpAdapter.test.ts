import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApprovalsAdapter } from '../../../contracts/adapters'
import { AgentHttpError } from './agentShared'
import {
  assertReconciliationEvidenceBytes,
  assertRevokeReasonBytes,
  createHttpAgentApprovalsAdapter,
  parseAgentApproval,
  parseAgentOperation,
  parseAgentResourceLease,
} from './agentApprovalsHttpAdapter'
import {
  agentApprovalsDataApi,
  decideAgentApproval,
  AgentApprovalsDomainError,
  reconcileAgentBarrier,
  reconcileAgentLock,
  resetAgentApprovalsData,
  revokeAgentCapability,
  setAgentApprovalsQueueFull,
} from '../../mock/agent/agentApprovalsData'
import { runAgentApprovalsAdapterContract } from '../../agentApprovalsAdapterContract'

/*
 * 审批与治理域 HTTP 适配器接线断言：vi.stubGlobal('fetch') 挂一个「同源假服务」——
 * 行为与真实服务端同口径（请求体 DisallowUnknownFields、查询参数白名单、
 * /resource-locks 不收任何查询参数、领域错误映射 {error,code}+状态码），
 * 语义由 agentApprovalsData 状态机承担。断言请求必须落到精确路径与查询串，
 * 且无 requestId 端点的请求体不含该字段。
 */

const BASE = '2026-10-11T08:00:00.000Z'

type Route = {
  method: string
  pattern: RegExp
  allowedQuery: readonly string[]
  allowedBody: readonly string[] | null
  handle: (context: { id: string; query: URLSearchParams; body: Record<string, unknown> }) => unknown
}

const ROUTES: readonly Route[] = [
  {
    method: 'GET', pattern: /^\/api\/agent\/approvals$/, allowedQuery: ['workflowId'], allowedBody: null,
    handle: ({ query }) => agentApprovalsDataApi.listApprovals(query.get('workflowId') ?? undefined),
  },
  {
    method: 'POST', pattern: /^\/api\/agent\/approvals\/([^/]+)\/decision$/, allowedQuery: [], allowedBody: ['decision'],
    handle: ({ id, body }) => decideAgentApproval(decodeURIComponent(id), body.decision as 'approved' | 'denied'),
  },
  {
    method: 'GET', pattern: /^\/api\/agent\/runs\/([^/]+)\/operations$/, allowedQuery: [], allowedBody: null,
    handle: ({ id }) => agentApprovalsDataApi.listOperations(decodeURIComponent(id)),
  },
  {
    method: 'GET', pattern: /^\/api\/agent\/runs\/([^/]+)\/context-items$/, allowedQuery: [], allowedBody: null,
    handle: ({ id }) => agentApprovalsDataApi.listContextItems(decodeURIComponent(id)),
  },
  {
    method: 'GET', pattern: /^\/api\/agent\/execution-barriers$/, allowedQuery: ['workflowId'], allowedBody: null,
    handle: ({ query }) => agentApprovalsDataApi.listBarriers(query.get('workflowId') ?? undefined),
  },
  {
    method: 'POST', pattern: /^\/api\/agent\/execution-barriers\/([^/]+)\/reconcile$/, allowedQuery: [], allowedBody: ['decision', 'evidence'],
    handle: ({ id, body }) => reconcileAgentBarrier(
      decodeURIComponent(id),
      body.evidence as string,
      body.decision as 'confirmed-completed' | 'confirmed-stopped',
    ),
  },
  {
    method: 'GET', pattern: /^\/api\/agent\/resource-locks$/, allowedQuery: [], allowedBody: null,
    handle: () => agentApprovalsDataApi.listLocks(),
  },
  {
    method: 'POST', pattern: /^\/api\/agent\/resource-locks\/([^/]+)\/reconcile$/, allowedQuery: [], allowedBody: ['evidence', 'decision'],
    handle: ({ id, body }) => reconcileAgentLock(
      decodeURIComponent(id),
      body.evidence as string,
      body.decision as 'confirmed-stopped',
    ),
  },
  ...(['skills:skill', 'mcp-servers:mcp', 'execution-profiles:execution-profile', 'grants:grant'] as const).map((entry): Route => {
    const [path, kind] = entry.split(':') as [string, 'skill' | 'mcp' | 'execution-profile' | 'grant']
    return {
      method: 'POST',
      pattern: new RegExp(`^/api/agent/${path}/([^/]+)/revoke$`),
      allowedQuery: [],
      allowedBody: ['revision', 'reason'],
      handle: ({ id, body }) => revokeAgentCapability(kind, decodeURIComponent(id), body.revision as number, body.reason as string),
    }
  }),
]

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(status: number, message: string, code: string): Response {
  return jsonResponse({ error: message, code }, status)
}

function makeAdapterWithFakeServer(): { adapter: AgentApprovalsAdapter; fetchMock: ReturnType<typeof vi.fn> } {
  resetAgentApprovalsData(BASE)
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const [path, rawQuery = ''] = url.split('?')
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = ROUTES.find((item) => item.method === method && item.pattern.test(path ?? ''))
    if (route === undefined) return errorResponse(404, `测试未登记的 Agent 端点：${url}`, 'not-found')
    const match = route.pattern.exec(path ?? '')
    const id = match?.[1] ?? ''
    const query = new URLSearchParams(rawQuery)
    for (const key of query.keys()) {
      if (!route.allowedQuery.includes(key)) return errorResponse(400, '查询参数无效或重复', 'invalid-request')
    }
    let body: Record<string, unknown> = {}
    if (route.allowedBody !== null) {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      for (const key of Object.keys(body)) {
        if (!route.allowedBody.includes(key)) return errorResponse(400, '任务请求字段无效或含未声明的字段', 'invalid-request')
      }
    }
    try {
      return jsonResponse(route.handle({ id, query, body }))
    } catch (error) {
      if (error instanceof AgentApprovalsDomainError) return errorResponse(error.status, error.message, error.code)
      throw error
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { adapter: createHttpAgentApprovalsAdapter(), fetchMock }
}

let harness: ReturnType<typeof makeAdapterWithFakeServer>

beforeEach(() => {
  harness = makeAdapterWithFakeServer()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 最后一次请求的 (url, method, body 对象)。 */
function lastCall(): { url: string; method: string; body: Record<string, unknown>; headers: Headers } {
  const calls = harness.fetchMock.mock.calls as unknown as ReadonlyArray<[string, RequestInit]>
  const [url, init] = calls[calls.length - 1]!
  return {
    url,
    method: (init?.method ?? 'GET').toUpperCase(),
    body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    headers: new Headers(init?.headers),
  }
}

describe('HTTP 接线（路径、查询串与请求体形状）', () => {
  it('GET /approvals：无过滤不带查询串；workflowId 逐段编码', async () => {
    await harness.adapter.listApprovals()
    expect(lastCall().url).toBe('/api/agent/approvals')
    expect(lastCall().method).toBe('GET')
    await harness.adapter.listApprovals('wf 1?')
    expect(lastCall().url).toBe('/api/agent/approvals?workflowId=wf%201%3F')
  })

  it('决定审批：POST 体仅 {decision}，Content-Type 恒 application/json，无 requestId', async () => {
    const decided = await harness.adapter.decideApproval('ap-pending-write', { decision: 'approved' })
    expect(decided.status).toBe('approved')
    const call = lastCall()
    expect(call.url).toBe('/api/agent/approvals/ap-pending-write/decision')
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ decision: 'approved' })
    expect(call.headers.get('content-type')).toBe('application/json')
    expect('requestId' in call.body).toBe(false)
  })

  it('Run 操作与资料：GET /runs/{id}/operations 与 /context-items', async () => {
    const operations = await harness.adapter.listOperations('run-pending')
    expect(operations.length).toBeGreaterThan(0)
    expect(lastCall().url).toBe('/api/agent/runs/run-pending/operations')
    const items = await harness.adapter.listContextItems('run-pending')
    expect(Array.isArray(items)).toBe(true)
    expect(lastCall().url).toBe('/api/agent/runs/run-pending/context-items')
  })

  it('屏障：GET 过滤走查询参数；核实体仅 {decision,evidence}', async () => {
    await harness.adapter.listBarriers('wf-demo-2')
    expect(lastCall().url).toBe('/api/agent/execution-barriers?workflowId=wf-demo-2')
    const barrier = await harness.adapter.reconcileBarrier('bar-unknown-script', {
      evidence: '容器已退出。', decision: 'confirmed-stopped',
    })
    expect(barrier.status).toBe('reconciled')
    const call = lastCall()
    expect(call.url).toBe('/api/agent/execution-barriers/bar-unknown-script/reconcile')
    expect(call.body).toEqual({ decision: 'confirmed-stopped', evidence: '容器已退出。' })
    expect('requestId' in call.body).toBe(false)
  })

  it('租约：只走 /resource-locks（不消费 /resource-leases 别名）且列表不带查询参数；核实体仅 {evidence,decision}', async () => {
    const locks = await harness.adapter.listResourceLocks()
    expect(locks.length).toBeGreaterThan(0)
    expect(lastCall().url).toBe('/api/agent/resource-locks')
    const released = await harness.adapter.reconcileResourceLock('lock-probe-unknown', { evidence: '容器已消失。', decision: 'confirmed-stopped' })
    expect(released.state).toBe('released')
    const call = lastCall()
    expect(call.url).toBe('/api/agent/resource-locks/lock-probe-unknown/reconcile')
    expect(call.body).toEqual({ evidence: '容器已消失。', decision: 'confirmed-stopped' })
    expect('requestId' in call.body).toBe(false)
  })

  it('四类撤销：路径各自正确，体仅 {revision,reason}，无 requestId', async () => {
    await harness.adapter.revokeSkill('skill-demo-ops', 1, '过期。')
    expect(lastCall().url).toBe('/api/agent/skills/skill-demo-ops/revoke')
    expect(lastCall().body).toEqual({ revision: 1, reason: '过期。' })
    await harness.adapter.revokeMcpServer('mcp-11111111111111111111111111111111', 2, '轮换。')
    expect(lastCall().url).toBe('/api/agent/mcp-servers/mcp-11111111111111111111111111111111/revoke')
    expect(lastCall().body).toEqual({ revision: 2, reason: '轮换。' })
    await harness.adapter.revokeExecutionProfile('exec-python-demo', 1, '镜像过旧。')
    expect(lastCall().url).toBe('/api/agent/execution-profiles/exec-python-demo/revoke')
    await harness.adapter.revokeGrant('grant-demo-workspace', 1, '范围过大。')
    expect(lastCall().url).toBe('/api/agent/grants/grant-demo-workspace/revoke')
    for (const _ of [1, 2, 3, 4]) {
      expect('requestId' in lastCall().body).toBe(false)
    }
  })

  it('429 queue-full：中文 error 透传且 code 保留，审批仍 pending', async () => {
    setAgentApprovalsQueueFull(true)
    try {
      await expect(harness.adapter.decideApproval('ap-pending-write', { decision: 'approved' }))
        .rejects.toThrow('任务队列已满，审批保持待处理')
      const approvals = await harness.adapter.listApprovals()
      expect(approvals.find((item) => item.id === 'ap-pending-write')?.status).toBe('pending')
    } finally {
      setAgentApprovalsQueueFull(false)
    }
  })

  it('409 decision-conflict：code 保留在 AgentHttpError 上', async () => {
    await harness.adapter.decideApproval('ap-pending-write', { decision: 'approved' })
    try {
      await harness.adapter.decideApproval('ap-pending-write', { decision: 'denied' })
      expect.unreachable('应当抛出 decision-conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentHttpError)
      expect((error as AgentHttpError).code).toBe('decision-conflict')
      expect((error as AgentHttpError).message).toBe('审批已处理、过期或撤销')
    }
  })

  it('前端预检：证据与原因在发请求前拦截', async () => {
    await expect(harness.adapter.reconcileBarrier('bar-unknown-script', { evidence: '', decision: 'confirmed-stopped' }))
      .rejects.toThrow('核实证据必须为 1 到 8192 字节')
    await expect(harness.adapter.revokeSkill('skill-demo-ops', 1, ''))
      .rejects.toThrow('撤销原因必须为 1 到 2048 字节')
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })
})

describe('响应解析（形状漂移拒绝）', () => {
  it('审批：未知状态、缺 argumentsJson 原文字段均拒绝', () => {
    expect(() => parseAgentApproval({ id: 'a', runId: 'r', status: 'unknown-state', createdAt: 'x', expiresAt: 'y', operationId: 'o', operation: { id: 'o' } }))
      .toThrow('Agent 审批响应无效')
    expect(() => parseAgentOperation({
      id: 'o', runId: 'r', taskId: 't', modelRequestId: 'm', callIndex: 0, modelCallId: 'c',
      capability: { name: 'n', description: 'd', parameters: {}, source: 's', ref: { id: 'i', revision: 1 }, readOnly: false },
    })).toThrow('Agent 操作响应无效')
    expect(() => parseAgentResourceLease({ id: 'l', scopeId: 's', state: 'busy' })).toThrow('Agent 资源租约响应无效')
  })

  it('argumentsJson 原文按字符串保留：大整数不 float64、不重序列化', () => {
    const approval = parseAgentApproval(JSON.parse(JSON.stringify({
      id: 'a', runId: 'r', operationId: 'o', status: 'pending', createdAt: '2026-10-11T08:00:00Z', expiresAt: '2026-10-12T08:00:00Z',
      operation: {
        id: 'o', runId: 'r', taskId: 't', modelRequestId: 'm', callIndex: 0, modelCallId: 'c',
        argumentsJson: '{"value":9007199254740993}', capability: { name: 'n', description: 'd', parameters: {}, source: 's', ref: { id: 'i', revision: 1 }, readOnly: false },
        snapshotDigest: 'sd', workspaceRevision: 1, policy: '', status: 'planned', callId: 'cc', createdAt: '2026-10-11T08:00:00Z',
      },
    })))
    if (approval.kind === 'workflow-gate') throw new Error('应当是操作审批')
    expect(approval.operation.argumentsJson).toBe('{"value":9007199254740993}')
  })

  it('证据与原因字节校验导出可用', () => {
    expect(assertReconciliationEvidenceBytes('证据')).toBe('证据')
    expect(() => assertReconciliationEvidenceBytes('x'.repeat(8193))).toThrow('核实证据必须为 1 到 8192 字节')
    expect(assertRevokeReasonBytes('原因')).toBe('原因')
    expect(() => assertRevokeReasonBytes('长'.repeat(683))).toThrow('撤销原因必须为 1 到 2048 字节')
  })
})

runAgentApprovalsAdapterContract('http', () => makeAdapterWithFakeServer().adapter)

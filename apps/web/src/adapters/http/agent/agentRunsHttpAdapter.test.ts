import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunsAdapter } from '../../../contracts/adapters'
import { runAgentRunsAdapterContract } from '../../agentRunsAdapterContract'
import {
  createHttpAgentRunsAdapter,
  parseRuntimeCall,
  parseRuntimeEvent,
  parseRuntimeRun,
} from './agentRunsHttpAdapter'

/*
 * HTTP 实现的接线与解析测试。fetch stub 是一台按查询参数工作的假服务端
 * （列表过滤/游标、事件 after 增量、提交幂等与 409、取消语义），再对同一套
 * 契约断言复跑——请求必须落到 /api/agent/** 的精确路径与查询串，请求体不带
 * 未声明字段（cancel 无 body、submit 只含 requestId/kind/steps）。
 */

type FetchCall = { url: string; init?: RequestInit }

let calls: FetchCall[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: message, code }, status)
}

const LIMITS = {
  concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
  callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
  runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
  retentionDays: 30, cancelGraceSeconds: 5,
}

const RUNTIME_INFO = {
  available: true, worker: 'ready', storage: 'ready', tools: [], limits: LIMITS, queueDepth: 0,
  batch: { available: true }, agent: { available: true }, skills: { available: true }, mcp: { available: true },
  containerExecution: { available: true }, approvals: { available: true }, workflow: { available: true },
  wiki: { available: true }, embedding: { available: true }, workflowV2: { available: true },
  resourceLocks: { available: true }, executionRuntimes: { available: true },
}

const BASE_RUN = {
  taskId: 'task-http-ok',
  status: 'succeeded',
  createdAt: '2026-10-10T08:00:00Z',
  startedAt: '2026-10-10T08:00:01Z',
  endedAt: '2026-10-10T08:00:05Z',
  endReason: 'completed',
  driverVersion: 'v1',
  requestId: 'req-http-ok',
  limits: LIMITS,
  usage: { calls: 1, resultBytes: 96 },
  lastSeq: '11',
  task: {
    id: 'task-http-ok', requestId: 'req-http-ok', kind: 'tool-batch', driverVersion: 'v1',
    createdAt: '2026-10-10T08:00:00Z', steps: [{ tool: 'docker_containers_list', args: {} }],
  },
}

const EVENTS = Array.from({ length: 11 }, (_, index) => ({
  runId: 'run-http-ok', seq: String(index + 1), type: index % 2 === 0 ? 'call/started' : 'call/finished',
  at: '2026-10-10T08:00:01Z', stepIndex: index % 4,
}))

const CALLS = [
  {
    id: 'call-http-0', runId: 'run-http-ok', tool: 'docker_containers_list', status: 'succeeded',
    startedAt: '2026-10-10T08:00:01Z', endedAt: '2026-10-10T08:00:02Z', stepIndex: 0, args: {},
    argumentsJson: '{"size":9007199254740993,"nested":{"big":12345678901234567890}}', truncated: false,
  },
]

type FakeRun = { rowid: string; run: Record<string, unknown>; events: unknown[]; calls: unknown[] }

function fakeServer(): void {
  const runs: FakeRun[] = [
    { rowid: '9007199254741000', run: { ...BASE_RUN, id: 'run-http-ok' }, events: EVENTS, calls: CALLS },
    {
      rowid: '9007199254740999',
      run: {
        ...BASE_RUN, id: 'run-http-interrupted', taskId: 'task-http-interrupted', status: 'interrupted',
        endReason: 'panel-restarted', error: { code: 'panel-restarted', message: '面板进程重启，运行被中断' },
        requestId: 'req-http-interrupted',
      },
      events: EVENTS.slice(0, 4).map((event) => ({ ...event, runId: 'run-http-interrupted' })),
      calls: [],
    },
    {
      rowid: '7000',
      run: { ...BASE_RUN, id: 'run-http-history', taskId: 'task-http-history', requestId: 'req-http-history', lastSeq: '4' },
      events: EVENTS.slice(0, 4).map((event) => ({ ...event, runId: 'run-http-history' })),
      calls: [],
    },
  ]
  const submissions = new Map<string, { runId: string; canonical: string }>()

  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request).url)
    calls.push({ url, init })
    const parsed = new URL(url, 'http://elysian.local')
    const path = parsed.pathname
    const query = parsed.searchParams
    const method = (init?.method ?? 'GET').toUpperCase()

    if (path === '/api/agent/runtime' && method === 'GET') return jsonResponse(RUNTIME_INFO)

    if (path === '/api/agent/runs' && method === 'GET') {
      const status = query.get('status') ?? ''
      const requestId = query.get('requestId') ?? ''
      const cursor = query.get('cursor') ?? ''
      const limit = Number(query.get('limit') ?? '50')
      const rows = runs
        .filter((entry) => (status === '' ? true : entry.run.status === status))
        .filter((entry) => (requestId === '' ? true : entry.run.requestId === requestId))
        .filter((entry) => (cursor === '' ? true : BigInt(entry.rowid) < BigInt(cursor)))
        .sort((left, right) => (BigInt(right.rowid) < BigInt(left.rowid) ? -1 : 1))
      const slice = rows.slice(0, limit)
      const hasMore = rows.length > limit
      return jsonResponse({
        items: slice.map((entry) => entry.run),
        nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1]!.rowid : '',
        hasMore,
      })
    }

    if (path === '/api/agent/runs' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { requestId: string; kind: string; steps: { tool: string; args?: Record<string, unknown> }[] }
      const canonical = JSON.stringify({ kind: body.kind, steps: body.steps.map((step) => ({ tool: step.tool, args: {} })) })
      const previous = submissions.get(body.requestId)
      if (previous !== undefined) {
        if (previous.canonical !== canonical) return errorResponse(409, 'request-conflict', '请求标识已用于不同的任务输入')
        const hit = runs.find((entry) => entry.run.id === previous.runId)
        return jsonResponse(hit?.run ?? {}, 200)
      }
      const runId = `run-http-submit-${submissions.size + 1}`
      submissions.set(body.requestId, { runId, canonical })
      const run = {
        ...BASE_RUN, id: runId, taskId: `task-${runId}`, status: 'queued', startedAt: undefined,
        endedAt: undefined, endReason: undefined, requestId: body.requestId, usage: { calls: 0, resultBytes: 0 },
        lastSeq: '1',
        task: {
          id: `task-${runId}`, requestId: body.requestId, kind: 'tool-batch', driverVersion: 'v1',
          createdAt: '2026-10-10T09:00:00Z', steps: body.steps.map((step) => ({ tool: step.tool, args: {} })),
        },
      }
      runs.unshift({ rowid: String(9_100_000_000_000 + submissions.size), run, events: [], calls: [] })
      return jsonResponse(run, 202)
    }

    const runMatch = /^\/api\/agent\/runs\/([^/]+)$/.exec(path)
    if (runMatch !== null && method === 'GET') {
      const hit = runs.find((entry) => entry.run.id === runMatch[1])
      if (hit === undefined) return errorResponse(404, 'not-found', '运行不存在')
      return jsonResponse(hit.run)
    }

    const callsMatch = /^\/api\/agent\/runs\/([^/]+)\/calls$/.exec(path)
    if (callsMatch !== null && method === 'GET') {
      const hit = runs.find((entry) => entry.run.id === callsMatch[1])
      if (hit === undefined) return errorResponse(404, 'not-found', '运行不存在')
      const cursor = Number(query.get('cursor') ?? '0')
      const limit = Number(query.get('limit') ?? '50')
      const rows = hit.calls.filter((call) => ((call as { stepIndex: number }).stepIndex >= cursor))
      const slice = rows.slice(0, limit)
      return jsonResponse({
        items: slice,
        nextCursor: rows.length > limit && slice.length > 0 ? String((slice[slice.length - 1] as { stepIndex: number }).stepIndex + 1) : '',
        hasMore: rows.length > limit,
      })
    }

    const eventsMatch = /^\/api\/agent\/runs\/([^/]+)\/events$/.exec(path)
    if (eventsMatch !== null && method === 'GET') {
      const hit = runs.find((entry) => entry.run.id === eventsMatch[1])
      if (hit === undefined) return errorResponse(404, 'not-found', '运行不存在')
      const after = query.get('after') ?? ''
      const limit = Number(query.get('limit') ?? '100')
      const lastSeq = BigInt(String(hit.run.lastSeq))
      if (after !== '' && BigInt(after) > lastSeq) return errorResponse(400, 'future-cursor', '事件游标超过当前运行进度')
      const rows = hit.events.filter((event) => (after === '' ? true : BigInt((event as { seq: string }).seq) > BigInt(after)))
      const slice = rows.slice(0, limit)
      return jsonResponse({
        items: slice,
        nextCursor: slice.length > 0 ? String((slice[slice.length - 1] as { seq: string }).seq) : (after === '' ? '0' : after),
        hasMore: rows.length > limit,
      })
    }

    const cancelMatch = /^\/api\/agent\/runs\/([^/]+)\/cancel$/.exec(path)
    if (cancelMatch !== null && method === 'POST') {
      const hit = runs.find((entry) => entry.run.id === cancelMatch[1])
      if (hit === undefined) return errorResponse(404, 'not-found', '运行不存在')
      const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(hit.run.status))
      if (!terminal && hit.run.cancelRequestedAt === undefined) {
        hit.run.cancelRequestedAt = '2026-10-10T09:00:10Z'
        if (hit.run.status !== 'running') {
          hit.run.status = 'cancelled'
          hit.run.endReason = 'cancelled'
          hit.run.endedAt = hit.run.cancelRequestedAt
        }
      }
      return jsonResponse(hit.run, hit.run.status === 'queued' || hit.run.status === 'running' ? 202 : 200)
    }

    return errorResponse(404, 'not-found', `测试未登记的 Agent 端点：${url}`)
  }))
}

beforeEach(() => {
  calls = []
  fakeServer()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTP 解析', () => {
  it('parseRuntimeRun：必填字段、lastSeq 规范十进制、usage 未知量保持缺省', () => {
    const run = parseRuntimeRun({ ...BASE_RUN, id: 'run-x' })
    expect(run.id).toBe('run-x')
    expect(run.lastSeq).toBe('11')
    expect(run.usage.actualTokens).toBeUndefined()
    expect(run.usage.cachedTokens).toBeUndefined()
    expect(run.task?.kind).toBe('tool-batch')
    expect(() => parseRuntimeRun({ ...BASE_RUN, id: 'run-x', lastSeq: '011' })).toThrow('Agent Run 响应无效')
    expect(() => parseRuntimeRun({ ...BASE_RUN, id: 'run-x', status: 'unknown' })).toThrow('Agent 运行状态响应无效')
    expect(() => parseRuntimeRun({ ...BASE_RUN, id: 'run-x', usage: { calls: -1, resultBytes: 0 } })).toThrow('Agent 用量响应无效')
  })

  it('parseRuntimeRun：actualTokens/cachedTokens 为可空整数，报告值原样保留', () => {
    const run = parseRuntimeRun({
      ...BASE_RUN, id: 'run-y',
      usage: { calls: 2, resultBytes: 10, modelRequests: 3, tokens: 100, estimatedTokens: 90, actualTokens: 104, cachedTokens: 64 },
    })
    expect(run.usage).toEqual({ calls: 2, resultBytes: 10, modelRequests: 3, tokens: 100, estimatedTokens: 90, actualTokens: 104, cachedTokens: 64 })
  })

  it('parseRuntimeCall：argumentsJson 字符串原文透传（大整数不丢真）', () => {
    const original = '{"size":9007199254740993,"nested":{"big":12345678901234567890}}'
    const call = parseRuntimeCall({ ...CALLS[0]!, argumentsJson: original })
    expect(call.argumentsJson).toBe(original)
    expect(() => parseRuntimeCall({ ...CALLS[0]!, truncated: 'yes' })).toThrow('Agent 工具调用响应无效')
  })

  it('parseRuntimeEvent：seq 必须规范十进制；data 可缺省', () => {
    const event = parseRuntimeEvent({ runId: 'r', seq: '9007199254740993', type: 'run/started', at: 't' })
    expect(event.seq).toBe('9007199254740993')
    expect(event.data).toBeUndefined()
    expect(() => parseRuntimeEvent({ runId: 'r', seq: '1.5', type: 'run/started', at: 't' })).toThrow('Agent 事件响应无效')
  })
})

describe('HTTP 接线', () => {
  it('listRuns 落到精确查询串：status 单值一次、参数逐个编码', async () => {
    const adapter = createHttpAgentRunsAdapter()
    const page = await adapter.listRuns({ status: 'succeeded', requestId: 'r 1', limit: 20 })
    // 'r 1' 精确匹配不到任何 Run：断言重点在查询串编码与单值 status。
    expect(page.items).toHaveLength(0)
    expect(calls.map((call) => call.url)).toEqual([
      '/api/agent/runs?status=succeeded&requestId=r%201&limit=20',
    ])
    const url = calls[0]?.url ?? ''
    expect(url.match(/status=/g)).toHaveLength(1)
  })

  it('listRuns 不发送未定义参数；游标按十进制字符串透传', async () => {
    const adapter = createHttpAgentRunsAdapter()
    await adapter.listRuns({})
    await adapter.listRuns({ cursor: '9007199254741000' })
    expect(calls.map((call) => call.url)).toEqual([
      '/api/agent/runs',
      '/api/agent/runs?cursor=9007199254741000',
    ])
  })

  it('submitBatch 请求体只含 requestId/kind/steps；响应 Run 解析', async () => {
    const adapter = createHttpAgentRunsAdapter()
    const run = await adapter.submitBatch({
      requestId: 'http-1', kind: 'tool-batch',
      steps: [{ tool: 'docker_policy_view', args: {} }],
    })
    expect(run.status).toBe('queued')
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['kind', 'requestId', 'steps'])
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/api/agent/runs')
  })

  it('cancelRun 是无 body 的 POST，不携带 requestId', async () => {
    const adapter = createHttpAgentRunsAdapter()
    await adapter.cancelRun('run-http-ok')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(calls[0]?.url).toBe('/api/agent/runs/run-http-ok/cancel')
  })

  it('listRunEvents 校验 after 后发出；空 after 不带参数', async () => {
    const adapter = createHttpAgentRunsAdapter()
    await adapter.listRunEvents('run-http-ok', {})
    await adapter.listRunEvents('run-http-ok', { after: '5', limit: 100 })
    expect(calls.map((call) => call.url)).toEqual([
      '/api/agent/runs/run-http-ok/events',
      '/api/agent/runs/run-http-ok/events?after=5&limit=100',
    ])
  })

  it('非法入参发出前拒绝：limit、status、游标、after', async () => {
    const adapter = createHttpAgentRunsAdapter()
    await expect(adapter.listRuns({ limit: 0 })).rejects.toThrow('每页条数必须在 1 到 200 之间')
    await expect(adapter.listRuns({ status: 'weird' as never })).rejects.toThrow('运行状态无效')
    await expect(adapter.listRunCalls('run-http-ok', { cursor: '00' })).rejects.toThrow(/分页游标/)
    await expect(adapter.listRunEvents('run-http-ok', { after: 'x' })).rejects.toThrow('事件序号')
    expect(calls).toHaveLength(0)
  })

  it('服务端 409 错误体透传中文 error', async () => {
    const adapter = createHttpAgentRunsAdapter()
    await adapter.submitBatch({ requestId: 'dup-1', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view', args: {} }] })
    await expect(adapter.submitBatch({
      requestId: 'dup-1', kind: 'tool-batch', steps: [{ tool: 'docker_images_list', args: {} }],
    })).rejects.toThrow('请求标识已用于不同的任务输入')
  })
})

runAgentRunsAdapterContract('HTTP 运行记录', (): AgentRunsAdapter => createHttpAgentRunsAdapter(), {
  succeededRunId: 'run-http-ok',
  interruptedRunId: 'run-http-interrupted',
  enoughRunsForPaging: true,
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCreateWorkflowDefinitionInput,
  AgentCreateWorkflowInput,
  AgentWorkflowDefinition,
  AgentWorkflowEvent,
  AgentWorkflowInstance,
  AgentWorkflowRecoveryInput,
} from '@elysian/contracts'
import { runAgentWorkflowsAdapterContract } from '../../agentWorkflowsAdapterContract'
import {
  WORKFLOW_ATTEMPTS_PORTAL_RUNNING,
  WORKFLOW_CONTRACT_CREATE_INPUT,
  WORKFLOW_CONTRACT_DEFINITIONS,
  WORKFLOW_CONTRACT_DEFINITION_INPUT,
  WORKFLOW_CONTRACT_RECOVERY_INPUT,
  WORKFLOW_DEFINITION_PORTAL,
  WORKFLOW_DEFINITION_PORTAL_REVISION1,
  WORKFLOW_EVENTS_PORTAL_RUNNING,
  WORKFLOW_INSTANCE_AUDIT_CANCELLED,
  WORKFLOW_INSTANCE_BACKUP_CREATED,
  WORKFLOW_INSTANCE_BACKUP_SUCCEEDED,
  WORKFLOW_INSTANCE_PORTAL_RECOVERY,
  WORKFLOW_INSTANCE_PORTAL_RECOVERED,
  WORKFLOW_INSTANCE_PORTAL_RUNNING,
  WORKFLOW_TREE_PORTAL_RECOVERY,
  WORKFLOW_TREE_PORTAL_RUNNING,
} from '../../agentWorkflowsFixtures'
import { createHttpAgentWorkflowsAdapter } from './agentWorkflowsHttpAdapter'

/*
 * HTTP 适配器测试：先用一个内存版「迷你服务」实现 workflow_routes.go 的关键语义
 * （CAS、requestId 幂等、错误码），对适配器跑同一套契约断言；再断言请求精确落在
 * /api/agent/** 的路径与查询串上、请求体形状（无 requestId 的端点绝不带 requestId）。
 */

type RecordedRequest = { method: string; url: string; body?: string; contentType?: string }

let recorded: RecordedRequest[] = []

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(status: number, code: string, error: string): Response {
  return jsonResponse({ error, code }, status)
}

function page<T>(items: readonly T[], nextCursor = '', hasMore = false) {
  return { items, nextCursor, hasMore }
}

type MiniServer = {
  definitions: AgentWorkflowDefinition[]
  instances: AgentWorkflowInstance[]
  recoveries: Map<string, { canonical: string; document: AgentWorkflowInstance }>
  createCanonicals: Map<string, { canonical: string; id: string }>
  barrierCount: number
}

let server: MiniServer

function seedServer(): void {
  server = {
    definitions: [structuredClone(WORKFLOW_DEFINITION_PORTAL_REVISION1), ...structuredClone([...WORKFLOW_CONTRACT_DEFINITIONS])],
    instances: [
      structuredClone(WORKFLOW_INSTANCE_PORTAL_RUNNING),
      structuredClone(WORKFLOW_INSTANCE_BACKUP_SUCCEEDED),
      structuredClone(WORKFLOW_INSTANCE_PORTAL_RECOVERY),
      structuredClone(WORKFLOW_INSTANCE_AUDIT_CANCELLED),
    ],
    recoveries: new Map(),
    createCanonicals: new Map(),
    barrierCount: 0,
  }
}

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  // jsdom 的 Request 构造器不接受相对 URL：直接从入参解析路径与方法，不重建 Request。
  const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
  const url = new URL(rawUrl, 'http://elysian.test')
  const path = url.pathname
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const body = init?.body !== undefined && typeof init.body === 'string' ? init.body : undefined
  const contentType = new Headers(init?.headers).get('content-type') ?? undefined
  recorded.push({ method, url: `${path}${url.search}`, body, contentType })
  const segments = path.split('/').filter((segment) => segment !== '')
  // segments: ['api', 'agent', ...rest]
  const rest = segments.slice(2)

  const json = <T,>(raw: string | undefined): T | undefined => (raw === undefined ? undefined : (JSON.parse(raw) as T))

  if (path === '/api/agent/workflow-definitions' && method === 'GET') {
    const latest = new Map<string, AgentWorkflowDefinition>()
    for (const item of server.definitions) {
      const current = latest.get(item.id)
      if (current === undefined || item.revision > current.revision) latest.set(item.id, item)
    }
    return jsonResponse([...latest.values()])
  }
  if (path === '/api/agent/workflow-definitions' && method === 'POST') {
    const input = json<AgentCreateWorkflowDefinitionInput>(body)
    if (input === undefined) return errorResponse(400, 'invalid-json', '请求必须是无重复键的 JSON 对象')
    if (JSON.stringify(input).includes('"parallel"') && (input.languageVersion ?? 'v1') !== 'workflow/v2') {
      return errorResponse(400, 'workflow-definition-invalid', 'workflow/v1 不能包含复合步骤字段')
    }
    const created: AgentWorkflowDefinition = { ...input, languageVersion: input.languageVersion ?? 'v1', id: 'wf-def-created-01', revision: 1, createdAt: '2026-10-11T01:00:00.000Z' }
    server.definitions.push(created)
    return jsonResponse(created, 201)
  }
  if (rest[0] === 'workflow-definitions' && rest.length === 2 && method === 'GET') {
    const revision = url.searchParams.get('revision')
    const candidates = server.definitions.filter((item) => item.id === rest[1])
    if (candidates.length === 0) return errorResponse(404, 'not-found', '工作流模板不存在')
    const exact = revision !== null ? candidates.find((item) => String(item.revision) === revision) : undefined
    const latest = candidates.reduce((a, b) => (a.revision > b.revision ? a : b))
    return jsonResponse(exact ?? latest)
  }
  if (rest[0] === 'workflow-definitions' && rest.length === 2 && method === 'PUT') {
    const input = json<{ expectedRevision: number } & AgentCreateWorkflowDefinitionInput>(body)
    if (input === undefined) return errorResponse(400, 'invalid-json', '请求必须是无重复键的 JSON 对象')
    const candidates = server.definitions.filter((item) => item.id === rest[1])
    const latest = candidates.reduce((a, b) => (a.revision > b.revision ? a : b))
    if (input.expectedRevision !== latest.revision) return errorResponse(409, 'revision-conflict', '工作流模板版本已变化')
    const updated: AgentWorkflowDefinition = { ...input, languageVersion: input.languageVersion ?? 'v1', id: latest.id, revision: latest.revision + 1, createdAt: '2026-10-11T01:00:00.000Z' }
    server.definitions.push(updated)
    return jsonResponse(updated)
  }
  if (path === '/api/agent/workflow-instances' && method === 'POST') {
    const input = json<AgentCreateWorkflowInput>(body)
    if (input === undefined) return errorResponse(400, 'invalid-json', '请求必须是无重复键的 JSON 对象')
    const canonical = JSON.stringify({ definitionId: input.definitionId, definitionRevision: input.definitionRevision, sourceSessionId: input.sourceSessionId, inputJson: input.inputJson })
    const prior = server.createCanonicals.get(input.requestId)
    if (prior !== undefined) {
      if (prior.canonical !== canonical) return errorResponse(409, 'request-conflict', '相同请求标识对应不同工作流输入')
      const existing = server.instances.find((item) => item.id === prior.id)
      return jsonResponse(existing, 200)
    }
    const created = structuredClone(WORKFLOW_INSTANCE_BACKUP_CREATED)
    server.instances.push(created)
    server.createCanonicals.set(input.requestId, { canonical, id: created.id })
    return jsonResponse(created, 202)
  }
  if (path === '/api/agent/workflow-instances' && method === 'GET') {
    const status = url.searchParams.get('status') ?? ''
    const cursor = Number(url.searchParams.get('cursor') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const filtered = status === '' ? server.instances : server.instances.filter((item) => item.status === status)
    const slice = filtered.slice(cursor, cursor + limit)
    const hasMore = cursor + limit < filtered.length
    return jsonResponse(page(slice, hasMore ? String(cursor + limit) : '', hasMore))
  }
  if (rest[0] === 'workflow-instances' && rest.length === 2 && method === 'GET') {
    const instance = server.instances.find((item) => item.id === rest[1])
    if (instance === undefined) return errorResponse(404, 'not-found', '工作流实例不存在')
    const doc = structuredClone(instance)
    if (doc.languageVersion === 'workflow/v2') {
      doc.executionTree = doc.id === 'wf-inst-portal-01' ? structuredClone(WORKFLOW_TREE_PORTAL_RUNNING) : structuredClone(WORKFLOW_TREE_PORTAL_RECOVERY)
    }
    return jsonResponse(doc)
  }
  if (rest[0] === 'workflow-instances' && rest.length === 3 && rest[2] === 'execution-tree') {
    const instance = server.instances.find((item) => item.id === rest[1])
    if (instance === undefined) return errorResponse(404, 'not-found', '工作流实例不存在')
    if (instance.languageVersion !== 'workflow/v2') return jsonResponse({ rootScopeId: '', scopes: [], nodes: [] })
    return jsonResponse(instance.id === 'wf-inst-portal-01' ? WORKFLOW_TREE_PORTAL_RUNNING : WORKFLOW_TREE_PORTAL_RECOVERY)
  }
  if (rest[0] === 'workflow-instances' && rest.length === 3 && rest[2] === 'steps') {
    if (rest[1] !== 'wf-inst-portal-01') return jsonResponse(page([]))
    return jsonResponse(page(WORKFLOW_ATTEMPTS_PORTAL_RUNNING))
  }
  if (rest[0] === 'workflow-instances' && rest.length === 3 && rest[2] === 'events') {
    if (rest[1] !== 'wf-inst-portal-01') return jsonResponse(page([]))
    const cursor = Number(url.searchParams.get('cursor') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const all: readonly AgentWorkflowEvent[] = WORKFLOW_EVENTS_PORTAL_RUNNING
    const slice = all.slice(cursor, cursor + limit)
    const hasMore = cursor + limit < all.length
    return jsonResponse(page(slice, hasMore ? String(cursor + limit) : '', hasMore))
  }
  if (rest[0] === 'workflow-instances' && rest.length === 3 && rest[2] === 'cancel' && method === 'POST') {
    const instance = server.instances.find((item) => item.id === rest[1])
    if (instance === undefined) return errorResponse(404, 'not-found', '工作流实例不存在')
    return jsonResponse(instance)
  }
  if (rest[0] === 'workflow-instances' && rest.length === 3 && rest[2] === 'recover' && method === 'POST') {
    const instance = server.instances.find((item) => item.id === rest[1])
    if (instance === undefined) return errorResponse(404, 'not-found', '工作流实例不存在')
    const input = json<AgentWorkflowRecoveryInput>(body)
    if (input === undefined) return errorResponse(400, 'invalid-json', '请求必须是无重复键的 JSON 对象')
    const canonical = body ?? ''
    const prior = server.recoveries.get(input.requestId)
    if (prior !== undefined) {
      if (prior.canonical !== canonical) return errorResponse(409, 'request-conflict', '相同恢复请求标识对应不同输入')
      return jsonResponse(prior.document, 200)
    }
    if (server.barrierCount > 0) return errorResponse(409, 'execution-barrier', '必须先核实全部未知执行屏障')
    const recovered = structuredClone(WORKFLOW_INSTANCE_PORTAL_RECOVERED)
    server.recoveries.set(input.requestId, { canonical, document: recovered })
    return jsonResponse(recovered, 202)
  }
  return errorResponse(404, 'not-found', `测试迷你服务未实现：${method} ${path}`)
})

beforeEach(() => {
  recorded = []
  seedServer()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

runAgentWorkflowsAdapterContract('HTTP', () => createHttpAgentWorkflowsAdapter())

describe('工作流 HTTP 适配器接线', () => {
  it('读取端点落在精确路径与查询串上（未知/重复参数绝不发送）', async () => {
    const adapter = createHttpAgentWorkflowsAdapter()
    await adapter.listDefinitions()
    await adapter.getDefinition('wf-def-portal', 1)
    await adapter.listInstances({ status: 'running', cursor: '0', limit: 50 })
    await adapter.getInstance('wf-inst-portal-01')
    await adapter.getExecutionTree('wf-inst-portal-01')
    await adapter.listAttempts('wf-inst-portal-01', { cursor: '0', limit: 50 })
    await adapter.listInstanceEvents('wf-inst-portal-01', { cursor: '0', limit: 50 })
    expect(recorded.map((item) => `${item.method} ${item.url}`)).toEqual([
      'GET /api/agent/workflow-definitions',
      'GET /api/agent/workflow-definitions/wf-def-portal?revision=1',
      'GET /api/agent/workflow-instances?status=running&cursor=0&limit=50',
      'GET /api/agent/workflow-instances/wf-inst-portal-01',
      'GET /api/agent/workflow-instances/wf-inst-portal-01/execution-tree',
      'GET /api/agent/workflow-instances/wf-inst-portal-01/steps?cursor=0&limit=50',
      'GET /api/agent/workflow-instances/wf-inst-portal-01/events?cursor=0&limit=50',
    ])
    expect(recorded.every((item) => item.contentType === 'application/json')).toBe(true)
  })

  it('listInstances 不带过滤器时不发送 status 参数', async () => {
    await createHttpAgentWorkflowsAdapter().listInstances({})
    expect(recorded[0]?.url).toBe('/api/agent/workflow-instances?limit=50')
  })

  it('模板创建/更新体不含 requestId；更新体在顶层平铺 expectedRevision', async () => {
    const adapter = createHttpAgentWorkflowsAdapter()
    await adapter.createDefinition(WORKFLOW_CONTRACT_DEFINITION_INPUT)
    const createBody = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>
    expect(createBody['requestId']).toBeUndefined()
    expect(createBody['name']).toBe('契约新建模板')
    expect(Object.keys(createBody).sort()).toEqual(['enabled', 'entry', 'goal', 'inputSchemaJson', 'languageVersion', 'name', 'outputSchemaJson', 'steps'])
    await adapter.updateDefinition('wf-def-portal', {
      goal: '并行诊断门户容器异常并汇总结论（修订目标）',
      name: WORKFLOW_DEFINITION_PORTAL.name,
      enabled: true,
      inputSchemaJson: WORKFLOW_DEFINITION_PORTAL.inputSchemaJson,
      outputSchemaJson: WORKFLOW_DEFINITION_PORTAL.outputSchemaJson,
      entry: WORKFLOW_DEFINITION_PORTAL.entry,
      steps: WORKFLOW_DEFINITION_PORTAL.steps,
      languageVersion: 'workflow/v2',
      expectedRevision: 2,
    })
    const updateBody = JSON.parse(recorded[1]?.body ?? '{}') as Record<string, unknown>
    expect(updateBody['requestId']).toBeUndefined()
    expect(updateBody['expectedRevision']).toBe(2)
    expect(recorded[1]?.method).toBe('PUT')
    expect(recorded[1]?.url).toBe('/api/agent/workflow-definitions/wf-def-portal')
  })

  it('取消实例：POST 无请求体、无 requestId', async () => {
    await createHttpAgentWorkflowsAdapter().cancelInstance('wf-inst-backup-01')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.url).toBe('/api/agent/workflow-instances/wf-inst-backup-01/cancel')
    expect(recorded[0]?.body).toBeUndefined()
  })

  it('创建实例与恢复：请求体只含声明字段（requestId 白名单端点）', async () => {
    const adapter = createHttpAgentWorkflowsAdapter()
    await adapter.createInstance(WORKFLOW_CONTRACT_CREATE_INPUT)
    const createBody = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(createBody).sort()).toEqual(['definitionId', 'definitionRevision', 'inputJson', 'requestId', 'sourceSessionId'])
    expect(recorded[0]?.url).toBe('/api/agent/workflow-instances')
    await adapter.recoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)
    const recoverBody = JSON.parse(recorded[1]?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(recoverBody).sort()).toEqual(['action', 'evidence', 'expectedRevision', 'nodeId', 'requestId'])
    expect(recorded[1]?.url).toBe('/api/agent/workflow-instances/wf-inst-portal-02/recover')
  })

  it('服务端错误体透传中文 error 与 code（409 revision-conflict / 404 not-found / 409 execution-barrier）', async () => {
    const adapter = createHttpAgentWorkflowsAdapter()
    await expect(
      adapter.updateDefinition('wf-def-portal', { ...WORKFLOW_CONTRACT_DEFINITION_INPUT, expectedRevision: 1 }),
    ).rejects.toThrow('工作流模板版本已变化')
    await expect(adapter.getInstance('wf-inst-missing')).rejects.toThrow('工作流实例不存在')
    server.barrierCount = 1
    await expect(adapter.recoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT)).rejects.toThrow('必须先核实全部未知执行屏障')
  })

  it('恢复响应形状漂移被中文错误拦截（lastSeq 非十进制字符串）', async () => {
    const broken = { ...WORKFLOW_INSTANCE_PORTAL_RECOVERED, lastSeq: 'abc' }
    fetchMock.mockImplementationOnce(async () => jsonResponse(broken))
    await expect(
      createHttpAgentWorkflowsAdapter().recoverInstance('wf-inst-portal-02', WORKFLOW_CONTRACT_RECOVERY_INPUT),
    ).rejects.toThrow('工作流事件序号必须为规范非负十进制字符串')
  })
})

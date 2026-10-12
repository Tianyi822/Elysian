import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionProfileInput,
  AgentExecutionGrantInput,
  AgentModelProfileInput,
  AgentResourceRuleInput,
} from '@elysian/contracts'
import { runAgentCapabilitiesAdapterContract } from '../../agentCapabilitiesAdapterContract'
import { createHttpAgentCapabilitiesAdapter, parseAgentExecutionRuntime } from './agentCapabilitiesHttpAdapter'

/*
 * HTTP 适配器测试分两层：
 * 1. 契约断言：跑在与 mock 同一套 runAgentCapabilitiesAdapterContract 上，fetch
 *    换成内存假服务（模拟 Go 路由的 CAS/追加修订/凭据不回显/编号拦截语义），
 *    验证「mock 可替换」；
 * 2. 接线断言：静态路由 stub 检查请求落到精确路径、方法与查询串，且请求体
 *    不含 requestId、credential 省略即不带字段、resource-rules POST 体无
 *    expectedRevision。
 */

type FakeEntity = {
  id: string
  revisions: Record<string, unknown>[]
  credential?: string
  seq: number
}

type FakeStore = {
  models: Map<string, FakeEntity>
  execution: Map<string, FakeEntity>
  grants: Map<string, FakeEntity>
  rules: Map<string, FakeEntity>
  seq: number
}

function errorBody(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), { status, headers: { 'content-type': 'application/json' } })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  const raw = typeof init?.body === 'string' ? init.body : ''
  return JSON.parse(raw) as Record<string, unknown>
}

function intOf(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}

/** 内存假服务：只实现契约断言触达的语义（CAS、追加修订、凭据、编号、限额）。 */
function makeFakeAgentServer(): { fetchMock: ReturnType<typeof vi.fn>; requests: { url: string; method: string; body: string }[] } {
  const store: FakeStore = { models: new Map(), execution: new Map(), grants: new Map(), rules: new Map(), seq: 0 }
  const requests: { url: string; method: string; body: string }[] = []
  const nextId = (prefix: string): string => `${prefix}-${++store.seq}`

  const limitsProblem = (body: Record<string, unknown>): boolean =>
    intOf(body.timeoutSeconds) > 300 || intOf(body.cpuMillis) > 1000 ||
    intOf(body.memoryBytes) > 512 * 1024 * 1024 || intOf(body.pids) > 128

  const modelPublic = (entity: FakeEntity): Record<string, unknown> => {
    const latest = entity.revisions[entity.revisions.length - 1] as Record<string, unknown>
    return { ...latest, id: entity.id, revision: entity.revisions.length, hasCredential: (entity.credential ?? '') !== '' }
  }

  const versionedPublic = (entity: FakeEntity): Record<string, unknown> => {
    const latest = entity.revisions[entity.revisions.length - 1] as Record<string, unknown>
    return { ...latest, id: entity.id, revision: entity.revisions.length }
  }

  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).href
    const parts = url.split('?')
    const path = parts[0] ?? url
    const query = parts[1] ?? ''
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' })
    const segments = path.replace('/api/agent/', '').split('/')
    const params = new URLSearchParams(query)
    const body = method === 'POST' || method === 'PUT' ? readBody(init) : {}

    // 模型配置
    if (segments[0] === 'model-profiles') {
      if (method === 'GET') return jsonResponse([...store.models.values()].map(modelPublic))
      if (method === 'POST') {
        const entity: FakeEntity = { id: nextId('mp'), revisions: [{ ...body, capabilities: body.capabilities }], credential: typeof body.credential === 'string' ? body.credential : '', seq: store.seq }
        store.models.set(entity.id, entity)
        return jsonResponse(modelPublic(entity), 201)
      }
      if (method === 'PUT' && segments.length === 2) {
        const entity = store.models.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, 'profile-not-found', '模型配置不存在')
        if (intOf(body.expectedRevision) !== entity.revisions.length) {
          return errorBody(409, 'revision-conflict', '模型配置已被修改，请重新读取后重试')
        }
        const { expectedRevision: _expected, credential, ...rest } = body
        entity.revisions.push({ ...rest })
        if (typeof credential === 'string') entity.credential = credential
        return jsonResponse(modelPublic(entity))
      }
    }

    // 执行配置与授权（同构：列表/详情/新建/编辑/启停）
    for (const [prefix, map, notFound, conflictMessage] of [
      ['execution-profiles', store.execution, '执行环境配置不存在', '执行环境已被修改，请重新读取后重试'],
      ['grants', store.grants, '执行授权不存在', '执行授权已被修改，请重新读取后重试'],
    ] as const) {
      if (segments[0] !== prefix) continue
      const kindLabel = prefix === 'execution-profiles' ? '执行配置' : '执行授权'
      if (method === 'GET' && segments.length === 1) return jsonResponse([...map.values()].map(versionedPublic))
      if (method === 'GET' && segments.length === 2) {
        const entity = map.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, `${prefix}-not-found`, notFound)
        const revision = params.get('revision')
        if (revision === null) return jsonResponse(versionedPublic(entity))
        const index = Number.parseInt(revision, 10)
        const hit = index >= 1 && index <= entity.revisions.length ? entity.revisions[index - 1] : undefined
        if (hit === undefined) return errorBody(404, `${prefix}-revision-not-found`, `${notFound.replace('不存在', '修订不存在')}`)
        return jsonResponse({ ...(hit as Record<string, unknown>), id: entity.id, revision: index })
      }
      if (method === 'POST' && segments.length === 1) {
        if (typeof body.id === 'string' && body.id !== '') {
          return errorBody(400, 'invalid-id', `新建${kindLabel}不能指定编号`)
        }
        if (intOf(body.expectedRevision) !== 0) {
          return errorBody(409, 'execution_revision_conflict', `新建${kindLabel === '执行配置' ? '执行环境' : '执行授权'}的预期修订必须为零`)
        }
        if (limitsProblem(body)) {
          return errorBody(400, 'execution_invalid_limits', '执行限额只能收紧，不能超过 5 分钟、1 CPU、512 MiB 内存与 128 个进程')
        }
        const entity: FakeEntity = { id: nextId(prefix.slice(0, 2)), revisions: [{ ...body, createdAt: '2026-10-11T09:00:00.000Z' }], seq: store.seq }
        map.set(entity.id, entity)
        return jsonResponse(versionedPublic(entity), 201)
      }
      if (method === 'PUT' && segments.length === 2) {
        const entity = map.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, `${prefix}-not-found`, notFound)
        if (typeof body.id === 'string' && body.id !== '' && body.id !== entity.id) {
          return errorBody(400, 'invalid-id', `${kindLabel}编号与路径不一致`)
        }
        if (intOf(body.expectedRevision) !== entity.revisions.length) {
          return errorBody(409, 'execution_revision_conflict', conflictMessage)
        }
        if (limitsProblem(body)) {
          return errorBody(400, 'execution_invalid_limits', '执行限额只能收紧，不能超过 5 分钟、1 CPU、512 MiB 内存与 128 个进程')
        }
        const { expectedRevision: _expected, ...rest } = body
        entity.revisions.push({ ...rest, createdAt: '2026-10-11T09:01:00.000Z' })
        return jsonResponse(versionedPublic(entity))
      }
      if (method === 'PUT' && segments.length === 3 && segments[2] === 'enabled') {
        const entity = map.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, `${prefix}-not-found`, notFound)
        if (intOf(body.expectedRevision) !== entity.revisions.length) {
          return errorBody(409, 'execution_revision_conflict', conflictMessage)
        }
        const latest = entity.revisions[entity.revisions.length - 1] as Record<string, unknown>
        entity.revisions.push({ ...latest, enabled: body.enabled === true, createdAt: '2026-10-11T09:02:00.000Z' })
        return jsonResponse(versionedPublic(entity))
      }
    }

    // 资源规则
    if (segments[0] === 'resource-rules') {
      const digestOf = (input: Record<string, unknown>, revision: number) => `digest-${revision}-${JSON.stringify(input).length}`
      if (method === 'GET' && segments.length === 1) return jsonResponse([...store.rules.values()].map(versionedPublic))
      if (method === 'GET' && segments.length === 2) {
        const entity = store.rules.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, 'resource-rule-not-found', '资源规则不存在')
        const revision = params.get('revision')
        if (revision === null) return jsonResponse(versionedPublic(entity))
        const index = Number.parseInt(revision, 10)
        const hit = index >= 1 && index <= entity.revisions.length ? entity.revisions[index - 1] : undefined
        if (hit === undefined) return errorBody(404, 'resource-rule-not-found', '资源规则不存在')
        return jsonResponse({ ...(hit as Record<string, unknown>), id: entity.id, revision: index })
      }
      if (method === 'POST' && segments.length === 1) {
        const entity: FakeEntity = { id: nextId('rr'), revisions: [{ ...body, digest: digestOf(body, 1), createdAt: '2026-10-11T09:00:00.000Z' }], seq: store.seq }
        store.rules.set(entity.id, entity)
        return jsonResponse(versionedPublic(entity), 201)
      }
      if (method === 'PUT' && segments.length === 2) {
        const entity = store.rules.get(decodeURIComponent(segments[1] ?? ''))
        if (entity === undefined) return errorBody(404, 'resource-rule-not-found', '资源规则不存在')
        if (intOf(body.expectedRevision) !== entity.revisions.length) {
          return errorBody(409, 'revision-conflict', '资源规则修订已变化')
        }
        const { expectedRevision: _expected, ...rest } = body
        entity.revisions.push({ ...rest, digest: digestOf(rest, entity.revisions.length + 1), createdAt: '2026-10-11T09:03:00.000Z' })
        return jsonResponse(versionedPublic(entity))
      }
    }

    if (path === '/api/agent/execution-runtimes' && method === 'GET') {
      return jsonResponse([])
    }
    return errorBody(404, 'not-stubbed', `测试未登记的 Agent 端点：${url}`)
  })

  return { fetchMock, requests }
}

describe('HTTP 适配器契约断言（内存假服务）', () => {
  runAgentCapabilitiesAdapterContract('HTTP＋假服务', () => {
    const { fetchMock } = makeFakeAgentServer()
    vi.stubGlobal('fetch', fetchMock)
    return createHttpAgentCapabilitiesAdapter()
  })

  afterEach(() => vi.unstubAllGlobals())
})

const MODEL_INPUT: AgentModelProfileInput = {
  name: '接线测试模型',
  baseUrl: 'https://api.example.com/v1',
  model: 'wire-test-model',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 16000,
  outputTokens: 1024,
  capabilities: { text: true, tools: true, source: '接线测试' },
  active: true,
}

const EXECUTION_INPUT: AgentExecutionProfileInput = {
  enabled: true,
  name: '接线执行配置',
  image: `registry.example.com/elysian/wire@sha256:${'ab12cd34'.repeat(8)}`,
  runtime: 'node',
  command: ['node', '-'],
  timeoutSeconds: 45,
  cpuMillis: 300,
  memoryBytes: 134217728,
  pids: 32,
  expectedRevision: 0,
}

const GRANT_INPUT: AgentExecutionGrantInput = {
  enabled: true,
  name: '接线授权',
  directories: [],
  network: [{ scheme: 'https', host: 'api.example.com', port: 443 }],
  privateCidrs: [],
  expectedRevision: 0,
}

const RULE_INPUT: AgentResourceRuleInput = {
  name: '接线资源规则',
  enabled: true,
  complete: false,
  selector: { source: 'script', ref: { id: 'skill-wire', revision: 1 } },
  mappings: [{ kind: 'config-key', authority: 'script', access: 'read', pointer: '/config/keys' }],
}

describe('HTTP 适配器接线断言', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let requests: { url: string; method: string; body: string }[]
  let adapter: ReturnType<typeof createHttpAgentCapabilitiesAdapter>

  beforeEach(() => {
    const server = makeFakeAgentServer()
    fetchMock = server.fetchMock
    requests = server.requests
    vi.stubGlobal('fetch', fetchMock)
    adapter = createHttpAgentCapabilitiesAdapter()
  })

  afterEach(() => vi.unstubAllGlobals())

  function lastRequest(): { url: string; method: string; body: string } {
    return requests[requests.length - 1] ?? (() => { throw new Error('没有发出请求') })()
  }

  function lastBody(): Record<string, unknown> {
    return JSON.parse(lastRequest().body) as Record<string, unknown>
  }

  it('列表读取落到精确路径且无查询参数', async () => {
    await adapter.listModelProfiles()
    expect(lastRequest()).toEqual({ url: '/api/agent/model-profiles', method: 'GET', body: '' })
    await adapter.listExecutionProfiles()
    expect(lastRequest().url).toBe('/api/agent/execution-profiles')
    await adapter.listGrants()
    expect(lastRequest().url).toBe('/api/agent/grants')
    await adapter.listResourceRules()
    expect(lastRequest().url).toBe('/api/agent/resource-rules')
    await adapter.listExecutionRuntimes()
    expect(lastRequest().url).toBe('/api/agent/execution-runtimes')
  })

  it('新建模型体不含 requestId；credential 省略不带字段、空串按清除发送', async () => {
    await adapter.createModelProfile(MODEL_INPUT)
    const omitted = lastBody()
    expect('requestId' in omitted).toBe(false)
    expect('credential' in omitted).toBe(false)
    expect(omitted.name).toBe('接线测试模型')
    await adapter.createModelProfile({ ...MODEL_INPUT, credential: '' })
    expect(lastBody().credential).toBe('')
    await adapter.createModelProfile({ ...MODEL_INPUT, credential: 'wire-secret' })
    expect(lastBody().credential).toBe('wire-secret')
  })

  it('更新模型平铺 expectedRevision 并落到编号路径', async () => {
    const created = await adapter.createModelProfile(MODEL_INPUT)
    await adapter.updateModelProfile(created.id, { ...MODEL_INPUT, expectedRevision: created.revision })
    const request = lastRequest()
    expect(request.url).toBe(`/api/agent/model-profiles/${created.id}`)
    expect(request.method).toBe('PUT')
    expect(lastBody().expectedRevision).toBe(created.revision)
    expect('requestId' in lastBody()).toBe(false)
  })

  it('修订详情查询串逐个编码且只带 revision', async () => {
    const execution = await adapter.createExecutionProfile(EXECUTION_INPUT)
    await adapter.getExecutionProfile(execution.id, 1)
    expect(lastRequest().url).toBe(`/api/agent/execution-profiles/${execution.id}?revision=1`)
    await adapter.getExecutionProfile(execution.id)
    expect(lastRequest().url).toBe(`/api/agent/execution-profiles/${execution.id}`)
    const grant = await adapter.createGrant(GRANT_INPUT)
    await adapter.getGrant(grant.id, 1)
    expect(lastRequest().url).toBe(`/api/agent/grants/${grant.id}?revision=1`)
    const rule = await adapter.createResourceRule(RULE_INPUT)
    await adapter.getResourceRule(rule.id, 1)
    expect(lastRequest().url).toBe(`/api/agent/resource-rules/${rule.id}?revision=1`)
  })

  it('启停端点体为 {expectedRevision,enabled}，路径到 /enabled', async () => {
    const execution = await adapter.createExecutionProfile(EXECUTION_INPUT)
    await adapter.setExecutionProfileEnabled(execution.id, execution.revision, false)
    expect(lastRequest().url).toBe(`/api/agent/execution-profiles/${execution.id}/enabled`)
    expect(lastRequest().method).toBe('PUT')
    expect(lastBody()).toEqual({ expectedRevision: execution.revision, enabled: false })
    const grant = await adapter.createGrant(GRANT_INPUT)
    await adapter.setGrantEnabled(grant.id, grant.revision, true)
    expect(lastRequest().url).toBe(`/api/agent/grants/${grant.id}/enabled`)
    expect(lastBody()).toEqual({ expectedRevision: grant.revision, enabled: true })
  })

  it('资源规则 POST 体无 expectedRevision，PUT 体平铺 expectedRevision', async () => {
    await adapter.createResourceRule(RULE_INPUT)
    expect(lastRequest().url).toBe('/api/agent/resource-rules')
    expect(lastRequest().method).toBe('POST')
    expect('expectedRevision' in lastBody()).toBe(false)
    expect('requestId' in lastBody()).toBe(false)
    const rule = await adapter.createResourceRule(RULE_INPUT)
    await adapter.updateResourceRule(rule.id, { ...RULE_INPUT, expectedRevision: rule.revision })
    expect(lastRequest().url).toBe(`/api/agent/resource-rules/${rule.id}`)
    expect(lastRequest().method).toBe('PUT')
    expect(lastBody().expectedRevision).toBe(rule.revision)
  })

  it('执行配置编辑体保留 id 字段（编号与路径一致性由前端拦截，适配器不静默改写）', async () => {
    const created = await adapter.createExecutionProfile(EXECUTION_INPUT)
    await adapter.updateExecutionProfile(created.id, { ...EXECUTION_INPUT, id: created.id, expectedRevision: created.revision })
    expect(lastBody().id).toBe(created.id)
    expect(lastRequest().url).toBe(`/api/agent/execution-profiles/${created.id}`)
  })

  it('parseAgentExecutionRuntime 接受 serverId/serverRevision 缺省并校验形状', () => {
    expect(parseAgentExecutionRuntime({ id: 'x1', containerId: 'c1', state: 'running' })).toEqual({
      id: 'x1', containerId: 'c1', state: 'running',
    })
    expect(parseAgentExecutionRuntime({ id: 'x2', containerId: 'c2', serverId: 's1', serverRevision: 3, state: 'stopping' }))
      .toEqual({ id: 'x2', containerId: 'c2', serverId: 's1', serverRevision: 3, state: 'stopping' })
    expect(() => parseAgentExecutionRuntime({ id: 'x3', containerId: 'c3' })).toThrow('Agent 执行器运行时响应无效')
    expect(() => parseAgentExecutionRuntime({ id: 'x4', containerId: 'c4', serverRevision: 0, state: 'running' }))
      .toThrow('Agent 执行器运行时响应无效')
  })
})

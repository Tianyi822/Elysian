import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentWorkbenchAdapterContract } from '../../agentWorkbenchAdapterContract'
import { resetAgentWorkbenchData, workbenchInternals } from '../../mock/agent/agentWorkbenchData'
import { createHttpAgentWorkbenchAdapter } from './agentWorkbenchHttpAdapter'

/*
 * HTTP 适配器测试分两层（沿 agentCapabilitiesHttpAdapter.test.ts 先例）：
 * 1. 契约断言：跑在与 mock 同一套 runAgentWorkbenchAdapterContract 上，fetch
 *    换成按 Go 路由表实现的内存假服务（路由到同一份 workbenchInternals 状态机，
 *    并对无 requestId 端点执行字段白名单——多带字段即 400，模拟 DisallowUnknownFields）；
 * 2. 接线断言：请求落点、方法、查询串与请求体形状——工作区 PUT 体必须是原始
 *    字节（Uint8Array，非 JSON/base64 包装），requestId 绝不出现在非白名单端点。
 */

type RecordedRequest = { url: string; method: string; body: unknown; contentType: string }

const STATUS_BY_CODE: Record<string, number> = {
  'not-found': 404,
  'session-busy': 409,
  'model-changed': 409,
  'request-conflict': 409,
  'revision-conflict': 409,
  'workspace-revision-conflict': 409,
  'task-busy': 409,
  'future-cursor': 400,
  'invalid-cursor': 400,
  'invalid-input': 400,
  'invalid-request': 400,
  'invalid-state': 409,
  'input-too-large': 413,
  'workspace-input': 400,
  'workspace-file-too-large': 413,
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(code: string, message: string): Response {
  return jsonResponse({ error: message, code }, STATUS_BY_CODE[code] ?? 400)
}

class AgentWorkbenchMockErrorShape extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function isDomainError(value: unknown): value is AgentWorkbenchMockErrorShape {
  return value instanceof AgentWorkbenchMockErrorShape || (value instanceof Error && 'code' in value)
}

/** 内存假服务：按 agent_routes/capability_routes/wiki_routes 的路径与体形状分发。 */
function makeFakeWorkbenchServer(): { fetchMock: ReturnType<typeof vi.fn>; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url)
    const [path = '', query = ''] = url.split('?')
    const method = (init?.method ?? 'GET').toUpperCase()
    const params = new URLSearchParams(query)
    const bodyText = typeof init?.body === 'string' ? init.body : init?.body instanceof Uint8Array ? init.body : undefined
    const contentType = new Headers(init?.headers).get('content-type') ?? ''
    requests.push({ url, method, body: bodyText, contentType })

    const readJson = (): Record<string, unknown> => {
      if (contentType !== 'application/json') throw new Response(JSON.stringify({ error: '请求必须使用 application/json', code: 'invalid-request' }), { status: 400 })
      return JSON.parse(typeof init?.body === 'string' ? init.body : '')
    }
    const whitelist = (allowed: readonly string[]): Response | undefined => {
      const body = readJson()
      for (const key of Object.keys(body)) {
        if (!allowed.includes(key)) {
          return errorResponse('invalid-request', '请求字段无效或含未声明的字段')
        }
      }
      return undefined
    }
    const guard = (run: () => unknown, status = 200): Response => {
      try {
        return jsonResponse(run(), status)
      } catch (error) {
        if (isDomainError(error)) return errorResponse(error.code, error.message)
        throw error
      }
    }
    const segments = path.replace('/api/agent/', '').split('/')
    const cursor = params.get('cursor') ?? undefined
    const limitParam = params.get('limit')
    const limit = limitParam === null ? undefined : Number(limitParam)
    const page = { cursor, limit }
    const domain = workbenchInternals

    // —— 会话域 ——
    if (segments[0] === 'sessions' && segments.length === 2 && method === 'GET') {
      return guard(() => domain.getSession(segments[1] ?? ''))
    }
    if (segments[0] === 'sessions' && segments.length === 1) {
      if (method === 'GET') return guard(() => domain.listSessionsPage(page))
      if (method === 'POST') {
        const rejected = whitelist(['title', 'modelProfileId', 'modelRevision'])
        if (rejected !== undefined) return rejected
        const body = readJson()
        return guard(() => domain.createSession({
          title: String(body.title ?? ''),
          modelProfileId: String(body.modelProfileId ?? ''),
          modelRevision: Number(body.modelRevision ?? 0),
        }), 201)
      }
    }
    if (segments[0] === 'sessions' && segments.length >= 3) {
      const id = segments[1] ?? ''
      if (segments[2] === 'model' && method === 'PUT') {
        const rejected = whitelist(['modelProfileId', 'modelRevision'])
        if (rejected !== undefined) return rejected
        const body = readJson()
        return guard(() => domain.switchModel(id, {
          modelProfileId: String(body.modelProfileId ?? ''),
          modelRevision: Number(body.modelRevision ?? 0),
        }))
      }
      if (segments[2] === 'messages' && method === 'GET') {
        return guard(() => domain.listMessagesPage(id, { after: params.get('after') ?? undefined, limit }))
      }
      if (segments[2] === 'tasks' && method === 'GET') {
        return guard(() => domain.listTasksPage(id, page))
      }
      if (segments[2] === 'tasks' && method === 'POST') {
        // AgentInput 声明 requestId（白名单端点）。
        const rejected = whitelist(['requestId', 'content', 'skills', 'resources', 'prompts'])
        if (rejected !== undefined) return rejected
        return guard(() => domain.createTask(id, readJson() as never), 202)
      }
      if (segments[2] === 'memory' && method === 'GET') {
        return guard(() => domain.readMemorySelection(id))
      }
      if (segments[2] === 'memory' && method === 'PUT') {
        const rejected = whitelist(['spaceId', 'includeGlobal'])
        if (rejected !== undefined) return rejected
        const body = readJson()
        return guard(() => domain.writeMemorySelection(id, {
          spaceId: String(body.spaceId ?? ''),
          includeGlobal: body.includeGlobal === true,
        }))
      }
      if (segments[2] === 'environment' && method === 'GET') {
        return guard(() => domain.getEnvironment(id))
      }
      if (segments[2] === 'environment' && method === 'PUT') {
        const rejected = whitelist(['expectedRevision', 'environment'])
        if (rejected !== undefined) return rejected
        const body = readJson()
        return guard(() => domain.updateEnvironment(id, Number(body.expectedRevision ?? 0), body.environment as never))
      }
    }
    // —— 任务域 ——
    if (segments[0] === 'tasks' && segments.length >= 2) {
      const id = segments[1] ?? ''
      if (segments.length === 2 && method === 'GET') return guard(() => domain.getTask(id))
      if (segments[2] === 'runs' && method === 'POST') {
        const rejected = whitelist(['requestId', 'content', 'skills', 'resources', 'prompts'])
        if (rejected !== undefined) return rejected
        return guard(() => domain.continueRun(id, readJson() as never), 202)
      }
      if (segments.length === 2 && method === 'POST') {
        const rejected = whitelist(['requestId', 'content', 'skills', 'resources', 'prompts'])
        if (rejected !== undefined) return rejected
        return guard(() => domain.createTask(id, readJson() as never), 202)
      }
      if (segments[2] === 'memory' && method === 'GET') return guard(() => domain.getWorkingMemory(id))
      if (segments[2] === 'workspace') {
        const filePath = params.get('path')
        const expected = params.get('expectedRevision')
        if (method === 'GET') {
          return guard(() => filePath === null ? domain.listWorkspace(id) : domain.readWorkspaceFile(id, filePath))
        }
        if (method === 'PUT') {
          // 服务端把原始字节直接交给 WriteWorkspace：这里必须收到原始字节视图，
          // 不能是 JSON 字符串或 base64 文本（跨 realm 用 ArrayBuffer.isView 判）。
          const rawBody = init?.body
          const isRawBytes = typeof rawBody === 'object' && rawBody !== null && ArrayBuffer.isView(rawBody) && !(rawBody instanceof DataView)
          if (!isRawBytes || typeof rawBody === 'string') {
            return errorResponse('invalid-request', '工作区写入体必须是原始字节')
          }
          return guard(() => domain.writeWorkspaceFile(id, filePath ?? '', Number(expected ?? -1), new Uint8Array((rawBody as Uint8Array).buffer, (rawBody as Uint8Array).byteOffset, (rawBody as Uint8Array).byteLength)))
        }
        if (method === 'DELETE') {
          return guard(() => domain.deleteWorkspaceFile(id, filePath ?? '', Number(expected ?? -1)))
        }
      }
    }
    // —— 运行域（仅本模块消费的模型请求分页）——
    if (segments[0] === 'runs' && segments.length === 3 && segments[2] === 'model-requests' && method === 'GET') {
      return guard(() => domain.listModelRequestsPage(segments[1] ?? '', page))
    }
    return errorResponse('not-found', `测试假服务未登记路由：${method} ${url}`)
  })
  return { fetchMock, requests }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T08:00:00Z'))
  resetAgentWorkbenchData(new Date())
  fetchMock.mockClear()
  requests.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const { fetchMock, requests } = makeFakeWorkbenchServer()

runAgentWorkbenchAdapterContract(
  'HTTP Ely 工作台（内存假服务）',
  () => {
    vi.stubGlobal('fetch', fetchMock)
    return createHttpAgentWorkbenchAdapter()
  },
  { advance: async (ms) => { await vi.advanceTimersByTimeAsync(ms) } },
)

describe('HTTP 接线断言', () => {
  it('会话创建请求落到 POST /api/agent/sessions，体只带声明字段且无 requestId', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    await adapter.createSession({ title: '接线会话', modelProfileId: 'profile-1', modelRevision: 2 })
    const hit = requests.find((request) => request.url === '/api/agent/sessions' && request.method === 'POST')
    expect(hit).toBeDefined()
    expect(hit?.contentType).toBe('application/json')
    expect(JSON.parse(String(hit?.body))).toEqual({ title: '接线会话', modelProfileId: 'profile-1', modelRevision: 2 })
    expect(String(hit?.body)).not.toContain('requestId')
  })

  it('记忆空间与环境更新体形状与 expectedRevision 位置正确', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    await adapter.writeSessionMemorySelection('session-1', { spaceId: 'space-2', includeGlobal: false })
    const memoryHit = requests.find((request) => request.url === '/api/agent/sessions/session-1/memory' && request.method === 'PUT')
    expect(JSON.parse(String(memoryHit?.body))).toEqual({ spaceId: 'space-2', includeGlobal: false })

    const environment = await adapter.getSessionEnvironment('session-1')
    await adapter.updateSessionEnvironment('session-1', environment.revision, environment)
    const envHit = requests.find((request) => request.url === '/api/agent/sessions/session-1/environment' && request.method === 'PUT')
    const body = JSON.parse(String(envHit?.body)) as { expectedRevision?: unknown; environment?: unknown }
    expect(body.expectedRevision).toBe(environment.revision)
    expect(body.environment).toEqual(JSON.parse(JSON.stringify(environment)))
    expect(String(envHit?.body)).not.toContain('requestId')
  })

  it('消息增量查询带 after 游标；模型请求分页带 cursor', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    await adapter.listMessages('session-1', { after: '2' })
    expect(requests.some((request) => request.url === '/api/agent/sessions/session-1/messages?after=2' && request.method === 'GET')).toBe(true)
    await adapter.listModelRequests('run-1', { cursor: '0', limit: 20 })
    expect(requests.some((request) => request.url === '/api/agent/runs/run-1/model-requests?cursor=0&limit=20')).toBe(true)
  })

  it('新建任务体携带 requestId（白名单端点），续轮落到 POST /tasks/{id}/runs', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    const run = await adapter.createTask('session-1', { requestId: 'wire-create-1', content: '接线任务' })
    const createHit = requests.find((request) => request.url === '/api/agent/sessions/session-1/tasks' && request.method === 'POST')
    expect(JSON.parse(String(createHit?.body))).toEqual({ requestId: 'wire-create-1', content: '接线任务' })
    await vi.advanceTimersByTimeAsync(6500)
    await adapter.continueRun(run.taskId, { requestId: 'wire-continue-1', content: '接线续轮' })
    expect(requests.some((request) => request.url === `/api/agent/tasks/${run.taskId}/runs` && request.method === 'POST')).toBe(true)
  })

  it('工作区写入体为原始字节：Uint8Array 逐字节一致，不经 JSON/base64 包装', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    const run = await adapter.createTask('session-1', { requestId: 'wire-ws-1', content: '工作区接线' })
    await vi.advanceTimersByTimeAsync(6500)
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x0a, 0xe4, 0xb8, 0xad, 0x00, 0xff])
    await adapter.writeWorkspaceFile(run.taskId, 'dir/文件 名.json', 0, bytes)
    const put = requests.find((request) => request.method === 'PUT' && request.url.includes('/workspace?'))
    expect(put).toBeDefined()
    expect(put?.url).toBe(`/api/agent/tasks/${run.taskId}/workspace?path=${encodeURIComponent('dir/文件 名.json')}&expectedRevision=0`)
    // 断言体未被包装：fetch 收到的就是原始 Uint8Array（sendRawBytes 直发）。
    const raw = (fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT' && String(call[0]).includes('/workspace?'))?.[1] as RequestInit | undefined)?.body
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(Array.from(raw as Uint8Array)).toEqual(Array.from(bytes))
    // 回读内容与提交字节完全一致（PUT/GET 体不对称回归）。
    const read = await adapter.readWorkspaceFile(run.taskId, 'dir/文件 名.json')
    const decoded = Uint8Array.from(atob(read.content ?? ''), (char) => char.charCodeAt(0))
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })

  it('工作区删除带查询参数且无请求体；列表与单文件读取路径分开', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const adapter = createHttpAgentWorkbenchAdapter()
    await adapter.deleteWorkspaceFile('task-1', 'notes/summary.md', 1)
    const del = requests.find((request) => request.method === 'DELETE' && request.url.includes('/workspace?'))
    expect(del?.url).toBe(`/api/agent/tasks/task-1/workspace?path=${encodeURIComponent('notes/summary.md')}&expectedRevision=1`)
    const delInit = (fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE' && String(call[0]).includes('/workspace?'))?.[1] as RequestInit | undefined)
    expect(delInit?.body === undefined || delInit?.body instanceof Uint8Array).toBe(true)
    await adapter.listWorkspace('task-1')
    expect(requests.some((request) => request.url === '/api/agent/tasks/task-1/workspace' && request.method === 'GET')).toBe(true)
    await adapter.readWorkspaceFile('task-1', 'raw/containers.json')
    expect(requests.some((request) => request.url === `/api/agent/tasks/task-1/workspace?path=${encodeURIComponent('raw/containers.json')}`)).toBe(true)
  })
})

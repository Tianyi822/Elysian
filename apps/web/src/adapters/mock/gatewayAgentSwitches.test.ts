import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { resetAgentMemoryData } from './agent/agentMemoryMockAdapter'

afterEach(() => vi.unstubAllGlobals())

const ALL_CAPS = {
  batch: { available: true }, agent: { available: true }, skills: { available: true },
  mcp: { available: true }, containerExecution: { available: true }, approvals: { available: true },
  workflow: { available: true }, wiki: { available: true }, embedding: { available: true },
  workflowV2: { available: true }, resourceLocks: { available: true }, executionRuntimes: { available: true },
}

const RUNTIME_INFO_BODY = {
  available: true, worker: 'ready', storage: 'ready', tools: [], queueDepth: 0,
  limits: {
    concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
    callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
    runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
    retentionDays: 30, cancelGraceSeconds: 5,
  },
  ...ALL_CAPS,
}

describe('Gateway Agent 七域分流', () => {
  it('缺省全 mock：运行时报告 available:true 全能力位，演示可走通', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const info = await gateway.agentRuns.runtime()
    expect(info.available).toBe(true)
    for (const key of Object.keys(ALL_CAPS) as (keyof typeof ALL_CAPS)[]) {
      expect(info[key].available, key).toBe(true)
    }
  })

  it('缺省 mock 的长期记忆：确定性种子、未建索引即降级文本检索、未知页面明确报错', async () => {
    resetAgentMemoryData()
    const gateway = createMockGateway({ eventStream: 'memory' })
    // 演示实现未接真实读取接口（available:false 只是标注，不代表服务端健康）。
    expect(gateway.agentMemory.available).toBe(false)
    const spaces = await gateway.agentMemory.listSpaces()
    expect(spaces.length).toBeGreaterThan(0)
    expect(spaces.filter((space) => space.kind === 'global')).toHaveLength(1)
    const search = await gateway.agentMemory.search('space-1', '端口')
    expect(search.degraded).toBe(true)
    expect(typeof search.reason).toBe('string')
    await expect(gateway.agentMemory.getPage('space-1', 'page-missing')).rejects.toThrow('Wiki 页面不存在')
    await expect(gateway.agentMemory.getPageRevision('space-1', 'page-a', 99)).rejects.toThrow('Wiki 页面修订不存在')
  })

  it('agentRuns: http 只换运行记录域，请求落到 /api/agent/runtime，其余域仍 mock', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(RUNTIME_INFO_BODY), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', agentRuns: 'http' })
    const info = await gateway.agentRuns.runtime()
    expect(info.available).toBe(true)
    expect(info.workflowV2.available).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/runtime', expect.objectContaining({ cache: 'no-store' }))
    // 其他域未被波及：记忆仍为演示实现（可用位 false，种子确定性）。
    expect(gateway.agentMemory.available).toBe(false)
    expect((await gateway.agentMemory.listSpaces()).length).toBeGreaterThan(0)
  })

  it('agentMemory: http 接通真实读取端点，演示语义消失', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', agentMemory: 'http' })
    expect(gateway.agentMemory.available).toBe(true)
    expect(await gateway.agentMemory.listSpaces()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/memory-spaces', expect.objectContaining({ cache: 'no-store' }))
    // 运行记录域仍 mock。
    expect(await gateway.agentRuns.runtime()).toMatchObject({ available: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('agentCapabilities: http 接通模型与执行配置端点，请求落到 /api/agent/model-profiles', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', agentCapabilities: 'http' })
    expect(await gateway.agentCapabilities.listModelProfiles()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/model-profiles', expect.objectContaining({ cache: 'no-store' }))
    // 运行记录域仍 mock。
    expect(await gateway.agentRuns.runtime()).toMatchObject({ available: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('agentExtensions: http 接通技能目录端点，请求落到 /api/agent/skills', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', agentExtensions: 'http' })
    expect(await gateway.agentExtensions.listSkills()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/skills', expect.objectContaining({ cache: 'no-store' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('agentApprovals: http 接通审批列表端点，请求落到 /api/agent/approvals', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', agentApprovals: 'http' })
    expect(await gateway.agentApprovals.listApprovals()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/approvals', expect.objectContaining({ cache: 'no-store' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 未显式切 http 的域保持 mock：运行时报告可用，且不产生新请求。
    expect(await gateway.agentRuns.runtime()).toMatchObject({ available: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['agentWorkbench', 'listSessions', { items: [], nextCursor: '', hasMore: false }, '/api/agent/sessions'],
    ['agentWorkflows', 'listDefinitions', [], '/api/agent/workflow-definitions'],
  ] as const)('%s: http 请求对应端点，同片其余域保持 mock', async (domain, method, response, url) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', [domain]: 'http' })
    const domainAdapter = gateway[domain] as unknown as Record<string, () => Promise<unknown>>
    await expect(domainAdapter[method]?.()).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ cache: 'no-store' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 未显式切 http 的域保持 mock：运行时报告可用、记忆为演示实现。
    expect(await gateway.agentRuns.runtime()).toMatchObject({ available: true })
    expect(gateway.agentMemory.available).toBe(false)
  })
})

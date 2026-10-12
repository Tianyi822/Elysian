import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAgentRuntime, parseAgentRuntimeInfo } from './agentRuntimeHttp'
import { stubAgentJsonFetch } from '../../../test/agentTestUtils'

afterEach(() => vi.unstubAllGlobals())

const CAPS = {
  batch: { available: true }, agent: { available: true }, skills: { available: true },
  mcp: { available: false, reason: '未配置' }, containerExecution: { available: true },
  approvals: { available: true }, workflow: { available: true }, wiki: { available: true },
  embedding: { available: false, reason: '未配置 Embedding' }, workflowV2: { available: true },
  resourceLocks: { available: true }, executionRuntimes: { available: true },
}

const INFO_BODY = {
  available: true, worker: 'ready', storage: 'ready', queueDepth: 2,
  tools: [{ name: 'docker_containers_list', description: '列出容器视图', parameters: { type: 'object' } }],
  limits: {
    concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
    callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
    runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
    retentionDays: 30, cancelGraceSeconds: 5, tokenBudget: 128000,
  },
  ...CAPS,
}

describe('parseAgentRuntimeInfo', () => {
  it('解析 12 能力位、限额与工具描述，缺 reason 的能力位保持只有 available', () => {
    const info = parseAgentRuntimeInfo(INFO_BODY)
    expect(info.available).toBe(true)
    expect(info.worker).toBe('ready')
    expect(info.storage).toBe('ready')
    expect(info.queueDepth).toBe(2)
    expect(info.limits.tokenBudget).toBe(128000)
    expect(info.limits.userBytes).toBeUndefined()
    expect(info.mcp).toEqual({ available: false, reason: '未配置' })
    expect(info.batch).toEqual({ available: true })
    expect(info.tools).toHaveLength(1)
    expect(info.tools[0]?.name).toBe('docker_containers_list')
    const keys = ['batch', 'agent', 'skills', 'mcp', 'containerExecution', 'approvals', 'workflow',
      'wiki', 'embedding', 'workflowV2', 'resourceLocks', 'executionRuntimes'] as const
    for (const key of keys) expect(info[key], key).toBeDefined()
  })

  it('缺任一能力位即形状漂移，抛中文错误', () => {
    const broken = { ...INFO_BODY }
    delete (broken as Record<string, unknown>).workflowV2
    expect(() => parseAgentRuntimeInfo(broken)).toThrow('Agent 运行时能力位 workflowV2 无效')
  })

  it('限额缺必填字段或非安全整数即拒绝', () => {
    const broken = { ...INFO_BODY, limits: { ...INFO_BODY.limits, concurrency: 1.5 } }
    expect(() => parseAgentRuntimeInfo(broken)).toThrow('Agent 运行时限额无效')
    const missing = { ...INFO_BODY, limits: { ...INFO_BODY.limits, queueCapacity: undefined } }
    expect(() => parseAgentRuntimeInfo(missing)).toThrow('Agent 运行时限额无效')
  })
})

describe('fetchAgentRuntime', () => {
  it('请求落到 /api/agent/runtime，不带任何查询参数', async () => {
    const fetchMock = stubAgentJsonFetch({ '/api/agent/runtime': INFO_BODY })
    vi.stubGlobal('fetch', fetchMock)
    const info = await fetchAgentRuntime()
    expect(info.available).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/agent/runtime')
  })
})

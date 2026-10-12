import { describe, expect, it } from 'vitest'
import type { AgentExecutionProfileInput, AgentModelProfileInput } from '@elysian/contracts'
import { runAgentCapabilitiesAdapterContract } from '../../agentCapabilitiesAdapterContract'
import { AgentCapabilitiesMockAdapter } from './agentCapabilitiesMockAdapter'
import {
  AgentCapabilitiesMockError,
  mockCreateExecutionProfile,
  mockCreateModelProfile,
  mockGetExecutionProfile,
  mockGetModelProfile,
  mockGetResourceRule,
  mockListExecutionProfiles,
  mockListExecutionRuntimes,
  mockListGrants,
  mockListModelProfiles,
  mockListResourceRules,
  resetAgentCapabilitiesData,
} from './agentCapabilitiesData'

/** 契约断言在 mock 实现上运行（beforeEach 复位回种子，互不串扰）。 */
runAgentCapabilitiesAdapterContract('mock 数据集', () => {
  resetAgentCapabilitiesData()
  return new AgentCapabilitiesMockAdapter()
})

const MODEL_INPUT: AgentModelProfileInput = {
  name: '数据集测试模型',
  baseUrl: 'https://api.example.com/v1',
  model: 'dataset-test-model',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32000,
  outputTokens: 2048,
  capabilities: { text: true, tools: false, source: '数据集测试' },
  active: true,
}

const EXECUTION_INPUT: AgentExecutionProfileInput = {
  enabled: true,
  name: '时钟测试',
  image: `registry.example.com/elysian/clock@sha256:${'ab12cd34'.repeat(8)}`,
  runtime: 'bash',
  command: ['bash', '-'],
  timeoutSeconds: 30,
  cpuMillis: 100,
  memoryBytes: 67108864,
  pids: 16,
  expectedRevision: 0,
}

describe('agentCapabilitiesData 种子与状态机', () => {
  it('种子列表各取最新修订且确定性可复现', () => {
    resetAgentCapabilitiesData()
    const first = mockListModelProfiles()
    expect(first.map((item) => `${item.id}@${item.revision}`)).toEqual([
      'mp-ely-main@3', 'mp-ollama-local@1', 'mp-deepseek-backup@2',
    ])
    resetAgentCapabilitiesData()
    expect(mockListModelProfiles()).toEqual(first)
    expect(mockListExecutionProfiles().map((item) => `${item.id}@${item.revision}`)).toContain('ep-python-tools@2')
    expect(mockListGrants().map((item) => `${item.id}@${item.revision}`)).toContain('eg-project-readonly@2')
    expect(mockListResourceRules().map((item) => `${item.id}@${item.revision}`)).toEqual([
      'rr-registry-mirror@2', 'rr-script-config@1',
    ])
    expect(mockListExecutionRuntimes()).toHaveLength(1)
  })

  it('凭据只写不回显：hasCredential 布尔准确，无 credential 字段', () => {
    resetAgentCapabilitiesData()
    const withSecret = mockCreateModelProfile({ ...MODEL_INPUT, credential: 'dataset-secret' })
    expect(withSecret.hasCredential).toBe(true)
    expect(Object.hasOwn(withSecret as unknown as Record<string, unknown>, 'credential')).toBe(false)
    const without = mockCreateModelProfile(MODEL_INPUT)
    expect(without.hasCredential).toBe(false)
  })

  it('新建使用确定性编号与演示时钟，刷新（复位）后回到种子', () => {
    resetAgentCapabilitiesData()
    const created = mockCreateModelProfile({ ...MODEL_INPUT, credential: 'x' })
    expect(created.id).toBe('mp-100')
    const execution = mockCreateExecutionProfile(EXECUTION_INPUT)
    expect(execution.id).toBe('ep-101')
    expect(execution.createdAt).toBe('2026-10-11T09:00:00.000Z')
    expect(mockGetExecutionProfile('ep-101').createdAt).toBe('2026-10-11T09:00:00.000Z')
    resetAgentCapabilitiesData()
    expect(mockListModelProfiles().some((item) => item.id === 'mp-100')).toBe(false)
  })

  it('历史修订保留：按修订读取返回当次事实', () => {
    resetAgentCapabilitiesData()
    expect(mockGetModelProfile('mp-ely-main', 1).contextTokens).toBe(128000)
    expect(mockGetModelProfile('mp-ely-main', 3).contextTokens).toBe(200000)
    expect(mockGetResourceRule('rr-registry-mirror', 1).mappings).toHaveLength(1)
    expect(mockGetResourceRule('rr-registry-mirror', 2).mappings).toHaveLength(2)
  })

  it('形状错误抛 AgentCapabilitiesMockError（带 status 与 code）', () => {
    resetAgentCapabilitiesData()
    expect(() => mockGetModelProfile('mp-missing')).toThrow(AgentCapabilitiesMockError)
    try {
      mockGetModelProfile('mp-missing')
    } catch (error) {
      expect((error as AgentCapabilitiesMockError).status).toBe(404)
      expect((error as AgentCapabilitiesMockError).code).toBe('profile-not-found')
    }
  })
})

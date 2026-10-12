import { describe, expect, it } from 'vitest'
import {
  parseAgentExecutionGrant,
  parseAgentExecutionProfile,
  parseAgentMCPServer,
  parseAgentModelProfile,
  parseAgentModelCapabilities,
  parseAgentResourceRule,
  parseAgentRevisionRef,
  parseAgentSkill,
} from './agentCatalogParse'
import capabilitiesFixture from '../../../../../../packages/foundation/contracts/fixtures/agent-capabilities.json'

describe('目录共享 parse', () => {
  it('完整保留高级能力，兼容缺省字段，拒绝非法布尔与推理等级', () => {
    const legacy = { text: false, tools: true, source: '配置' }
    expect(parseAgentModelCapabilities(legacy)).toEqual(legacy)
    const extended = { ...legacy, image: true, video: false, pdf: true, structuredOutput: true, webSearch: false, systemMessages: false, reasoningLevels: ['low', 'medium', 'xhigh'] }
    expect(parseAgentModelCapabilities(extended)).toEqual(extended)
    for (const field of ['image', 'video', 'pdf', 'structuredOutput', 'webSearch', 'systemMessages']) expect(() => parseAgentModelCapabilities({ ...legacy, [field]: 'yes' })).toThrow('模型能力无效')
    for (const reasoningLevels of [['low', 'low'], ['a'.repeat(33)], ['with space'], Array(17).fill('high'), 'high']) expect(() => parseAgentModelCapabilities({ ...legacy, reasoningLevels })).toThrow('模型推理等级无效')
  })
  it('技能、MCP 服务、执行配置与授权与共享 fixture 对齐', () => {
    expect(parseAgentSkill(capabilitiesFixture.skill)).toEqual(capabilitiesFixture.skill)
    expect(parseAgentMCPServer(capabilitiesFixture.mcpServer)).toEqual(capabilitiesFixture.mcpServer)
    expect(parseAgentMCPServer(capabilitiesFixture.mcpStdioServer)).toEqual(capabilitiesFixture.mcpStdioServer)
    expect(parseAgentExecutionProfile(capabilitiesFixture.executionProfile)).toEqual(capabilitiesFixture.executionProfile)
    expect(parseAgentExecutionGrant(capabilitiesFixture.grant)).toEqual(capabilitiesFixture.grant)
  })

  it('模型 Profile 校验能力声明与凭据不回显位', () => {
    const profile = {
      id: 'profile-1', revision: 2, name: '测试模型', baseUrl: 'https://model.example.test/v1',
      model: 'test-model', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096,
      capabilities: { text: true, tools: true, source: '用户配置' }, active: true, hasCredential: true,
    }
    expect(parseAgentModelProfile(profile)).toEqual(profile)
    expect(parseAgentModelProfile({ ...profile, provider: 'deepseek' }).provider).toBe('deepseek')
    expect(() => parseAgentModelProfile({ ...profile, provider: 'unknown' })).toThrow('Agent 模型供应商无效')
    expect(() => parseAgentModelProfile({ ...profile, provider: undefined })).toThrow('Agent 模型供应商无效')
    expect(() => parseAgentModelProfile({ ...profile, capabilities: { text: true, tools: 'yes', source: 'x' } }))
      .toThrow('Agent 模型能力无效')
    expect(() => parseAgentModelProfile({ ...profile, revision: 0 })).toThrow('Agent 模型配置响应无效')
  })

  it('修订引用 digest 可选；技能来源 kind 三选一', () => {
    expect(parseAgentRevisionRef({ id: 's1', revision: 1 })).toEqual({ id: 's1', revision: 1 })
    expect(parseAgentRevisionRef({ id: 's1', revision: 1, digest: 'd' })).toEqual({ id: 's1', revision: 1, digest: 'd' })
    expect(() => parseAgentRevisionRef({ id: 's1' })).toThrow('Agent 修订引用无效')
    expect(() => parseAgentSkill({ ...capabilitiesFixture.skill, source: { kind: 'http' } })).toThrow('Agent 技能来源无效')
  })

  it('MCP 公开投影不含凭据与容器环境；transport 与 stdio 规格校验', () => {
    const server = parseAgentMCPServer(capabilitiesFixture.mcpStdioServer)
    expect(server.stdio).toBeDefined()
    expect(server.stdio).not.toHaveProperty('environment')
    expect(() => parseAgentMCPServer({ ...capabilitiesFixture.mcpServer, transport: 'grpc' })).toThrow('Agent MCP 服务响应无效')
    expect(() => parseAgentMCPServer({
      ...capabilitiesFixture.mcpStdioServer,
      stdio: { ...capabilitiesFixture.mcpStdioServer.stdio, command: 'python3' },
    })).toThrow('Agent MCP 容器规格无效')
  })

  it('资源规则映射 literal 与 pointer 二选一，selector 来源四选一', () => {
    const rule = {
      id: 'rule-1', revision: 1, digest: 'rule-digest', createdAt: '2026-10-10T00:00:00Z',
      name: '状态资源', enabled: true, complete: false,
      selector: {
        source: 'mcp-resource',
        ref: { id: 'mcp-00000000000000000000000000000000', revision: 1 },
        originalName: 'status', catalogDigest: 'catalog-digest',
      },
      mappings: [
        { kind: 'status', authority: 'panel', access: 'read', literal: 'panel/status' },
        { kind: 'status', authority: 'runtime', access: 'write', pointer: '/status' },
      ],
    }
    expect(parseAgentResourceRule(rule)).toEqual(rule)
    expect(() => parseAgentResourceRule({
      ...rule,
      mappings: [{ kind: 'x', authority: 'y', access: 'read', literal: 'a', pointer: 'b' }],
    })).toThrow('Agent 资源规则映射的 literal 与 pointer 必须二选一')
    expect(() => parseAgentResourceRule({
      ...rule,
      mappings: [{ kind: 'x', authority: 'y', access: 'read' }],
    })).toThrow('Agent 资源规则映射的 literal 与 pointer 必须二选一')
    expect(() => parseAgentResourceRule({
      ...rule, selector: { ...rule.selector, source: 'shell' },
    })).toThrow('Agent 资源规则选择器无效')
  })
})

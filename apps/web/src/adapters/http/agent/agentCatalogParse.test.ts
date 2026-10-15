import { describe, expect, it } from 'vitest'
import { parseAgentModelProfile, parseAgentModelCapabilities } from './agentCatalogParse'

describe('模型目录响应解析', () => {
  it('完整保留高级能力，兼容缺省字段，拒绝非法布尔与推理等级', () => {
    const legacy = { text: false, tools: true, source: '配置' }
    expect(parseAgentModelCapabilities(legacy)).toEqual(legacy)
    const extended = { ...legacy, image: true, video: false, pdf: true, structuredOutput: true, webSearch: false, systemMessages: false, reasoningLevels: ['low', 'medium', 'xhigh'], defaultReasoningLevel: 'medium' }
    expect(parseAgentModelCapabilities(extended)).toEqual(extended)
    for (const field of ['image', 'video', 'pdf', 'structuredOutput', 'webSearch', 'systemMessages']) expect(() => parseAgentModelCapabilities({ ...legacy, [field]: 'yes' })).toThrow('模型能力无效')
    for (const reasoningLevels of [['low', 'low'], ['a'.repeat(33)], ['with space'], Array(17).fill('high'), 'high']) expect(() => parseAgentModelCapabilities({ ...legacy, reasoningLevels })).toThrow('模型推理等级无效')
    expect(() => parseAgentModelCapabilities({ ...legacy, reasoningLevels: ['low'], defaultReasoningLevel: 'BAD' })).toThrow('Agent 模型默认推理档位无效')
    expect(() => parseAgentModelCapabilities({ ...legacy, defaultReasoningLevel: 3 })).toThrow('Agent 模型默认推理档位无效')
  })
  it('模型 Profile 校验能力声明与凭据不回显位', () => {
    const profile = {
      id: 'profile-1', revision: 2, baseUrl: 'https://model.example.test/v1',
      model: 'test-model', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096,
      capabilities: { text: true, tools: true, source: '用户配置' }, active: true, hasCredential: true,
    }
    expect(parseAgentModelProfile(profile)).toEqual(profile)
    expect(parseAgentModelProfile({ ...profile, provider: 'deepseek' }).provider).toBe('deepseek')
    expect(parseAgentModelProfile({ ...profile, provider: 'zhipu' }).provider).toBe('zhipu')
    expect(() => parseAgentModelProfile({ ...profile, provider: 'unknown' })).toThrow('Agent 模型供应商无效')
    expect(() => parseAgentModelProfile({ ...profile, provider: undefined })).toThrow('Agent 模型供应商无效')
    expect(() => parseAgentModelProfile({ ...profile, capabilities: { text: true, tools: 'yes', source: 'x' } }))
      .toThrow('Agent 模型能力无效')
    expect(() => parseAgentModelProfile({ ...profile, revision: 0 })).toThrow('Agent 模型配置响应无效')
  })
})

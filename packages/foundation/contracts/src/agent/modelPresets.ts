import type { AgentModelCapabilities, AgentModelProvider } from './sessions.ts'

export type AgentModelPreset = {
  contextTokens: number
  outputTokens: number
  capabilities: AgentModelCapabilities
  documentationUrl: string
}

/** 官方参数核对于 2026-10-12（DeepSeek）与 2026-10-15（智谱）；只匹配明确标识，不按供应商猜测未知模型能力。 */
export function getAgentModelPreset(provider: AgentModelProvider, model: string): AgentModelPreset | undefined {
  if (provider === 'zhipu') {
    const id = model.trim().toLowerCase()
    if (id !== 'glm-5.3' && id !== 'glm-5.3-flash') return undefined
    return {
      contextTokens: 1_048_576,
      outputTokens: 131_072,
      capabilities: {
        text: true, tools: true, image: id === 'glm-5.3-flash', video: id === 'glm-5.3-flash', pdf: false,
        structuredOutput: true, webSearch: false, systemMessages: true,
        reasoningLevels: ['low', 'high', 'max'],
        defaultReasoningLevel: 'max',
        source: '智谱 BigModel 官方文档（2026-10-15）',
      },
      documentationUrl: 'https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8',
    }
  }
  if (provider !== 'deepseek') return undefined
  const id = model.trim()
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(id)
  if (!flash && id !== 'deepseek-v4-pro') return undefined
  return {
    contextTokens: 1_048_576,
    outputTokens: 393_216,
    capabilities: {
      text: true, tools: true, image: flash, video: false, pdf: false,
      structuredOutput: true, webSearch: false, systemMessages: true,
      reasoningLevels: ['disabled', 'low', 'high', 'max'],
      defaultReasoningLevel: 'high',
      source: 'DeepSeek 官方文档（2026-10-12）',
    },
    documentationUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  }
}

/** 自定义服务可声明自己的等级名称；只接受有界、可辨识的参数标识。 */
export function validAgentModelReasoningLevels(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 16 && new Set(value).size === value.length
    && value.every(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level))
}

/** 默认推理档必须是已声明档位之一；空串与 undefined 都视为未声明。 */
export function validAgentModelDefaultReasoningLevel(levels: readonly string[], value: unknown): boolean {
  return typeof value !== 'string' || value === '' || (levels.includes(value) && /^[a-z][a-z0-9_-]{0,31}$/.test(value))
}

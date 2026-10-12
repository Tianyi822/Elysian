import type { AgentModelCapabilities, AgentModelProvider } from './sessions.ts'

export type AgentModelPreset = {
  contextTokens: number
  outputTokens: number
  capabilities: AgentModelCapabilities
  documentationUrl: string
}

/** 官方参数核对于 2026-10-12；只匹配明确标识，不按供应商猜测未知模型能力。 */
export function getAgentModelPreset(provider: AgentModelProvider, model: string): AgentModelPreset | undefined {
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

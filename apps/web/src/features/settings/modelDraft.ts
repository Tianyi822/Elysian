import { getAgentModelPreset, type AgentDiscoveredModel, type AgentModelCapabilities, type AgentModelProfile, type AgentModelProvider } from '@elysian/contracts'

export type DraftModel = {
  key: string
  id?: string
  model: string
  contextTokens: string
  outputTokens: string
  text: boolean
  tools: boolean
  image: boolean
  video: boolean
  pdf: boolean
  structuredOutput: boolean
  webSearch: boolean
  systemMessages: boolean
  reasoningLevels: string[]
  source: string
  enabled: boolean
}

function capabilityDraft(capabilities: AgentModelCapabilities) {
  return {
    ...capabilities,
    image: capabilities.image ?? false,
    video: capabilities.video ?? false,
    pdf: capabilities.pdf ?? false,
    structuredOutput: capabilities.structuredOutput ?? false,
    webSearch: capabilities.webSearch ?? false,
    systemMessages: capabilities.systemMessages ?? false,
    reasoningLevels: [...(capabilities.reasoningLevels ?? [])],
  }
}

export function blankModel(): DraftModel {
  return {
    key: crypto.randomUUID(), model: '', contextTokens: '64000', outputTokens: '4096',
    ...capabilityDraft({ text: true, tools: true, structuredOutput: true, systemMessages: true, source: '默认配置' }), enabled: true,
  }
}

export function savedModelDraft(model: AgentModelProfile & { enabled: boolean }): DraftModel {
  return {
    key: model.id, id: model.id, model: model.model,
    contextTokens: String(model.contextTokens), outputTokens: String(model.outputTokens),
    ...capabilityDraft(model.capabilities), enabled: model.enabled,
  }
}

export function modelPresetDraft(provider: AgentModelProvider, model: string): Partial<DraftModel> | undefined {
  const preset = getAgentModelPreset(provider, model)
  if (!preset) return undefined
  return { contextTokens: String(preset.contextTokens), outputTokens: String(preset.outputTokens), ...capabilityDraft(preset.capabilities) }
}

export function discoveredModelDraft(provider: AgentModelProvider, model: AgentDiscoveredModel): DraftModel {
  const row = { ...blankModel(), ...modelPresetDraft(provider, model.model) }
  row.model = model.model
  row.contextTokens = String(model.contextTokens ?? Number(row.contextTokens))
  row.outputTokens = String(Math.min(model.outputTokens ?? Number(row.outputTokens), Number(row.contextTokens)))
  if (!getAgentModelPreset(provider, model.model)) row.source = '模型服务目录与默认配置'
  return row
}

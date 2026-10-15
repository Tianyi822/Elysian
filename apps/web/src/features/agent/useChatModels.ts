import { useCallback, useEffect, useState } from 'react'
import type { AgentModelProfile, AgentModelReasoningLevel } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'

export type ChatModelOption = {
  id: string
  model: string
  serviceName: string
  profile: AgentModelProfile
  reasoningLevels: readonly AgentModelReasoningLevel[]
  defaultReasoningLevel?: AgentModelReasoningLevel
}

type ChatModelsState = {
  models: readonly ChatModelOption[]
  status: 'loading' | 'ready' | 'error'
  error?: string
}

const REASONING_LABELS: Readonly<Record<string, string>> = {
  disabled: '关闭',
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
}

export function reasoningLabel(level: AgentModelReasoningLevel): string {
  return Object.hasOwn(REASONING_LABELS, level) ? REASONING_LABELS[level]! : level
}

/** 只从模型声明的档位中选择，不替未声明推理能力的模型补档位；默认档优先模型声明（官方预设按文档填入），未声明时优先「高」，其次 medium，否则取首项。 */
export function defaultReasoningLevel(levels: readonly AgentModelReasoningLevel[], declared?: AgentModelReasoningLevel): AgentModelReasoningLevel | undefined {
  if (declared && levels.includes(declared)) return declared
  return levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : levels[0]
}

/** 复用设置目录，只提供后端会话要求的文本与工具模型。 */
export function useChatModels(): ChatModelsState & { reload(): void } {
  const { modelSettings } = useGateway()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ChatModelsState>({ models: [], status: 'loading' })
  const reload = useCallback(() => setAttempt(value => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ ...previous, status: 'loading' }))
    void modelSettings.listModelServices(controller.signal).then(services => {
      if (controller.signal.aborted) return
      const models = services.filter(service => service.active).flatMap(service =>
        service.models.filter(profile => profile.active && profile.enabled && profile.capabilities.text && profile.capabilities.tools).map(profile => ({
          id: profile.id,
          model: profile.model,
          serviceName: service.name,
          profile,
          reasoningLevels: profile.capabilities.reasoningLevels ?? [],
          defaultReasoningLevel: (profile.capabilities.reasoningLevels ?? []).includes(profile.capabilities.defaultReasoningLevel ?? '') ? profile.capabilities.defaultReasoningLevel : undefined,
        })),
      )
      setState({ models, status: 'ready' })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState({ models: [], status: 'error', error: error instanceof Error ? error.message : '读取模型列表失败' })
    })
    return () => controller.abort()
  }, [modelSettings, attempt])

  return { ...state, reload }
}

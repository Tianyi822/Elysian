import type { AgentMessage, AgentMessageRunConfig } from '@elysian/contracts'
import { ArrowLeftRight } from '../../components/icons'
import { reasoningLabel } from './useChatModels'

function modelLabel(config: AgentMessageRunConfig): string {
  const name = (config.modelName ?? '').trim()
  if (!name) return ''
  const service = config.modelService?.trim()
  return service && service !== name && !name.includes(service) ? `${name}（${service}）` : name
}

function reasoningName(level?: string): string {
  return level ? reasoningLabel(level) : '默认'
}

/** 比较相邻两轮固定下来的模型与思考等级，返回轮次分隔线上的切换说明；旧记录缺快照时返回 null。 */
export function chatSwitchNotice(previous: AgentMessage | undefined, current: AgentMessage): string | null {
  const before = previous?.runConfig
  const after = current.runConfig
  if (!before || !after || !before.modelProfileId || !after.modelProfileId) return null
  const parts: string[] = []
  const beforeModel = modelLabel(before)
  const afterModel = modelLabel(after)
  if (before.modelProfileId !== after.modelProfileId || before.modelRevision !== after.modelRevision) {
    if (beforeModel && afterModel && beforeModel !== afterModel) parts.push(`模型已切换 ${beforeModel} → ${afterModel}`)
    else if (afterModel) parts.push(`模型配置已更新 ${afterModel}`)
  }
  const beforeReasoning = reasoningName(before.reasoningLevel)
  const afterReasoning = reasoningName(after.reasoningLevel)
  if (beforeReasoning !== afterReasoning) parts.push(`思考等级已切换 ${beforeReasoning} → ${afterReasoning}`)
  return parts.length ? parts.join(' · ') : null
}

export function ChatSwitchNotice({ text }: { text: string }) {
  return <div className="chat-switch-notice" role="note" aria-label="对话设置变更">
    <span><ArrowLeftRight size={14} aria-hidden />{text}</span>
  </div>
}

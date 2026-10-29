import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useSessionStore } from '../../stores/sessionStore'
import { AgentUnavailableState } from './AgentUnavailableState'
import { useSilentPolling } from './useSilentPolling'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'

/** 设置区的扩展入口复用内核门禁，域级故障由各分区独立显示。 */
export function ExtensionSettingsSection({ kind, active }: { kind: 'mcp' | 'skills'; active: boolean }) {
  const gateway = useGateway()
  const runtime = useAgentRuntimeStore()
  const phase = useSessionStore(state => state.phase)
  const demo = useSessionStore(state => state.mode === 'demo')
  useEffect(() => { if (runtime.status === 'idle') void runtime.load(gateway) }, [gateway, runtime.status, runtime.load])
  const { degraded } = useSilentPolling(signal => runtime.load(gateway, { silent: true, signal }), { intervalMs: 15000, enabled: active })
  useFeedbackMessage(active && degraded ? '运行时连接中断，正在重试' : null, 'warning')
  if (phase !== 'authed') return null
  if (runtime.status === 'idle' || runtime.status === 'loading') return <LoadingState />
  if (runtime.status === 'error' && !runtime.info) return <ErrorState title="Agent 运行时读取失败" description={runtime.errorMessage} onRetry={() => void runtime.load(gateway)} />
  if (!runtime.info?.available || runtime.unavailableReason) return <AgentUnavailableState reason={runtime.unavailableReason ?? runtime.info?.reason} worker={runtime.info?.worker} storage={runtime.info?.storage} />
  return <div className="space-y-3">{demo && <p className="text-xs text-fg-subtle">演示数据 · 配置与导入仅在当前浏览器内模拟</p>}{kind === 'mcp' ? <McpSection active={active} /> : <SkillsSection active={active} />}</div>
}

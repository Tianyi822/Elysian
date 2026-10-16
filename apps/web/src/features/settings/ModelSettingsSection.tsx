import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from './AgentUnavailableState'
import { useSilentPolling } from './useSilentPolling'
import { BusyVeil } from '../../components/RefreshState'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useModelSettingsStore } from '../../stores/modelSettingsStore'
import { ModelProfilesPanel } from './ModelProfilesPanel'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'

/** 仅模型设置依赖 Agent 内核；其他设置页签不受内核不可用影响。 */
export function ModelSettingsSection({ active }: { active: boolean }) {
  const gateway = useGateway()
  const runtime = useAgentRuntimeStore()
  const settings = useModelSettingsStore()
  useEffect(() => { void runtime.load(gateway) }, [gateway, runtime.load])
  useEffect(() => {
    if (runtime.status === 'ready' && runtime.info?.available) void settings.load(gateway)
  }, [gateway, runtime.status, runtime.info?.available, settings.load])
  const { degraded } = useSilentPolling((signal) => runtime.load(gateway, { silent: true, signal }), { intervalMs: 15_000, enabled: active })
  useFeedbackNotification(degraded ? '运行时连接中断，正在重试' : null, 'warning')
  const unavailableReason = runtime.unavailableReason ?? (runtime.info && !runtime.info.available ? runtime.info.reason : undefined)
  useFeedbackNotification(unavailableReason ? `模型运行时不可用：${unavailableReason}` : null, 'warning')
  if (runtime.status === 'idle' || runtime.status === 'loading') return <LoadingState />
  if (runtime.status === 'error') return <ErrorState title="模型运行时读取失败" description={runtime.errorMessage} onRetry={() => void runtime.load(gateway)} />
  if (!runtime.info?.available || runtime.unavailableReason) return <AgentUnavailableState reason={runtime.unavailableReason ?? runtime.info?.reason} worker={runtime.info?.worker} storage={runtime.info?.storage} />
  return <div className="flex flex-col gap-3">
    <div className="busy-host relative">
      <BusyVeil busy={settings.reloading} />
      {settings.status === 'idle' || settings.status === 'loading' ? <LoadingState label="正在读取模型配置…" /> : null}
      {settings.errorMessage ? <ErrorState title="模型配置读取失败" description={settings.errorMessage} onRetry={() => void settings.refresh(gateway)} /> : null}
      {settings.status === 'ready' ? <ModelProfilesPanel active={active} refreshing={settings.reloading} onRefresh={() => void settings.refresh(gateway)} /> : null}
    </div>
  </div>
}

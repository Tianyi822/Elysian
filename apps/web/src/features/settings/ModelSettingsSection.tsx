import { useEffect } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from './AgentUnavailableState'
import { useSilentPolling } from './useSilentPolling'
import { BusyVeil } from '../../components/RefreshState'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useModelSettingsStore } from '../../stores/modelSettingsStore'
import { ModelProfilesPanel } from './ModelProfilesPanel'

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
  if (runtime.status === 'idle' || runtime.status === 'loading') return <LoadingState />
  if (runtime.status === 'error') return <ErrorState description={runtime.errorMessage} onRetry={() => void runtime.load(gateway)} />
  if (!runtime.info?.available || runtime.unavailableReason) return <AgentUnavailableState reason={runtime.unavailableReason ?? runtime.info?.reason} worker={runtime.info?.worker} storage={runtime.info?.storage} />
  return <div className="flex flex-col gap-3">
    {degraded ? <p role="status" className="text-xs text-warning">运行时连接中断，正在重试</p> : null}
    <div className="busy-host relative">
      <BusyVeil busy={settings.reloading} />
      {settings.status === 'idle' || settings.status === 'loading' ? <LoadingState label="正在读取模型配置…" /> : null}
      {settings.errorMessage ? <ErrorState description={settings.errorMessage} onRetry={() => void settings.refresh(gateway)} /> : null}
      {settings.status === 'ready' ? <ModelProfilesPanel active={active} refreshing={settings.reloading} onRefresh={() => void settings.refresh(gateway)} /> : null}
    </div>
  </div>
}

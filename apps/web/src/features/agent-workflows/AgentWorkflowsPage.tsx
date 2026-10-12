import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP } from '../../components/formControl'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { DefinitionsSection } from './DefinitionsSection'
import { InstancesSection } from './InstancesSection'

/**
 * Ely 工作流页（agent-workflows 模块）。深链契约（模块间导航只许查询参数）：
 *   /agent/workflows?view=definitions|instances&instanceId=<instanceId>&nodeId=<nodeId>
 * 默认实例视图；instanceId 打开实例详情，nodeId 在执行树中定位高亮节点。
 * 六态：首次加载/内核不可用（/runtime available:false 的中文 reason）/空/错误/
 * 无权限（RequireArea 承接）/就绪（刷新只盖 BusyVeil，静默轮询不闪烁）。
 */
export function AgentWorkflowsPage() {
  const gateway = useGateway()
  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const load = useAgentRuntimeStore((state) => state.load)
  const reset = useAgentWorkflowsStore((state) => state.reset)
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  useEffect(() => () => reset(), [reset])

  const view = searchParams.get('view') === 'definitions' ? 'definitions' : 'instances'
  const instanceId = searchParams.get('instanceId') ?? ''

  const switchView = (next: 'definitions' | 'instances') => {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set('view', next)
      params.delete('instanceId')
      params.delete('nodeId')
      return params
    })
  }

  if (status === 'loading' || status === 'idle') return <LoadingState />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void load(gateway)} />
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }
  if (info?.workflow.available === false) {
    return (
      <AgentUnavailableState
        reason={info.workflow.reason ?? '工作流能力当前不可用'}
        worker={info.worker}
        storage={info.storage}
      />
    )
  }

  return (
    <section aria-label="工作流" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="工作流视图" className="flex flex-wrap items-center gap-1.5">
          <button type="button" aria-pressed={view === 'instances'} onClick={() => switchView('instances')} className={CTL_CHIP}>
            实例
          </button>
          <button type="button" aria-pressed={view === 'definitions'} onClick={() => switchView('definitions')} className={CTL_CHIP}>
            模板
          </button>
        </div>
      </div>
      {view === 'instances' ? <InstancesSection selectedInstanceId={instanceId} /> : <DefinitionsSection />}
    </section>
  )
}

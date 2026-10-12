import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP, CTL_GROUP } from '../../components/formControl'
import { Search } from '../../components/icons'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import {
  AGENT_CAPABILITIES_TABS,
  useAgentCapabilitiesStore,
  type AgentCapabilitiesTab,
} from '../../stores/agentCapabilitiesStore'
import { ExecutionProfilesPanel } from './ExecutionProfilesPanel'
import { ExecutionRuntimesPanel } from './ExecutionRuntimesPanel'
import { GrantsPanel } from './GrantsPanel'
import { ResourceRulesPanel } from './ResourceRulesPanel'

/**
 * 执行配置页（/agent/capabilities，所有权归 agent-capabilities 模块）。
 * 深链契约（模块内导航只许查询参数）：/agent/capabilities?tab=execution|grants|rules|runtimes
 * 四个页签分别是执行配置、目录与网络授权、资源规则与执行器运行时；
 * 修订详情、历史修订与编辑弹窗都在页签内完成，不新增路由。
 * 撤销操作归审批与治理页；本页对被撤销条目只做只读回显。
 */
export function AgentCapabilitiesPage() {
  const gateway = useGateway()
  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const loadRuntime = useAgentRuntimeStore((state) => state.load)

  const listStatus = useAgentCapabilitiesStore((state) => state.status)
  const listError = useAgentCapabilitiesStore((state) => state.errorMessage)
  const domainStates = useAgentCapabilitiesStore((state) => state.domainStates)
  const reloading = useAgentCapabilitiesStore((state) => state.reloading)
  const load = useAgentCapabilitiesStore((state) => state.load)

  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: AgentCapabilitiesTab = (AGENT_CAPABILITIES_TABS.some((item) => item.value === tabParam))
    ? (tabParam as AgentCapabilitiesTab)
    : 'execution'
  const activeDomain = domainStates[tab]

  useEffect(() => {
    void loadRuntime(gateway)
  }, [gateway, loadRuntime])

  useEffect(() => {
    if (status === 'ready' && info?.available) void load(gateway)
  }, [status, info?.available, gateway, load])

  if (status === 'loading' || status === 'idle') return <LoadingState />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void loadRuntime(gateway)} />
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }

  return (
    <div className="flex flex-col gap-4">
      <CapabilitiesToolbar tab={tab} onTabChange={(next) => setSearchParams(next === 'execution' ? {} : { tab: next }, { replace: true })} />
      <div className="busy-host relative flex flex-col">
        <BusyVeil busy={reloading} />
        {listStatus === 'loading' || listStatus === 'idle' ? <LoadingState label="正在读取配置目录…" /> : null}
        {listStatus === 'error' || (listStatus === 'ready' && activeDomain.status === 'error') ? (
          <ErrorState
            description={activeDomain.errorMessage ?? listError}
            onRetry={() => {
              void useAgentCapabilitiesStore.getState().refresh(gateway)
            }}
          />
        ) : null}
        {listStatus === 'ready' && activeDomain.status === 'ready' ? (
          <>
            {tab === 'execution' ? <ExecutionProfilesPanel /> : null}
            {tab === 'grants' ? <GrantsPanel /> : null}
            {tab === 'rules' ? <ResourceRulesPanel /> : null}
            {tab === 'runtimes' ? <ExecutionRuntimesPanel /> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

function CapabilitiesToolbar({
  tab,
  onTabChange,
}: {
  tab: AgentCapabilitiesTab
  onTabChange(next: AgentCapabilitiesTab): void
}) {
  const gateway = useGateway()
  const refresh = useAgentCapabilitiesStore((state) => state.refresh)
  const reloading = useAgentCapabilitiesStore((state) => state.reloading)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" aria-label="配置页签" className={`${CTL_GROUP} shrink-0`}>
        {AGENT_CAPABILITIES_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={item.value === tab}
            onClick={() => onTabChange(item.value)}
            className={CTL_CHIP}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {!isDockerRuntime() ? (
          <span role="status" className="text-xs text-fg-subtle">演示数据</span>
        ) : null}
        <RefreshButton
          label="刷新配置目录"
          onPress={() => {
            void refresh(gateway)
          }}
          busy={reloading}
        />
      </div>
    </div>
  )
}

/** 四域列表共用空态：过滤无结果与目录为空分开说明。 */
export function CapabilitiesEmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyState title={title} description={description} />
}

/** 名称过滤输入：四域共用形状（label 关联 + 图标仅装饰）。 */
export function CapabilitiesSearchInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string
  onChange(next: string): void
}) {
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-64">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        className="ctl-field h-9 w-full pl-8"
      />
    </div>
  )
}

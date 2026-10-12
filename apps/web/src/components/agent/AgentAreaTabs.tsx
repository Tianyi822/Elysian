import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { SelectDropdown } from '../SelectDropdown'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useSilentPolling } from './useSilentPolling'

/**
 * Ely 区页签切换：七个 Agent 页面共用一条顶栏页签，经各路由 handle 挂进标题位
 * （这些路由均声明 hideHeaderTitle）。选中态由地址派生——页签就是路由本身，
 * 不另设 store。形态按顶栏可用宽度决定：摆得下就摊开，摆不下收进浮层菜单，
 * 与 SecurityTabSwitch 同一形态（宽度由 app/layout/headerAccessoryWidth.ts 量出）。
 * 两种形态常驻 DOM、只切显示；收起菜单用 SelectDropdown，不锁页面滚动。
 */

export type AgentAreaTab =
  | 'workbench'
  | 'approvals'
  | 'runs'
  | 'workflows'
  | 'capabilities'
  | 'extensions'
  | 'memory'

export const AGENT_AREA_TABS: readonly { value: AgentAreaTab; label: string; path: string }[] = [
  { value: 'workbench', label: '工作台', path: '/agent' },
  { value: 'approvals', label: '审批与治理', path: '/agent/approvals' },
  { value: 'runs', label: '运行记录', path: '/agent/runs' },
  { value: 'workflows', label: '工作流', path: '/agent/workflows' },
  { value: 'capabilities', label: '执行配置', path: '/agent/capabilities' },
  { value: 'extensions', label: '技能与 MCP', path: '/agent/extensions' },
  { value: 'memory', label: '长期记忆', path: '/agent/memory' },
]

export function agentAreaTabForPath(pathname: string): AgentAreaTab {
  const suffix = pathname.replace(/^\/agent\/?/, '')
  const match = AGENT_AREA_TABS.find((tab) => tab.value === suffix)
  return match?.value ?? 'workbench'
}

export function AgentAreaTabs() {
  const gateway = useGateway()
  const loadRuntime = useAgentRuntimeStore((state) => state.load)
  const { degraded } = useSilentPolling(
    (signal) => loadRuntime(gateway, { silent: true, signal }),
    { intervalMs: 15_000 },
  )
  const location = useLocation()
  const navigate = useNavigate()
  const tab = agentAreaTabForPath(location.pathname)
  const setTab = (next: AgentAreaTab) => {
    const target = AGENT_AREA_TABS.find((item) => item.value === next)
    if (target) navigate(target.path)
  }
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)

  // 摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = flatWidth <= availableWidth

  return (
    <>
      {degraded ? <span role="status" className="sr-only">运行时连接中断，正在重试</span> : null}
      {/* 固有宽度探针：脱离布局，量出七项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <HeaderTabs items={AGENT_AREA_TABS} value={tab} onSelect={setTab} groupLabel="Ely 页签" />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <HeaderTabs items={AGENT_AREA_TABS} value={tab} onSelect={setTab} groupLabel="Ely 页签" />
      </div>

      <SelectDropdown
        ariaLabel="Ely 页签"
        align="end"
        items={AGENT_AREA_TABS}
        value={tab}
        onSelect={setTab}
        valueClassName="font-medium text-fg"
        triggerClassName={`${
          expanded ? 'hidden' : 'inline-flex'
        } shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`}
      />
    </>
  )
}

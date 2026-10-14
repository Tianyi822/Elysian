import { useRef } from 'react'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import type { HeaderTabItem } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { useNarrowViewport } from '../../app/layout/narrowViewport'
import { useGateway } from '../../adapters/GatewayProvider'
import { SelectDropdown } from '../../components/SelectDropdown'
import { CTL_SELECT } from '../../components/formControl'
import { useContainersStore } from '../../stores/containersStore'

/** 容器区视图页签：值与 containers store 的 view 取值一致。 */
const VIEW_TABS: readonly HeaderTabItem<'grid' | 'images' | 'apps'>[] = [
  { value: 'grid', label: '容器' },
  { value: 'images', label: '镜像' },
  { value: 'apps', label: '工作区' },
]

/**
 * 容器/镜像/工作区视图切换。经路由 handle 挂进顶栏，占据原本的标题位（该页经 handle 声明藏掉可视标题），
 * 与页内内容共用同一 store，视图状态不进 URL。
 *
 * 两条线决定形态：视口窄于 768px（见 app/layout/narrowViewport.ts）一律只显当前项、其余收进浮层菜单；
 * 宽屏下再看顶栏留给它的宽度——三项是一行短词，通常都摆得下，摆不下才收起（宽度由外壳量出，
 * 见 app/layout/headerAccessoryWidth.ts）。摊开所需宽度由隐藏探针量出，探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 收起后的菜单用 SelectDropdown，不用原生 select。
 */
export function ContainerViewSwitch() {
  const gateway = useGateway()
  const view = useContainersStore((s) => s.view)
  const setView = useContainersStore((s) => s.setView)
  const refreshImages = useContainersStore((s) => s.refreshImages)
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)
  const narrow = useNarrowViewport()

  // 窄屏不量宽度，直接收起；宽屏下摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = !narrow && flatWidth <= availableWidth

  const select = (next: (typeof VIEW_TABS)[number]['value']) => {
    setView(next)
    // 页签切换的自动刷新是静默的：成功不打扰，失败仍走危险通知；显式「刷新镜像」按钮才报成功。
    if (next === 'images' && useContainersStore.getState().status === 'ready') void refreshImages(gateway, { notify: false })
  }

  return (
    <>
      {/* 固有宽度探针：脱离布局，量出三项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <HeaderTabs items={VIEW_TABS} value={view} onSelect={select} groupLabel="视图切换" />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <HeaderTabs items={VIEW_TABS} value={view} onSelect={select} groupLabel="视图切换" />
      </div>

      <SelectDropdown
        ariaLabel="视图切换"
        align="end"
        items={VIEW_TABS}
        value={view}
        onSelect={select}
        valueClassName="font-medium text-fg"
        triggerClassName={`${CTL_SELECT} ${expanded ? 'hidden' : 'inline-flex'}`}
        contentClassName="header-select-menu"
      />
    </>
  )
}

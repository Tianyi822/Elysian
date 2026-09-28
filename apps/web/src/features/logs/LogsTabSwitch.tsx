import { useRef } from 'react'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { SelectDropdown } from '../../components/SelectDropdown'
import { LOGS_TABS, useLogsStore } from '../../stores/logsStore'

/**
 * 日志区页签切换。经路由 handle 挂进顶栏，占据原本的标题位（该页经 handle 声明藏掉可视标题），
 * 选中态与页内共用 logs store。摊开形态由 app/layout/HeaderTabs.tsx 提供，
 * 摆不下时收进浮层菜单，两形态常驻 DOM、只切显示——与安全区页签同一套机制。
 */
export function LogsTabSwitch() {
  const tab = useLogsStore((s) => s.tab)
  const setTab = useLogsStore((s) => s.setTab)
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)

  // 摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = flatWidth <= availableWidth

  return (
    <>
      {/* 固有宽度探针：脱离布局，量出两项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <HeaderTabs items={LOGS_TABS} value={tab} onSelect={setTab} groupLabel="日志页签" />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <HeaderTabs items={LOGS_TABS} value={tab} onSelect={setTab} groupLabel="日志页签" />
      </div>

      <SelectDropdown
        ariaLabel="日志页签"
        align="end"
        items={LOGS_TABS}
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

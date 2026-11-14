import * as Tooltip from '@radix-ui/react-tooltip'
import {
  TIME_RANGE_LABELS,
  TIME_RANGES,
} from '../../adapters/mock/resourceMetrics'
import type { TimeRange } from '../../adapters/mock/resourceMetrics'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useNarrowViewport } from '../../app/layout/narrowViewport'
import { PillNavigation } from '../../components/easyui/PillNavigation'
import { Button } from '../../components/easyui/Button'
import { RefreshCw } from '../../components/icons'
import { SelectDropdown } from '../../components/SelectDropdown'
import { CTL_TOOLBAR } from '../../components/formControl'
import './dashboard.css'

export const DEMO_DATA_STATUS_LABEL = '演示数据'

const RANGES = TIME_RANGES

export function FilterBar({
  range,
  onRangeChange,
  onRefresh,
  refreshing,
}: {
  range: TimeRange
  onRangeChange: (range: TimeRange) => void
  onRefresh: () => void
  refreshing: boolean
}) {
  // 窄屏（<768px）一律收进下拉，与顶栏页签同一条线；宽屏由容器查询决定：放得下才把标签与分段控件摊开。
  const narrow = useNarrowViewport()
  // 展开阈值包含左侧标题与消息入口的预留，侧栏展开的中等宽度仍使用下拉。
  const labelSlot = narrow ? 'hidden' : 'hidden @min-[45rem]:inline'
  const dropdownSlot = narrow ? 'block' : '@min-[45rem]:hidden'
  const flatSlot = narrow ? 'hidden' : 'hidden @min-[45rem]:flex'

  return (
    <section
      aria-label="筛选栏"
      // 不叠行距：这条 64px 页头带与顶栏页签同一档，带底到控件底已有 14px（窄屏 18px）余量。
      className={`${CTL_TOOLBAR} dashboard-filters shell-own-header @container flex min-h-[var(--shell-header-height)] shrink-0 items-center pr-4 pl-[52px] md:px-6`}
    >
      <h2 className="mr-auto hidden shrink-0 text-base font-semibold md:block">资源概览</h2>
      <div className="flex min-w-0 items-center gap-3">
        {!isDockerRuntime() ? (
          <span role="status" className="demo-data-label shrink-0 text-xs text-fg-muted">
            {DEMO_DATA_STATUS_LABEL}
          </span>
        ) : null}
        <span className={`shrink-0 text-sm text-fg-muted ${labelSlot}`}>时间范围</span>
        <div className={dropdownSlot}>
          <SelectDropdown
            ariaLabel="时间范围"
            label="时间"
            items={RANGES.map((value) => ({ value, label: TIME_RANGE_LABELS[value] }))}
            value={range}
            onSelect={onRangeChange}
            contentClassName="select-menu"
          />
        </div>
        <PillNavigation
          ariaLabel="时间范围"
          items={RANGES.map((candidate) => ({ id: candidate, label: TIME_RANGE_LABELS[candidate] }))}
          value={range}
          onChange={(id) => { if (RANGES.includes(id as TimeRange)) onRangeChange(id as TimeRange) }}
          className={`max-w-full ${flatSlot}`}
        />

        {/* 刷新紧跟时间范围，不靠到行尾：它是这组读数的动作，不是整行的收尾。 */}
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <Button
              aria-label="刷新"
              aria-busy={refreshing || undefined}
              size="icon"
              variant="secondary"
              disabled={refreshing}
              onClick={onRefresh}
              className="size-[var(--ctl-height,2.25rem)] rounded-full text-fg-muted hover:text-fg"
              leftIcon={<RefreshCw aria-hidden size={14} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />}
            />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content side="bottom" sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
              刷新<Tooltip.Arrow className="fill-surface-raised" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    </section>
  )
}

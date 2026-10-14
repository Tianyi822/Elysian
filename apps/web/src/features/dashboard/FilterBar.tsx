import {
  TIME_RANGE_LABELS,
  TIME_RANGES,
} from '../../adapters/mock/resourceMetrics'
import type { TimeRange } from '../../adapters/mock/resourceMetrics'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useNarrowViewport } from '../../app/layout/narrowViewport'
import { SelectDropdown } from '../../components/SelectDropdown'
import { RefreshButton } from '../../components/RefreshState'
import { CTL_CHIP, CTL_GROUP, CTL_TOOLBAR } from '../../components/formControl'
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
  const labelSlot = narrow ? 'hidden' : 'hidden @min-[39rem]:inline'
  const dropdownSlot = narrow ? 'block' : '@min-[39rem]:hidden'
  const flatSlot = narrow ? 'hidden' : 'hidden @min-[39rem]:flex'

  return (
    <section
      aria-label="筛选栏"
      className={`${CTL_TOOLBAR} dashboard-filters @container mb-4 flex min-h-[var(--shell-header-height)] shrink-0 items-center pr-4 pl-[52px] md:px-6`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {!isDockerRuntime() ? (
          <span role="status" className="shrink-0 text-sm text-fg-muted">
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
            contentClassName="header-select-menu"
          />
        </div>
        {/* 分段控件走控件层：胶囊 + 芯片，高度与同行刷新按钮同档。 */}
        <div role="group" aria-label="时间范围" className={`${CTL_GROUP} max-w-full ${flatSlot}`}>
          {RANGES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={range === candidate}
              onClick={() => onRangeChange(candidate)}
              className={`${CTL_CHIP} sm:text-sm`}
            >
              {TIME_RANGE_LABELS[candidate]}
            </button>
          ))}
        </div>

        {/* 刷新紧跟时间范围，不靠到行尾：它是这组读数的动作，不是整行的收尾。 */}
        <RefreshButton
          onPress={onRefresh}
          busy={refreshing}
          formControl
          className="shrink-0"
        />
      </div>
    </section>
  )
}

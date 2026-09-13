
import { TIME_RANGE_LABELS } from '../../adapters/mock/resourceMetrics'
import type { TimeRange } from '../../adapters/mock/resourceMetrics'

const RANGES: readonly TimeRange[] = ['7d', '30d']

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
  return (
    <section
      aria-label="筛选栏"
      className="mb-6 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm text-fg-subtle">时间范围</span>
        <div role="group" aria-label="时间范围" className="flex overflow-hidden rounded border border-line">
          {RANGES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={range === candidate}
              onClick={() => onRangeChange(candidate)}
              className={[
                'px-3 py-1.5 text-sm transition-colors',
                range === candidate
                  ? 'bg-accent/15 font-medium text-fg'
                  : 'text-fg-muted hover:text-fg',
              ].join(' ')}
            >
              {TIME_RANGE_LABELS[candidate]}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={refreshing}
          onClick={onRefresh}
          className="rounded border border-line bg-surface-raised px-3 py-1.5 text-sm text-fg disabled:opacity-50"
        >
          刷新
        </button>
        {refreshing ? (
          <span role="status" className="text-sm text-fg-muted">
            正在刷新…
          </span>
        ) : null}

        <span className="ml-auto text-sm text-fg-subtle">
          粒度：<span className="text-fg-muted">按天</span>
        </span>
      </div>
    </section>
  )
}

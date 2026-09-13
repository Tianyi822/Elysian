import { AUDIT_KIND_LABELS } from '@elysian/contracts'
import type { AuditRecord } from '@elysian/contracts'
import { useMemo } from 'react'
import { StatusTag } from '../../components/StatusTag'
import { formatDateTime } from '../../components/format'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { isLiveRecord, projectEventToAuditRecord } from './liveProjection'

const RECENT_LIMIT = 8

export function RecentActivitySection({ records }: { records: readonly AuditRecord[] }) {
  const recentEvents = useEventStreamStore((state) => state.recent)

  const merged = useMemo(() => {
    // 实时记录按「刚刚到达」置顶，不与种子基准时间比大小。
    const live = recentEvents.map(projectEventToAuditRecord)
    return [...live, ...records].slice(0, RECENT_LIMIT)
  }, [recentEvents, records])

  return (
    <section aria-label="最近活动" className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
        <h2 className="text-base font-semibold">最近活动</h2>
        <span className="text-sm text-fg-muted">最新 {merged.length} 条</span>
      </div>

      {merged.length === 0 ? (
        <p className="py-4 text-center text-sm text-fg-muted">还没有任何活动记录。</p>
      ) : (
        <ol className="space-y-2">
          {merged.map((record) => (
            <li key={record.id} className="flex flex-wrap items-baseline gap-2">
              <time className="text-xs tabular-nums text-fg-subtle">
                {formatDateTime(record.at)}
              </time>
              <StatusTag label={AUDIT_KIND_LABELS[record.kind]} tone="info" />
              <span className="text-sm">{record.summary}</span>
              {isLiveRecord(record) ? (
                <span className="text-xs text-accent">实时</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

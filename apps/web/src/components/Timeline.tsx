import type { TimelineEntry } from '@elysian/contracts'
import { formatDateTime } from './format'
import { StatusTag } from './StatusTag'
import type { StatusTone } from './StatusTag'

const KIND_LABELS: Record<TimelineEntry['kind'], string> = {
  detected: '发现',
  alert: '告警',
  decision: '决策',
  'tool-call': '工具调用',
  approval: '审批',
  execution: '执行',
  note: '记录',
}

const KIND_TONES: Record<TimelineEntry['kind'], StatusTone> = {
  detected: 'warning',
  alert: 'warning',
  decision: 'info',
  'tool-call': 'neutral',
  approval: 'info',
  execution: 'success',
  note: 'neutral',
}

/** 事件时间线。事故详情与 Agent 运行共用一个表达，保证同一个事件在两处长得一样。 */
export function Timeline({ entries }: { entries: readonly TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-fg-muted">暂无时间线条目。</p>
  }

  return (
    <ol className="relative border-l border-line pl-3">
      {entries.map((entry) => (
        <li key={entry.id} className="relative mb-2 last:mb-0">
          <span
            aria-hidden
            className="absolute -left-[17px] top-2 size-1.5 rounded-full bg-fg-subtle"
          />
          <div className="flex flex-wrap items-baseline gap-2">
            <time className="text-xs tabular-nums text-fg-subtle">{formatDateTime(entry.at)}</time>
            <StatusTag label={KIND_LABELS[entry.kind]} tone={KIND_TONES[entry.kind]} />
            <span className="text-xs text-fg-muted">{entry.actor}</span>
          </div>
          <p className="text-sm">{entry.summary}</p>
        </li>
      ))}
    </ol>
  )
}

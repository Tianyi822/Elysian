import type { EventStreamStatus } from '@elysian/contracts'
import { useEventStreamStore } from '../stores/eventStreamStore'

const STATUS_TEXT: Record<EventStreamStatus, string> = {
  connecting: '实时事件流：连接中',
  live: '实时事件流：已连接',
  degraded: '实时事件流：已降级为内存事件源',
}

const STATUS_TONE: Record<EventStreamStatus, string> = {
  connecting: 'border-line bg-surface text-fg-muted',
  live: 'border-success/40 bg-success/10 text-success',
  degraded: 'border-warning/40 bg-warning/10 text-warning',
}

/**
 * 事件流状态标识。固定在页头出现，因为「界面上的数据是不是实时来的」
 * 直接决定运维人员能不能信任眼前这一屏。
 */
export function EventStreamBadge() {
  const status = useEventStreamStore((state) => state.status)

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${STATUS_TONE[status]}`}
    >
      {STATUS_TEXT[status]}
    </span>
  )
}

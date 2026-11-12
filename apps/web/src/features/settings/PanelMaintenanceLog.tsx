import { useMemo } from 'react'
import type { Ref } from 'react'
import { Terminal } from '../../components/icons'
import { CopyButton } from '../../components/CopyButton'

export function PanelMaintenanceLog({ logs, viewportRef }: { logs: string; viewportRef: Ref<HTMLDivElement> }) {
  const lines = useMemo(() => logs.split('\n').filter(line => line.trim()).map(line => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\s*(.*)$/.exec(line)
    const timestamp = match?.[1]
    const message = match ? match[2] || '阶段名称未记录' : line
    const time = timestamp ? new Date(timestamp) : null
    return { timestamp, time: time && Number.isFinite(time.getTime()) ? time.toLocaleTimeString('zh-CN', { hour12: false }) : '', message, parts: message.split('；') }
  }), [logs])
  return <div className="mt-5 overflow-hidden rounded-xl border border-line">
    <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-raised/60 px-3 py-2">
      <span className="flex items-center gap-2 text-xs font-medium text-fg-muted"><Terminal aria-hidden size={14} />维护进程日志</span>
      <CopyButton label="复制日志" tooltip="复制原始维护日志" value={logs} />
    </div>
    <div ref={viewportRef} aria-label="维护任务日志" role="region" tabIndex={0} className="hover-scrollbar max-h-64 overflow-auto bg-[var(--t-code-bg)] px-3 py-1 font-mono text-[0.6875rem] leading-5 text-[var(--t-code-fg)] focus-visible:-outline-offset-2">
      {lines.map((line, index) => <div key={index} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 border-b border-line/50 py-2 last:border-0 sm:grid-cols-[4.25rem_minmax(0,1fr)] sm:gap-3">
        <time dateTime={line.timestamp} title={line.timestamp ? `${new Date(line.timestamp).toLocaleString('zh-CN', { hour12: false })}（本地时间）` : undefined} className="select-none text-[0.625rem] tabular-nums text-fg-subtle">{line.time || '—'}</time>
        <div className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${/失败|异常/.test(line.message) ? 'text-danger' : line.timestamp ? 'font-medium' : ''}`}>{line.parts.map((part, partIndex) => <div key={partIndex}>{part.trim()}</div>)}</div>
      </div>)}
    </div>
  </div>
}

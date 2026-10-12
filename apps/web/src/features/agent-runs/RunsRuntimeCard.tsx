import type { AgentRuntimeInfo } from '@elysian/contracts'
import { formatActiveDuration, capabilityRows } from './runDisplay'

/*
 * 运行时报告卡：/api/agent/runtime 的完整呈现——available/reason、Worker 与
 * Storage 诊断串、并发/队列深度、限额摘要与 12 个能力位（不可用时逐位给出
 * 服务端中文 reason）。available:false 时页面整页走 AgentUnavailableState，
 * 本卡只在可用时渲染。
 */

export function RunsRuntimeCard({ info }: { info: AgentRuntimeInfo }) {
  const rows = capabilityRows(info)
  const limits = info.limits
  const limitEntries: readonly { label: string; value: string }[] = [
    { label: '并发', value: String(limits.concurrency) },
    { label: '队列容量', value: String(limits.queueCapacity) },
    { label: '每 Run 工具调用上限', value: String(limits.maxSteps) },
    { label: '活动时限', value: formatActiveDuration(limits.runTimeoutSeconds * 1000) },
    { label: '工具单次时限', value: formatActiveDuration(limits.callTimeoutSeconds * 1000) },
    { label: '单次结果上限', value: `${limits.resultBytes} B` },
    { label: '累计结果上限', value: `${limits.runResultBytes} B` },
    { label: '模型请求上限', value: limits.maxModelRequests === undefined ? '未报告' : String(limits.maxModelRequests) },
    { label: 'Token 总预算', value: limits.tokenBudget === undefined ? '未报告' : String(limits.tokenBudget) },
    { label: '记录保留', value: `${limits.retentionDays} 天` },
  ]
  return (
    <section aria-label="运行时能力报告" className="panel-surface busy-host p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">运行时能力报告</h2>
        <p className="text-xs text-fg-subtle">来源 GET /api/agent/runtime；能力位由内核按值报告，不可用时附中文原因</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="tile p-2">
          <p className="text-xs text-fg-muted">内核状态</p>
          <p className="mt-0.5 text-sm font-medium">{info.available ? '可用' : '不可用'}</p>
          {info.reason !== undefined ? <p className="mt-0.5 text-xs text-fg-subtle">{info.reason}</p> : null}
        </div>
        <div className="tile p-2">
          <p className="text-xs text-fg-muted">Worker / 存储</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums">{info.worker} / {info.storage}</p>
        </div>
        <div className="tile p-2">
          <p className="text-xs text-fg-muted">并发 / 队列深度</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums">{info.limits.concurrency} / {info.queueDepth}</p>
        </div>
        <div className="tile p-2">
          <p className="text-xs text-fg-muted">批次工具白名单</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums">{info.tools.length} 条</p>
        </div>
      </div>
      <div className="mt-3">
        <p className="text-xs font-medium text-fg-muted">能力位</p>
        <ul className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
          {rows.map((row) => (
            <li key={row.key} className="tile flex items-baseline justify-between gap-2 p-2" data-capability={row.key}>
              <span className="text-xs text-fg-muted">{row.label}</span>
              <span
                className={`text-xs font-medium ${row.available ? 'text-success' : 'text-warning'}`}
                title={row.available ? undefined : row.reason}
              >
                {row.available ? '可用' : '不可用'}
              </span>
            </li>
          ))}
        </ul>
        {rows.some((row) => !row.available) ? (
          <ul className="mt-1.5 space-y-1">
            {rows.filter((row) => !row.available).map((row) => (
              <li key={row.key} className="text-xs text-fg-subtle">
                {row.label}：{row.reason ?? '未给出原因'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-3">
        <p className="text-xs font-medium text-fg-muted">限额</p>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
          {limitEntries.map((entry) => (
            <div key={entry.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-xs text-fg-muted">{entry.label}</dt>
              <dd className="text-xs font-medium tabular-nums">{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

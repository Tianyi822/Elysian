import { useEffect } from 'react'
import { LOGIN_LOG_STATUS_LABELS } from '@elysian/contracts'
import type { LoginLogEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatLoginTime } from '../../components/format'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useLoginLogStore } from '../../stores/loginLogStore'

/** 登录状态 → 状态标签色调：成功绿、失败红，文字标签同时常驻。 */
const STATUS_TONES: Record<LoginLogEntry['status'], StatusTone> = {
  success: 'success',
  failure: 'danger',
}

/**
 * 平台登录日志面板：全量列表，无搜索与分页（演示数据十几条，一屏放得下）。
 * IP 与归属地拆成两列；用户代理整串截断展示，完整内容放悬停提示；
 * 每列都给显式宽度，只有用户代理列吃掉剩余空间，行高不随内容跳动。
 */
export function LoginLogPanel() {
  const gateway = useGateway()
  const status = useLoginLogStore((s) => s.status)
  const errorMessage = useLoginLogStore((s) => s.errorMessage)
  const entries = useLoginLogStore((s) => s.entries)
  const load = useLoginLogStore((s) => s.load)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载登录日志…" />
  }

  if (status === 'error') {
    return <ErrorState title="登录日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }

  if (entries.length === 0) {
    return <EmptyState title="还没有登录日志" description="接入真实采集后，登录记录会出现在这里。" />
  }

  return (
    <div role="region" aria-label="登录日志表" className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full min-w-[960px] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-40" />
          <col className="w-56" />
          <col />
          <col className="w-24" />
          <col className="w-44" />
        </colgroup>
        <thead>
          <tr>
            {['IP 地址', '归属地', '用户代理', '登录状态', '时间'].map((label) => (
              <th
                key={label}
                scope="col"
                className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="transition-colors hover:bg-surface-raised">
              <td className="border-b border-line px-3 py-2.5 font-medium tabular-nums">{entry.ip}</td>
              <td className="border-b border-line px-3 py-2.5 text-fg-muted">{entry.location}</td>
              <td className="border-b border-line px-3 py-2.5 text-fg-muted">
                <span className="block truncate" title={entry.userAgent}>
                  {entry.userAgent}
                </span>
              </td>
              <td className="border-b border-line px-3 py-2.5">
                <StatusTag label={LOGIN_LOG_STATUS_LABELS[entry.status]} tone={STATUS_TONES[entry.status]} />
              </td>
              <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                {formatLoginTime(entry.time)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

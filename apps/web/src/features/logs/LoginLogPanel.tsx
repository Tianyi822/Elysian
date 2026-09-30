import { useEffect, useRef } from 'react'
import { LOG_ENTRY_FETCH_LIMIT, LOGIN_LOG_STATUS_LABELS } from '@elysian/contracts'
import type { LoginLogEntry } from '@elysian/contracts'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatLoginTime } from '../../components/format'
import { Search } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useLoginLogStore } from '../../stores/loginLogStore'
import type { LoginLogStatusFilter } from '../../stores/loginLogStore'

/** 登录状态 → 状态标签色调：成功绿、失败红，文字标签同时常驻。 */
const STATUS_TONES: Record<LoginLogEntry['status'], StatusTone> = {
  success: 'success',
  failure: 'danger',
}

/** 状态筛选按钮表：全部 + 契约标签表里的两种结果。 */
const STATUS_FILTERS: readonly { value: LoginLogStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'success', label: LOGIN_LOG_STATUS_LABELS.success },
  { value: 'failure', label: LOGIN_LOG_STATUS_LABELS.failure },
]

/**
 * 平台登录日志面板：表格上方是状态筛选与关键字搜索，下方为服务端筛选结果。
 * IP 与归属地拆成两列；用户代理整串截断展示，完整内容放悬停提示；
 * 每列都给显式宽度，只有用户代理列吃掉剩余空间，行高不随内容跳动。
 */
export function LoginLogPanel() {
  const gateway = useGateway()
  const status = useLoginLogStore((s) => s.status)
  const errorMessage = useLoginLogStore((s) => s.errorMessage)
  const entries = useLoginLogStore((s) => s.entries)
  const total = useLoginLogStore((s) => s.total)
  const truncated = useLoginLogStore((s) => s.truncated)
  const skippedLines = useLoginLogStore((s) => s.skippedLines)
  const skippedFiles = useLoginLogStore((s) => s.skippedFiles)
  const statusFilter = useLoginLogStore((s) => s.statusFilter)
  const search = useLoginLogStore((s) => s.search)
  const refreshing = useLoginLogStore((s) => s.refreshing)
  const loadingOlder = useLoginLogStore((s) => s.loadingOlder)
  const olderError = useLoginLogStore((s) => s.olderError)
  const load = useLoginLogStore((s) => s.load)
  const loadOlder = useLoginLogStore((s) => s.loadOlder)
  const setStatusFilter = useLoginLogStore((s) => s.setStatusFilter)
  const setSearch = useLoginLogStore((s) => s.setSearch)

  const committedSearchRef = useRef(search.trim())
  const trimmedSearch = search.trim()

  useEffect(() => {
    const delay = trimmedSearch === committedSearchRef.current ? 0 : 300
    const handle = setTimeout(() => {
      committedSearchRef.current = trimmedSearch
      void load(gateway)
    }, delay)
    return () => clearTimeout(handle)
  }, [gateway, load, statusFilter, trimmedSearch])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载登录日志…" />
  }

  if (status === 'error') {
    return <ErrorState title="登录日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }

  const filtersClear = statusFilter === 'all' && trimmedSearch.length === 0
  if (total === 0 && filtersClear) {
    return <EmptyState title="还没有登录日志" description="登录成功或失败后，记录会出现在这里。" />
  }

  const notices: string[] = []
  if (truncated) notices.push(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条`)
  if (skippedLines > 0) notices.push(`有 ${skippedLines} 行无法解析，已跳过`)
  if (skippedFiles > 0) notices.push(`有 ${skippedFiles} 个日志文件读取失败，已跳过`)

  const querying = refreshing && !loadingOlder

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        {isDockerRuntime() ? null : (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        )}
        <div role="group" aria-label="登录状态筛选" className="flex items-center gap-2">
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
              className={`inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === value
                  ? 'border-success/50 bg-success/10 text-success'
                  : 'border-line bg-surface-raised text-fg hover:border-fg-subtle'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-64 max-w-full">
          <label htmlFor="login-log-search" className="sr-only">
            搜索登录日志
          </label>
          <input
            id="login-log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="请输入搜索关键字"
            className="w-full rounded-lg border border-line bg-surface-raised py-1.5 pl-3 pr-8 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
          />
          <Search
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
        </div>
      </div>
      {notices.length > 0 ? (
        <p role="status" className="mb-3 text-xs text-fg-muted">
          {notices.join('；')}
        </p>
      ) : null}

      {querying ? (
        <LoadingState label="正在查询…" />
      ) : (
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
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="border-b border-line px-3 py-8 text-center text-sm text-fg-muted">
                    没有匹配的登录记录，换个关键词或清空筛选
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {truncated ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="text-xs text-fg-muted">还有更早的记录</p>
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder(gateway)}
            className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
          >
            {loadingOlder ? '加载中…' : '加载更早的记录'}
          </button>
          {olderError ? (
            <p role="status" className="text-xs text-danger">
              更早的记录加载失败
            </p>
          ) : null}
        </div>
      ) : olderError ? (
        <p role="status" className="mt-3 text-xs text-danger">
          更早的记录加载失败
        </p>
      ) : null}
    </div>
  )
}

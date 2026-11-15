import { useEffect, useRef } from 'react'
import { LOG_ENTRY_FETCH_LIMIT, LOGIN_LOG_STATUS_LABELS } from '@elysian/contracts'
import type { LoginLogEntry } from '@elysian/contracts'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatLoginTime } from '../../components/format'
import { DataTable } from '../../components/DataTable'
import { CTL_TOOLBAR } from '../../components/formControl'
import { ChipGroup } from '../../components/ChipGroup'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useLoginLogStore } from '../../stores/loginLogStore'
import type { LoginLogStatusFilter } from '../../stores/loginLogStore'
import { useLogReportNotifications } from './useLogReportNotifications'
import { Button } from '../../components/Button'

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

  useLogReportNotifications('登录日志', { ready: status === 'ready', truncated, skippedLines, skippedFiles, olderError })

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


  const notices: string[] = []
  if (truncated) notices.push(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条`)
  if (skippedLines > 0) notices.push(`有 ${skippedLines} 行无法解析，已跳过`)
  if (skippedFiles > 0) notices.push(`有 ${skippedFiles} 个日志文件读取失败，已跳过`)

  const querying = refreshing && !loadingOlder

  return (
    <div>
      {errorMessage ? <p role="alert" className="text-xs text-danger">刷新失败：{errorMessage}。已保留上次读取结果。<Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway)}>重试</Button></p> : null}
      <div className={`${CTL_TOOLBAR} rect-toolbar mb-4 flex flex-wrap items-center gap-2 panel-surface px-4 py-3`}>
        {isDockerRuntime() ? null : (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        )}
        <ChipGroup ariaLabel="登录状态筛选" items={STATUS_FILTERS} value={statusFilter} onSelect={setStatusFilter} />

      </div>
      {notices.length > 0 ? (
        <p role="status" className="mb-3 text-xs text-fg-muted">
          {notices.join('；')}
        </p>
      ) : null}

      <DataTable ariaLabel="登录日志表" rows={entries} query={search} onQueryChange={setSearch}
        filterMode="external" emptyState={entries.length === 0 && !search.trim() && statusFilter === 'all' ? <><p className="font-medium">还没有登录日志</p><p className="text-sm text-fg-muted">登录成功或失败后，记录会出现在这里。</p></> : undefined} searchPlaceholder="搜索登录日志" selectionKey={statusFilter} busy={querying}
        columns={[
          { key: 'ip', header: 'IP 地址', primary: true, width: '160px', accessor: entry => entry.ip, cell: entry => <span className="tabular-nums">{entry.ip}</span> },
          { key: 'location', header: '归属地', width: 'minmax(140px,1fr)', accessor: entry => entry.location },
          { key: 'userAgent', header: '用户代理', width: 'minmax(180px,2fr)', accessor: entry => entry.userAgent, cell: entry => <span className="block truncate" title={entry.userAgent}>{entry.userAgent}</span> },
          { key: 'status', header: '登录状态', width: '110px', accessor: entry => LOGIN_LOG_STATUS_LABELS[entry.status], cell: entry => <StatusTag label={LOGIN_LOG_STATUS_LABELS[entry.status]} tone={STATUS_TONES[entry.status]} /> },
          { key: 'time', header: '时间', width: '176px', accessor: entry => new Date(entry.time), cell: entry => <span className="tabular-nums text-fg-muted">{formatLoginTime(entry.time)}</span> },
        ]} />

      {truncated ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="text-xs text-fg-muted">还有更早的记录</p>
          <Button variant="outline"
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder(gateway)}
            className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
          >
            {loadingOlder ? '加载中…' : '加载更早的记录'}
          </Button>
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

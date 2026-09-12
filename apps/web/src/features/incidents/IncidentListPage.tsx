import {
  INCIDENT_STATUSES,
  INCIDENT_STATUS_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  responsibilityModuleName,
} from '@elysian/contracts'
import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { INCIDENT_STATUS_TONE, SeverityTag, StatusTag } from '../../components/StatusTag'
import { ToggleChip } from '../../components/ToggleChip'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useIncidentListStore } from '../../stores/incidentListStore'
import type { IncidentListQuery } from '../../contracts/adapters'
import {
  INCIDENT_SORTS,
  INCIDENT_SORT_LABELS,
  hasActiveFilters,
  parseIncidentQuery,
  toIncidentSearchParams,
  toggleValue,
} from './query'

const KIND_LABELS = {
  incident: '事故',
  alert: '告警',
  'pending-task': '待处理任务',
} as const

const COLUMNS = [
  { key: 'severity', header: '严重等级', width: '88px' },
  { key: 'title', header: '标题', width: '32%' },
  { key: 'status', header: '状态', width: '92px' },
  { key: 'source', header: '来源', width: '118px' },
  { key: 'service', header: '受影响服务', width: '150px' },
  { key: 'at', header: '发生时间', width: '132px', numeric: true },
  { key: 'owner', header: '负责人', width: '82px' },
  { key: 'module', header: '当前 Agent', width: '116px' },
]

export function IncidentListPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()

  // 用地址字符串做依赖，避免每次渲染都触发一次重新加载。
  const queryKey = searchParams.toString()
  const query = useMemo<IncidentListQuery>(
    () => parseIncidentQuery(new URLSearchParams(queryKey)),
    [queryKey],
  )

  const status = useIncidentListStore((state) => state.status)
  const rows = useIncidentListStore((state) => state.rows)
  const total = useIncidentListStore((state) => state.total)
  const availableSources = useIncidentListStore((state) => state.availableSources)
  const errorMessage = useIncidentListStore((state) => state.errorMessage)
  const load = useIncidentListStore((state) => state.load)

  useEffect(() => {
    void load(gateway.incidents, parseIncidentQuery(new URLSearchParams(queryKey)))
  }, [gateway, queryKey, load])

  const apply = (next: IncidentListQuery) => {
    setSearchParams(toIncidentSearchParams(next))
  }

  const filtered = hasActiveFilters(query)

  return (
    <>
      <PageHeader
        title="事件中心"
        description="事故、告警与待处理任务的合并列表。筛选条件保留在地址里，可以分享与回退。"
        actions={
          <>
            <span className="text-xs text-fg-muted">共 {total} 条</span>
            <button
              type="button"
              onClick={() => void load(gateway.incidents, query)}
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
            >
              刷新
            </button>
          </>
        }
      />

      <div className="mb-3 space-y-1.5">
        <div role="group" aria-labelledby="filter-severity" className="flex flex-wrap items-center gap-1.5">
          <span id="filter-severity" className="mr-1 text-xs text-fg-subtle">
            严重等级
          </span>
          {SEVERITIES.map((severity) => (
            <ToggleChip
              key={severity}
              label={SEVERITY_LABELS[severity]}
              checked={query.severities?.includes(severity) ?? false}
              onChange={() => apply({ ...query, severities: toggleValue(query.severities, severity) })}
            />
          ))}
        </div>

        <div role="group" aria-labelledby="filter-status" className="flex flex-wrap items-center gap-1.5">
          <span id="filter-status" className="mr-1 text-xs text-fg-subtle">
            状态
          </span>
          {INCIDENT_STATUSES.map((incidentStatus) => (
            <ToggleChip
              key={incidentStatus}
              label={INCIDENT_STATUS_LABELS[incidentStatus]}
              checked={query.statuses?.includes(incidentStatus) ?? false}
              onChange={() => apply({ ...query, statuses: toggleValue(query.statuses, incidentStatus) })}
            />
          ))}
        </div>

        <div role="group" aria-labelledby="filter-source" className="flex flex-wrap items-center gap-1.5">
          <span id="filter-source" className="mr-1 text-xs text-fg-subtle">
            来源
          </span>
          {availableSources.map((source) => (
            <ToggleChip
              key={source}
              label={source}
              checked={query.sources?.includes(source) ?? false}
              onChange={() => apply({ ...query, sources: toggleValue(query.sources, source) })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <label htmlFor="incident-sort" className="text-xs text-fg-subtle">
            排序
          </label>
          <select
            id="incident-sort"
            value={query.sort}
            onChange={(event) => apply({ ...query, sort: event.target.value as IncidentListQuery['sort'] })}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-fg"
          >
            {INCIDENT_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {INCIDENT_SORT_LABELS[sort]}
              </option>
            ))}
          </select>

          {filtered ? (
            <button
              type="button"
              onClick={() => apply({ sort: query.sort })}
              className="rounded border border-line px-2 py-0.5 text-xs text-fg-muted"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {status === 'error' ? (
        <ErrorState
          title="事件列表加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway.incidents, query)}
        />
      ) : status === 'loading' && rows.length === 0 ? (
        <LoadingState label="正在加载事件列表…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="当前筛选条件下没有事件"
          description={
            filtered
              ? '这不是数据为空，而是筛选条件排除了全部条目。清除筛选可以看回完整列表。'
              : '数据集里还没有任何事件。'
          }
        />
      ) : (
        <DataTable label="事件列表" columns={COLUMNS}>
          {rows.map((row) => (
            <DataRow key={row.id}>
              <DataCell>
                <SeverityTag severity={row.severity} />
              </DataCell>
              <DataCell>
                {row.kind === 'incident' ? (
                  <Link to={`/incidents/${row.id}`} className="text-accent hover:underline">
                    {row.title}
                  </Link>
                ) : (
                  <span className="text-fg-muted">
                    <span className="mr-1 text-fg-subtle">[{KIND_LABELS[row.kind]}]</span>
                    {row.title}
                  </span>
                )}
              </DataCell>
              <DataCell>
                {row.status ? (
                  <StatusTag
                    label={INCIDENT_STATUS_LABELS[row.status]}
                    tone={INCIDENT_STATUS_TONE[row.status]}
                  />
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </DataCell>
              <DataCell muted>{row.source}</DataCell>
              <DataCell muted>{row.service}</DataCell>
              <DataCell numeric muted>
                {formatDateTime(row.at)}
              </DataCell>
              <DataCell muted>{row.owner ?? '—'}</DataCell>
              <DataCell muted>
                {row.moduleId ? responsibilityModuleName(row.moduleId) : '—'}
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}
    </>
  )
}

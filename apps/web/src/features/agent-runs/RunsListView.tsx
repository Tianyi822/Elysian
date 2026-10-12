import { useState } from 'react'
import { RUNTIME_RUN_STATUSES, RUNTIME_RUN_STATUS_LABELS } from '@elysian/contracts'
import type { RuntimeRunStatus } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY, CTL_TOOLBAR } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { formatLoginTime } from '../../components/format'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import type { AgentRunsFilters } from '../../stores/agentRunsStore'
import { RUN_KIND_LABELS, driverLabel, runKindOf } from './runDisplay'

/*
 * Run 列表视图：服务端单选过滤（状态下拉单值，含「全部」；多状态过滤不在此页
 * 实现，重复传参会被服务端 400）＋requestId/sessionId/taskId/workflowId 精确
 * 文本过滤；分页用 Page 信封的 nextCursor（十进制字符串）翻页。行内呈现九态
 * 状态标签、driverVersion（v1/v2）与 kind。
 */

const STATUS_OPTIONS = RUNTIME_RUN_STATUSES.map((status) => ({ value: status, label: RUNTIME_RUN_STATUS_LABELS[status] }))

const TEXT_FILTER_FIELDS = [
  { key: 'requestId', label: 'requestId' },
  { key: 'sessionId', label: 'sessionId' },
  { key: 'taskId', label: 'taskId' },
  { key: 'workflowId', label: 'workflowId' },
] as const

type TextFieldKey = (typeof TEXT_FILTER_FIELDS)[number]['key']

export function RunsListView({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const gateway = useGateway()
  const list = useAgentRunsStore((state) => state.list)
  const loadList = useAgentRunsStore((state) => state.loadList)
  const setFilters = useAgentRunsStore((state) => state.setFilters)
  const loadMore = useAgentRunsStore((state) => state.loadMore)
  const [draft, setDraft] = useState<Record<TextFieldKey, string>>({ requestId: '', sessionId: '', taskId: '', workflowId: '' })
  const [applying, setApplying] = useState(false)
  const [moreError, setMoreError] = useState<string | undefined>(undefined)

  const applyDraft = (): void => {
    setApplying(true)
    const filters: AgentRunsFilters = {
      ...(list.filters.status === undefined ? {} : { status: list.filters.status }),
      ...(draft.requestId === '' ? {} : { requestId: draft.requestId.trim() }),
      ...(draft.sessionId === '' ? {} : { sessionId: draft.sessionId.trim() }),
      ...(draft.taskId === '' ? {} : { taskId: draft.taskId.trim() }),
      ...(draft.workflowId === '' ? {} : { workflowId: draft.workflowId.trim() }),
    }
    void setFilters(gateway, filters).finally(() => setApplying(false))
  }

  const changeStatus = (status: RuntimeRunStatus | undefined): void => {
    const filters: AgentRunsFilters = {
      ...(status === undefined ? {} : { status }),
      ...(draft.requestId === '' ? {} : { requestId: draft.requestId.trim() }),
      ...(draft.sessionId === '' ? {} : { sessionId: draft.sessionId.trim() }),
      ...(draft.taskId === '' ? {} : { taskId: draft.taskId.trim() }),
      ...(draft.workflowId === '' ? {} : { workflowId: draft.workflowId.trim() }),
    }
    void setFilters(gateway, filters)
  }

  const clearAll = (): void => {
    setDraft({ requestId: '', sessionId: '', taskId: '', workflowId: '' })
    void setFilters(gateway, {})
  }

  return (
    <section aria-label="Run 列表" className="panel-surface busy-host relative p-4">
      <BusyVeil busy={list.refreshing || applying} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Run 列表</h2>
        <RefreshButton onPress={() => void loadList(gateway)} busy={list.refreshing} label="刷新 Run 列表" />
      </div>
      <form
        className={`${CTL_TOOLBAR} mt-3 flex flex-wrap items-end gap-2`}
        onSubmit={(event) => {
          event.preventDefault()
          applyDraft()
        }}
      >
        <div>
          <label className="mb-1 block text-xs text-fg-muted" htmlFor="runs-filter-status">状态（单选）</label>
          <SelectDropdown
            id="runs-filter-status"
            ariaLabel="按运行状态过滤（单选）"
            items={[{ value: '__all__', label: '全部' }, ...STATUS_OPTIONS]}
            value={list.filters.status === undefined ? '__all__' : list.filters.status}
            onSelect={(value) => changeStatus(value === '__all__' ? undefined : (value as RuntimeRunStatus))}
            fallbackLabel="全部"
          />
        </div>
        {TEXT_FILTER_FIELDS.map((field) => (
          <div key={field.key} className="min-w-40">
            <label className="mb-1 block text-xs text-fg-muted" htmlFor={`runs-filter-${field.key}`}>{field.label}（精确）</label>
            <input
              id={`runs-filter-${field.key}`}
              className={`${CTL_FIELD} font-mono text-xs`}
              value={draft[field.key]}
              onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
              placeholder={`按 ${field.label} 精确匹配`}
            />
          </div>
        ))}
        <button type="submit" className={CTL_PRIMARY} disabled={applying}>{applying ? '查询中…' : '查询'}</button>
        <button type="button" className={CTL_SECONDARY} onClick={clearAll} disabled={applying}>清除过滤</button>
      </form>

      <div className="mt-4">
        {list.status === 'loading' ? <LoadingState label="读取 Run 列表…" /> : null}
        {list.status === 'error' ? (
          <ErrorState description={list.errorMessage} onRetry={() => void loadList(gateway)} />
        ) : null}
        {list.status === 'ready' && list.items.length === 0 ? (
          <EmptyState
            title="没有符合条件的 Run"
            description="调整过滤条件后重新查询；新提交的批次任务会出现在列表顶部。"
          />
        ) : null}
        {list.status === 'ready' && list.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[17%]" />
                <col className="w-[13%]" />
                <col className="w-[21%]" />
              </colgroup>
              <thead>
                <tr>
                  {['Run', '状态', '类型', '驱动', '任务 / 会话', '创建时间', 'requestId'].map((label) => (
                    <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((run) => (
                  <tr key={run.id} className="hover:bg-surface">
                    <td className="border-b border-line px-3 py-2 font-mono text-xs">
                      <button
                        type="button"
                        className="text-left text-fg underline-offset-2 hover:underline"
                        onClick={() => onOpenRun(run.id)}
                        title={`查看 Run ${run.id}`}
                      >
                        {run.id}
                      </button>
                    </td>
                    <td className="border-b border-line px-3 py-2"><AgentRunStatusTag status={run.status} /></td>
                    <td className="border-b border-line px-3 py-2 text-xs">{RUN_KIND_LABELS[runKindOf(run)]}</td>
                    <td className="border-b border-line px-3 py-2 text-xs tabular-nums">{driverLabel(run)}</td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs">{run.taskId}{run.sessionId !== undefined ? ` · ${run.sessionId}` : ''}</td>
                    <td className="border-b border-line px-3 py-2 text-xs tabular-nums">{formatLoginTime(run.createdAt)}</td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs">{run.requestId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {list.status === 'ready' && (list.hasMore || list.items.length > 0) ? (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className={CTL_SECONDARY}
            disabled={!list.hasMore || list.loadingMore}
            onClick={() => {
              setMoreError(undefined)
              loadMore(gateway).catch((error: unknown) => {
                setMoreError(error instanceof Error ? error.message : '读取下一页失败')
              })
            }}
          >
            {list.loadingMore ? '加载中…' : list.hasMore ? '加载更多 Run' : '没有更多了'}
          </button>
          <p className="text-xs text-fg-subtle tabular-nums">
            已加载 {list.items.length} 条{list.hasMore ? '，游标按十进制字符串传递' : ''}
          </p>
          {moreError !== undefined ? <p role="alert" className="text-xs text-danger">{moreError}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

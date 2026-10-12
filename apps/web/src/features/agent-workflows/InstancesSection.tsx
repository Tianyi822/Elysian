import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { AGENT_WORKFLOW_STATUSES, AGENT_WORKFLOW_STATUS_LABELS } from '@elysian/contracts'
import type { AgentWorkflowInstance } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { AgentWorkflowStatusTag } from '../../components/agent/AgentStatusTag'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_CHIP, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { ListTodo } from '../../components/icons'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { InstanceDetailSection } from './InstanceDetailSection'
import { workflowUsageRows } from './workflowFormat'

const STATUS_FILTERS: readonly AgentWorkflowInstance['status'][] = AGENT_WORKFLOW_STATUSES

/** 实例列表视图：状态筛选（含 ready/recovery-required）、恢复动作与预算摘要、15s 静默轮询。 */
export function InstancesSection({ selectedInstanceId }: { selectedInstanceId: string }) {
  const gateway = useGateway()
  const navigate = useNavigate()
  const status = useAgentWorkflowsStore((state) => state.instances.status)
  const items = useAgentWorkflowsStore((state) => state.instances.items)
  const errorMessage = useAgentWorkflowsStore((state) => state.instances.errorMessage)
  const reloading = useAgentWorkflowsStore((state) => state.instances.reloading)
  const hasMore = useAgentWorkflowsStore((state) => state.instances.hasMore)
  const statusFilter = useAgentWorkflowsStore((state) => state.instances.statusFilter)
  const load = useAgentWorkflowsStore((state) => state.loadInstances)
  const setStatusFilter = useAgentWorkflowsStore((state) => state.setStatusFilter)
  const loadMore = useAgentWorkflowsStore((state) => state.loadMoreInstances)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted) return
      await useAgentWorkflowsStore.getState().loadInstances(gateway, { silent: true, signal })
    },
    [gateway],
  )
  const { degraded } = useSilentPolling(poll, { intervalMs: 15_000, enabled: selectedInstanceId === '' && status === 'ready' })

  const onSelect = (instanceId: string) => {
    navigate(`/agent/workflows?view=instances&instanceId=${encodeURIComponent(instanceId)}`)
  }

  if (selectedInstanceId !== '') {
    return <InstanceDetailSection instanceId={selectedInstanceId} />
  }

  const demo = !isDockerRuntime()

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-x-auto panel-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <ListTodo aria-hidden size={15} className="text-fg-subtle" />
            <h2 className="text-sm font-semibold">工作流实例</h2>
            {demo ? <span className="text-xs text-fg-subtle">（演示数据）</span> : null}
          </div>
          <RefreshButton onPress={() => void load(gateway)} busy={reloading} formControl />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2" role="group" aria-label="实例状态筛选">
          <button
            type="button"
            aria-pressed={statusFilter === undefined}
            onClick={() => void setStatusFilter(gateway, undefined)}
            className={CTL_CHIP}
          >
            全部
          </button>
          {STATUS_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={statusFilter === value}
              onClick={() => void setStatusFilter(gateway, value)}
              className={CTL_CHIP}
            >
              {AGENT_WORKFLOW_STATUS_LABELS[value]}
            </button>
          ))}
        </div>
        <BusyVeil busy={reloading} />
        {status === 'loading' || status === 'idle' ? <div className="p-4"><LoadingState /></div> : null}
        {status === 'error' ? (
          <div className="p-4">
            <ErrorState description={errorMessage} onRetry={() => void load(gateway)} />
          </div>
        ) : null}
        {status === 'ready' && items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={statusFilter === undefined ? '暂无工作流实例' : `没有状态为「${AGENT_WORKFLOW_STATUS_LABELS[statusFilter]}」的实例`}
              description="从「模板」视图选择模板创建实例；实例按服务端状态推进，此处 15 秒静默轮询刷新。"
            />
          </div>
        ) : null}
        {status === 'ready' && items.length > 0 ? (
          <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[17%]" />
              <col className="w-[12%]" />
              <col className="w-[11%]" />
              <col className="w-[14%]" />
              <col className="w-[28%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead>
              <tr>
                {['实例', '模板', '状态', '恢复动作', '预算用量（模型请求 / token / 结果）', '更新时间'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((instance) => (
                <tr key={instance.id} className="cursor-pointer transition-colors hover:bg-surface-raised" onClick={() => onSelect(instance.id)}>
                  <td className="border-b border-line px-3 py-2.5">
                    <span className="font-mono text-xs text-fg">{instance.id}</span>
                    <span className="ml-1 text-xs text-fg-subtle">{instance.languageVersion ?? 'v1'}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted">
                    {instance.definitionId}
                    <span className="ml-1 text-xs text-fg-subtle">r{instance.definitionRevision}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      <AgentWorkflowStatusTag status={instance.status} />
                      {instance.cancelRequestedAt !== undefined && instance.status !== 'cancelled' ? (
                        <span className="text-xs text-warning">已请求取消</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">
                    {instance.allowedActions.length === 0 ? '—' : instance.allowedActions.map((action) => recoveryActionLabel(action)).join(' / ')}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <WorkflowUsageSummary instance={instance} />
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums text-fg-muted">
                    {formatDateTime(instance.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {status === 'ready' && hasMore ? (
          <div className="flex justify-center border-t border-line px-4 py-2">
            <button type="button" className={CTL_SECONDARY} onClick={() => void loadMore(gateway)}>
              加载更多实例
            </button>
          </div>
        ) : null}
      </div>
      {degraded ? (
        <p role="status" className="text-xs text-warning">
          连接中断，正在重试
        </p>
      ) : null}
    </div>
  )
}

function recoveryActionLabel(action: AgentWorkflowInstance['allowedActions'][number]): string {
  const labels: Record<string, string> = {
    continue: '继续推进',
    'renew-approval': '重新请求审批',
    retry: '重新尝试步骤',
    'accept-result': '补录已确认结果',
  }
  return labels[action] ?? action
}

function WorkflowUsageSummary({ instance }: { instance: AgentWorkflowInstance }) {
  const rows = workflowUsageRows(instance)
  const model = rows.find((row) => row.key === 'modelRequests')
  const tokens = rows.find((row) => row.key === 'tokens')
  const bytes = rows.find((row) => row.key === 'resultBytes')
  return (
    <span className="text-xs tabular-nums text-fg-muted">
      {model?.usedText} / {model?.limitText} · {tokens?.usedText} / {tokens?.limitText} · {bytes ? `${bytes.usedText} / ${bytes.limitText}` : ''}
    </span>
  )
}

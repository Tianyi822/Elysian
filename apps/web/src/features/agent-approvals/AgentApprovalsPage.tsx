import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { RefreshButton } from '../../components/RefreshState'
import { CTL_CHIP } from '../../components/formControl'
import { X } from '../../components/icons'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentApprovalsStore } from '../../stores/agentApprovalsStore'
import { ApprovalDetailDialog, ApprovalListSection } from './ApprovalListSection'
import { BarrierListSection } from './BarrierListSection'
import { CapabilityRevokePanel } from './CapabilityRevokePanel'
import { LockListSection } from './LockListSection'

/**
 * 审批与治理页（Ely 七页之一，整体覆写地基占位）。深链契约（模块间导航只许查询参数）：
 *   /agent/approvals?tab=approvals|barriers|locks&runId=<runId>&workflowId=<workflowId>
 * - tab 三页签：待审批（默认）、执行屏障、资源租约；每页签内嵌能力撤销面板；
 * - runId 深链在前端过滤全量数组；workflowId 经服务端查询参数过滤审批与屏障
 *   （/resource-locks 不接受查询参数，租约只做前端过滤）；
 * - 六态：首次加载 LoadingState、内核不可用 AgentUnavailableState、空 EmptyState、
 *   错误 ErrorState＋重试、无权限由全局 RequireArea 承接、就绪态刷新只盖 BusyVeil；
 * - 页签挂载 10 秒静默轮询（useSilentPolling：不重叠、隐藏暂停、失败退避），
 *   断网降级提示 role=status；刷新/断网不重放任何提交（写动作全部无 requestId）。
 */

const TABS = [
  { value: 'approvals', label: '待审批' },
  { value: 'barriers', label: '执行屏障' },
  { value: 'locks', label: '资源租约' },
] as const

type ApprovalsTab = (typeof TABS)[number]['value']

function parseTab(value: string | null): ApprovalsTab {
  return TABS.some((tab) => tab.value === value) ? (value as ApprovalsTab) : 'approvals'
}

export function AgentApprovalsPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = parseTab(searchParams.get('tab'))
  const runId = searchParams.get('runId') ?? undefined
  const workflowId = searchParams.get('workflowId') ?? undefined
  const [detailApprovalId, setDetailApprovalId] = useState<string | undefined>(undefined)

  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const loadRuntime = useAgentRuntimeStore((state) => state.load)

  const setFilters = useAgentApprovalsStore((state) => state.setFilters)
  const loadApprovals = useAgentApprovalsStore((state) => state.loadApprovals)
  const loadBarriers = useAgentApprovalsStore((state) => state.loadBarriers)
  const loadLocks = useAgentApprovalsStore((state) => state.loadLocks)
  const loadOperations = useAgentApprovalsStore((state) => state.loadOperations)
  const approvalsStatus = useAgentApprovalsStore((state) => state.approvalsStatus)
  const barriersStatus = useAgentApprovalsStore((state) => state.barriersStatus)
  const locksStatus = useAgentApprovalsStore((state) => state.locksStatus)
  const barriers = useAgentApprovalsStore((state) => state.barriers)
  const operationsByRun = useAgentApprovalsStore((state) => state.operationsByRun)
  const approvalsReloading = useAgentApprovalsStore((state) => state.approvalsReloading)
  const barriersReloading = useAgentApprovalsStore((state) => state.barriersReloading)
  const locksReloading = useAgentApprovalsStore((state) => state.locksReloading)
  const reloading = tab === 'approvals' ? approvalsReloading : tab === 'barriers' ? barriersReloading : locksReloading
  const approvalsError = useAgentApprovalsStore((state) => state.approvalsError)
  const barriersError = useAgentApprovalsStore((state) => state.barriersError)
  const locksError = useAgentApprovalsStore((state) => state.locksError)
  // 已有内容时的刷新失败：列表保留旧内容，错误以行内提示呈现，不整块换错误态。
  const staleError = tab === 'approvals'
    ? approvalsStatus === 'ready' ? approvalsError : undefined
    : tab === 'barriers'
      ? barriersStatus === 'ready' ? barriersError : undefined
      : locksStatus === 'ready' ? locksError : undefined

  useEffect(() => {
    void loadRuntime(gateway)
  }, [gateway, loadRuntime])

  useEffect(() => {
    setFilters({ runId, workflowId })
  }, [setFilters, runId, workflowId])

  // 当前页签的首轮加载（已有内容时静默，只盖 BusyVeil）。
  useEffect(() => {
    if (tab === 'approvals') void loadApprovals(gateway)
    else if (tab === 'barriers') void loadBarriers(gateway)
    else void loadLocks(gateway)
  }, [gateway, tab, runId, workflowId, loadApprovals, loadBarriers, loadLocks])

  // 屏障页签需要 Run 操作概要：按可见屏障逐个读取并缓存（重复读取被单飞拦截）。
  useEffect(() => {
    if (tab !== 'barriers') return
    for (const barrier of barriers) {
      if (operationsByRun[barrier.runId] === undefined) void loadOperations(gateway, barrier.runId).catch(() => undefined)
    }
  }, [gateway, tab, barriers, operationsByRun, loadOperations])

  const pollTask = (signal: AbortSignal) => {
    if (tab === 'approvals') return loadApprovals(gateway, { silent: true, signal })
    if (tab === 'barriers') return loadBarriers(gateway, { silent: true, signal })
    return loadLocks(gateway, { silent: true, signal })
  }
  const { degraded } = useSilentPolling(pollTask, { intervalMs: 10_000 })

  const setTab = (next: ApprovalsTab) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'approvals') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }
  const clearFilter = (key: 'runId' | 'workflowId') => {
    const params = new URLSearchParams(searchParams)
    params.delete(key)
    setSearchParams(params, { replace: true })
  }
  const refresh = () => {
    if (tab === 'approvals') void loadApprovals(gateway)
    else if (tab === 'barriers') void loadBarriers(gateway)
    else void loadLocks(gateway)
  }

  if (status === 'loading' || status === 'idle') return <LoadingState />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void loadRuntime(gateway)} />
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="审批与治理页签" className="flex flex-wrap items-center gap-2">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              className={CTL_CHIP}
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runId ? (
            <span className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs tabular-nums text-fg-muted">
              Run 过滤：{runId}
              <button type="button" onClick={() => clearFilter('runId')} title="清除 Run 过滤" aria-label="清除 Run 过滤" className="text-fg-subtle hover:text-fg">
                <X aria-hidden size={12} />
              </button>
            </span>
          ) : null}
          {workflowId ? (
            <span className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs tabular-nums text-fg-muted">
              工作流过滤：{workflowId}
              <button type="button" onClick={() => clearFilter('workflowId')} title="清除工作流过滤" aria-label="清除工作流过滤" className="text-fg-subtle hover:text-fg">
                <X aria-hidden size={12} />
              </button>
            </span>
          ) : null}
          {!isDockerRuntime() ? <span role="status" className="text-xs text-fg-subtle">演示数据</span> : null}
          {degraded ? <span role="status" className="text-xs text-warning">连接中断，正在重试</span> : null}
          {staleError !== undefined && !degraded ? (
            <span role="status" className="text-xs text-warning" title={staleError}>上次刷新失败，展示的是旧数据</span>
          ) : null}
          <RefreshButton onPress={refresh} busy={reloading} label="刷新当前页签" />
        </div>
      </div>

      {tab === 'approvals' ? (
        <ApprovalListSection runId={runId} onOpenDetail={setDetailApprovalId} />
      ) : tab === 'barriers' ? (
        <BarrierListSection runId={runId} />
      ) : (
        <LockListSection runId={runId} />
      )}

      <CapabilityRevokePanel />

      {detailApprovalId !== undefined ? (
        <ApprovalDetailDialog approvalId={detailApprovalId} onClose={() => setDetailApprovalId(undefined)} />
      ) : null}
    </section>
  )
}

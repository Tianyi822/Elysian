import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { RUNTIME_RUN_STATUSES } from '@elysian/contracts'
import type { RuntimeRunStatus } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import { runIsTerminal } from './runDisplay'
import { RunsRuntimeCard } from './RunsRuntimeCard'
import { RunsListView } from './RunsListView'
import { RunDetailView } from './RunDetailView'
import { BatchSubmitForm } from './BatchSubmitForm'

/**
 * 运行记录页（agent-runs 模块；地基占位由本文件整体覆写）。
 * 深链契约（模块间导航只许查询参数，不得新增路由）：
 *   /agent/runs?runId=<runId>&status=<RuntimeRunStatus>
 * - runId 存在即进入该 Run 的详情视图；
 * - status 是列表的服务端单选过滤（单值；多状态过滤不在此页实现）。
 * 轮询口径：详情页 Run 非终态 3 秒、列表 15 秒，全部静默（不白屏、不驱动
 * 刷新按钮）；连续失败由 useSilentPolling 的 degraded 标「连接中断，正在重试」。
 * 内核不可用（/runtime available:false 或 503 家族）时整页 AgentUnavailableState。
 */
export function AgentRunsPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()
  const runId = searchParams.get('runId') ?? undefined
  const statusParam = searchParams.get('status')
  const statusFilter = statusParam !== null && (RUNTIME_RUN_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam as RuntimeRunStatus
    : undefined

  const runtimeStatus = useAgentRuntimeStore((state) => state.status)
  const runtimeInfo = useAgentRuntimeStore((state) => state.info)
  const runtimeError = useAgentRuntimeStore((state) => state.errorMessage)
  const loadRuntime = useAgentRuntimeStore((state) => state.load)

  const list = useAgentRunsStore((state) => state.list)
  const detail = useAgentRunsStore((state) => state.detail)
  const loadList = useAgentRunsStore((state) => state.loadList)
  const setFilters = useAgentRunsStore((state) => state.setFilters)
  const openRun = useAgentRunsStore((state) => state.openRun)
  const closeRun = useAgentRunsStore((state) => state.closeRun)
  const refreshRun = useAgentRunsStore((state) => state.refreshRun)

  useEffect(() => {
    void loadRuntime(gateway)
  }, [gateway, loadRuntime])

  // 列表过滤随 URL 的 status 单值同步；深链与页内切换共用同一条路。
  useEffect(() => {
    void setFilters(gateway, statusFilter === undefined ? {} : { status: statusFilter })
  }, [gateway, setFilters, statusFilter])

  // 详情：runId 变化即切换（旧详情的过期响应由 store 的序号丢弃）。
  useEffect(() => {
    if (runId === undefined) {
      closeRun()
      return
    }
    void openRun(gateway, runId)
  }, [gateway, openRun, closeRun, runId])

  const listPolling = useSilentPolling(
    (signal) => loadList(gateway, { silent: true, signal }),
    { intervalMs: 15_000, enabled: runId === undefined && list.status === 'ready' },
  )
  const detailRun = detail?.run
  const detailPolling = useSilentPolling(
    (signal) => refreshRun(gateway, { silent: true, signal }),
    { intervalMs: 3_000, enabled: runId !== undefined && !runIsTerminal(detailRun) },
  )
  const degraded = listPolling.degraded || detailPolling.degraded

  const openRunFromList = useCallback((nextRunId: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current)
      params.set('runId', nextRunId)
      return params
    }, { replace: false })
  }, [setSearchParams])

  const backToList = useCallback(() => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current)
      params.delete('runId')
      return params
    }, { replace: false })
  }, [setSearchParams])

  const submittedJump = useCallback((nextRunId: string) => {
    // 202/200 幂等提交成功后跳详情并靠 3 秒轮询推进；刷新页面不重放提交。
    openRunFromList(nextRunId)
  }, [openRunFromList])

  if (runtimeStatus === 'loading' || runtimeStatus === 'idle') return <LoadingState />
  if (runtimeStatus === 'error') {
    return <ErrorState description={runtimeError} onRetry={() => void loadRuntime(gateway)} />
  }
  if (runtimeInfo !== undefined && !runtimeInfo.available) {
    return <AgentUnavailableState reason={runtimeInfo.reason} worker={runtimeInfo.worker} storage={runtimeInfo.storage} />
  }
  if (runtimeInfo === undefined) return <LoadingState />

  return (
    <div className="flex flex-col gap-4">
      {degraded ? (
        <p role="status" className="text-xs text-warning">连接中断，正在重试；页面保留已读取的内容。</p>
      ) : null}
      <RunsRuntimeCard info={runtimeInfo} />
      {runId === undefined ? (
        <>
          <RunsListView onOpenRun={openRunFromList} />
          <BatchSubmitForm onSubmitted={submittedJump} />
        </>
      ) : (
        <RunDetailView runId={runId} onBack={backToList} />
      )}
    </div>
  )
}

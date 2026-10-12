import { useState } from 'react'
import type { RuntimeCall, RuntimeEvent, RuntimeRun } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { JsonView } from '../../components/agent/JsonView'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_DANGER, CTL_SECONDARY } from '../../components/formControl'
import { formatLoginTime } from '../../components/format'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import {
  RUN_KIND_LABELS,
  RUN_PHASE_LABELS,
  driverLabel,
  formatActiveDuration,
  formatBytes,
  interruptedReasonText,
  isMemoryPhase,
  runCancelRequested,
  runIsTerminal,
  runKindOf,
  usageUnknown,
} from './runDisplay'

/*
 * Run 详情视图：状态卡（Status、phase 八相、已请求取消与终态裁决分开、
 * EndReason、workflowFrozenFrom）、usage/limits（actualTokens/cachedTokens 缺省
 * 显示「未知」不记零）、事件流（seq 十进制字符串等宽呈现，按游标增量与
 * auto-load 更多）、工具调用列表（Call.Tool 原样展示不过滤、argumentsJson
 * 原文经 JsonView、interrupted 调用标注结果未确认）与取消按钮。
 * interrupted 不提供任何重试按钮，文案注明不自动重跑。
 */

function StatusCard({ run }: { run: RuntimeRun }) {
  const terminal = runIsTerminal(run)
  const cancelRequested = runCancelRequested(run)
  return (
    <section aria-label="Run 状态" className="panel-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AgentRunStatusTag status={run.status} />
        {run.phase !== undefined ? (
          <span className="text-xs text-fg-muted">
            phase：{RUN_PHASE_LABELS[run.phase]}
            {isMemoryPhase(run.phase) && run.status === 'running' ? '（工作记忆整理，不占用新的模型额度）' : ''}
          </span>
        ) : null}
        <span className="text-xs text-fg-subtle">{RUN_KIND_LABELS[runKindOf(run)]} · 驱动 {driverLabel(run)}</span>
      </div>
      {cancelRequested ? (
        <p role="status" className="mt-2 text-xs text-warning">已请求取消（等待执行停止）——取消请求已落盘，运行是否停止以服务端终态为准。</p>
      ) : null}
      {run.status === 'cancelled' && run.cancelRequestedAt !== undefined ? (
        <p className="mt-2 text-xs text-fg-muted">已于 {formatLoginTime(run.cancelRequestedAt)} 请求取消，并在 {run.endedAt !== undefined ? formatLoginTime(run.endedAt) : '—'} 裁决为已取消。</p>
      ) : null}
      {run.status === 'interrupted' ? (
        <>
          <p role="status" className="mt-2 text-xs text-danger">{interruptedReasonText(run)}</p>
          <p className="mt-1 text-xs text-fg-muted">中断的 Run 不会自动重跑；如需继续请另行新建任务。</p>
        </>
      ) : null}
      {run.error !== undefined && run.status === 'failed' ? (
        <p className="mt-2 text-xs text-danger">失败原因：{run.error.message}（{run.error.code}）</p>
      ) : null}
      {run.warning !== undefined ? (
        <p className="mt-2 text-xs text-warning">警告：{run.warning.message}（{run.warning.code}）</p>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 lg:grid-cols-4">
        <div><dt className="text-xs text-fg-muted">Run ID</dt><dd className="font-mono text-xs">{run.id}</dd></div>
        <div><dt className="text-xs text-fg-muted">任务</dt><dd className="font-mono text-xs">{run.taskId}</dd></div>
        <div><dt className="text-xs text-fg-muted">会话</dt><dd className="font-mono text-xs">{run.sessionId ?? '—'}</dd></div>
        <div><dt className="text-xs text-fg-muted">requestId</dt><dd className="font-mono text-xs">{run.requestId ?? '—'}</dd></div>
        <div><dt className="text-xs text-fg-muted">创建时间</dt><dd className="text-xs tabular-nums">{formatLoginTime(run.createdAt)}</dd></div>
        <div><dt className="text-xs text-fg-muted">开始时间</dt><dd className="text-xs tabular-nums">{run.startedAt !== undefined ? formatLoginTime(run.startedAt) : '—'}</dd></div>
        <div><dt className="text-xs text-fg-muted">结束时间</dt><dd className="text-xs tabular-nums">{run.endedAt !== undefined ? formatLoginTime(run.endedAt) : terminal ? '—' : '未结束'}</dd></div>
        <div><dt className="text-xs text-fg-muted">活动执行时长</dt><dd className="text-xs tabular-nums">{formatActiveDuration(run.activeMilliseconds)}</dd></div>
        <div><dt className="text-xs text-fg-muted">EndReason</dt><dd className="font-mono text-xs">{run.endReason ?? '—'}</dd></div>
        <div><dt className="text-xs text-fg-muted">lastSeq</dt><dd className="font-mono text-xs tabular-nums">{run.lastSeq}</dd></div>
        {run.workflowId !== undefined ? (
          <div><dt className="text-xs text-fg-muted">工作流</dt><dd className="font-mono text-xs">{run.workflowId}{run.workflowStepId !== undefined ? ` · ${run.workflowStepId}` : ''}{run.workflowAttempt !== undefined ? ` · 第 ${run.workflowAttempt} 次尝试` : ''}</dd></div>
        ) : null}
        {run.workflowFrozenFrom !== undefined ? (
          <div><dt className="text-xs text-fg-muted">冻结前状态</dt><dd className="text-xs">{run.workflowFrozenFrom}（工作流冻结时该 Run 所处状态）</dd></div>
        ) : null}
        {run.memoryStatus !== undefined ? (
          <div><dt className="text-xs text-fg-muted">记忆状态</dt><dd className="text-xs">{run.memoryStatus}</dd></div>
        ) : null}
        {run.model !== undefined ? (
          <div><dt className="text-xs text-fg-muted">模型修订</dt><dd className="text-xs">{run.model.name}（{run.model.model}，修订 {run.model.revision}）</dd></div>
        ) : null}
      </dl>
      {run.input !== undefined ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-muted">接受的任务输入</p>
          <p className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-fg">{run.input}</p>
        </div>
      ) : null}
      {run.snapshot !== undefined ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-muted">能力环境快照（概要）</p>
          <p className="mt-1 text-xs text-fg-muted tabular-nums">
            摘要 {run.snapshot.digest.slice(0, 12)}… · 环境 {run.snapshot.environment.revision} 修订 ·
            工具 {run.snapshot.tools.length} 项 · 资料 {run.snapshot.materials?.length ?? 0} 项 ·
            技能 {run.snapshot.skillSummaries?.length ?? 0} 个 · 执行配置 {run.snapshot.executionProfiles?.length ?? 0} 份 ·
            授权 {run.snapshot.grants?.length ?? 0} 份
          </p>
        </div>
      ) : null}
      {run.selection !== undefined ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-muted">本轮选择（概要）</p>
          <p className="mt-1 text-xs text-fg-muted tabular-nums">
            技能 {run.selection.skills?.length ?? 0} 项 · 资料 {run.selection.resources?.length ?? 0} 项 · 提示 {run.selection.prompts?.length ?? 0} 条 ·
            输入 {run.selection.content.length} 字符 · requestId {run.selection.requestId}
          </p>
        </div>
      ) : null}
    </section>
  )
}

function UsageCard({ run }: { run: RuntimeRun }) {
  const usage = run.usage
  return (
    <section aria-label="用量与限额" className="panel-surface p-4">
      <h3 className="text-sm font-medium">用量与限额</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 lg:grid-cols-4">
        <div><dt className="text-xs text-fg-muted">工具调用</dt><dd className="text-xs tabular-nums">{usage.calls}</dd></div>
        <div><dt className="text-xs text-fg-muted">结果字节</dt><dd className="text-xs tabular-nums">{formatBytes(usage.resultBytes)}</dd></div>
        <div><dt className="text-xs text-fg-muted">模型请求</dt><dd className="text-xs tabular-nums">{usage.modelRequests === undefined ? '未知' : String(usage.modelRequests)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Token（估算）</dt><dd className="text-xs tabular-nums">{usage.estimatedTokens === undefined ? '未知' : String(usage.estimatedTokens)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Token（供应商报告）</dt><dd className="text-xs tabular-nums">{usageUnknown(usage.actualTokens)}</dd></div>
        <div><dt className="text-xs text-fg-muted">缓存命中 Token</dt><dd className="text-xs tabular-nums">{usageUnknown(usage.cachedTokens)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Token 预算</dt><dd className="text-xs tabular-nums">{run.limits.tokenBudget === undefined ? '未报告' : String(run.limits.tokenBudget)}</dd></div>
        <div><dt className="text-xs text-fg-muted">活动时限</dt><dd className="text-xs tabular-nums">{formatActiveDuration(run.limits.runTimeoutSeconds * 1000)}</dd></div>
      </dl>
      {usage.actualTokens === undefined ? (
        <p className="mt-2 text-xs text-fg-subtle">供应商未报告实际 Token 时显示「未知」，不补记为零；估算值与供应商报告分开呈现。</p>
      ) : null}
    </section>
  )
}

function EventRow({ event }: { event: RuntimeEvent }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0">
      <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-fg-muted" title="事件序号（十进制字符串）">{event.seq}</span>
      <span className="font-mono text-xs">{event.type}</span>
      <span className="text-xs tabular-nums text-fg-subtle">{formatLoginTime(event.at)}</span>
      {event.callId !== undefined ? <span className="font-mono text-xs text-fg-subtle">call {event.callId}</span> : null}
      {event.stepIndex !== undefined ? <span className="text-xs tabular-nums text-fg-subtle">步骤 {event.stepIndex}</span> : null}
      {event.data !== undefined ? (
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface p-1.5 font-mono text-xs whitespace-pre-wrap break-all text-fg">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      ) : null}
    </li>
  )
}

function CallRow({ call }: { call: RuntimeCall }) {
  const unknownOutcome = call.status === 'interrupted'
  return (
    <li className="border-b border-line px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-fg-muted">步骤 {call.stepIndex}</span>
        <span className="font-mono text-xs">{call.tool}</span>
        <AgentRunStatusTag status={call.status} />
        {call.truncated ? <span className="text-xs text-warning">结果已截断</span> : null}
        {unknownOutcome ? (
          <span className="text-xs text-warning" role="status">结果未确认：中断时调用仍在途，实际结果以服务端执行屏障核实为准</span>
        ) : null}
      </div>
      <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
        {call.operationId !== undefined ? <div className="flex gap-1"><dt className="text-xs text-fg-muted">operation</dt><dd className="font-mono text-xs">{call.operationId}</dd></div> : null}
        {call.modelRequestId !== undefined ? <div className="flex gap-1"><dt className="text-xs text-fg-muted">model 请求</dt><dd className="font-mono text-xs">{call.modelRequestId}</dd></div> : null}
        {call.modelCallId !== undefined ? <div className="flex gap-1"><dt className="text-xs text-fg-muted">model 调用</dt><dd className="font-mono text-xs">{call.modelCallId}</dd></div> : null}
        <div className="flex gap-1"><dt className="text-xs text-fg-muted">开始</dt><dd className="text-xs tabular-nums">{call.startedAt !== undefined ? formatLoginTime(call.startedAt) : '—'}</dd></div>
        <div className="flex gap-1"><dt className="text-xs text-fg-muted">结束</dt><dd className="text-xs tabular-nums">{call.endedAt !== undefined ? formatLoginTime(call.endedAt) : '—'}</dd></div>
      </dl>
      {call.argumentsJson !== undefined ? (
        <div className="mt-2">
          <JsonView text={call.argumentsJson} label="调用参数原文（argumentsJson）" />
        </div>
      ) : null}
      {call.error !== undefined ? (
        <p className="mt-2 text-xs text-danger">调用失败：{call.error.message}（{call.error.code}）</p>
      ) : null}
      {call.result !== undefined ? (
        <div className="mt-2">
          <JsonView text={JSON.stringify(call.result, null, 2)} label="调用结果（服务端已解析的 JSON 值）" />
        </div>
      ) : null}
    </li>
  )
}

export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const gateway = useGateway()
  const detail = useAgentRunsStore((state) => state.detail)
  const refreshRun = useAgentRunsStore((state) => state.refreshRun)
  const loadMoreEvents = useAgentRunsStore((state) => state.loadMoreEvents)
  const loadMoreCalls = useAgentRunsStore((state) => state.loadMoreCalls)
  const cancelRun = useAgentRunsStore((state) => state.cancelRun)
  const notify = useNotificationStore((state) => state.notify)
  const [cancelError, setCancelError] = useState<string | undefined>(undefined)
  const run = detail?.run
  const terminal = runIsTerminal(run)

  const onCancel = (): void => {
    setCancelError(undefined)
    cancelRun(gateway, runId)
      .then((result) => {
        if (result.status === 'cancelled') {
          notify({ tone: 'info', message: `Run ${runId} 已取消（终态裁决完成）` })
        } else {
          notify({ tone: 'info', message: `取消请求已提交，等待执行停止（${runId}）` })
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '取消请求失败'
        setCancelError(message)
        notify({ tone: 'danger', message })
      })
  }

  if (detail === undefined || detail.runId !== runId) return <LoadingState label="读取 Run 详情…" />
  if (detail.status === 'error') {
    return (
      <ErrorState
        title="Run 读取失败"
        description={detail.errorMessage}
        onRetry={() => void refreshRun(gateway)}
        action={(
          <button type="button" className={CTL_SECONDARY} onClick={onBack}>返回运行列表</button>
        )}
      />
    )
  }
  if (detail.status === 'loading' || run === undefined) return <LoadingState label="读取 Run 详情…" />

  return (
    <div className="busy-host relative flex flex-col gap-4">
      <BusyVeil busy={detail.refreshing} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={CTL_SECONDARY} onClick={onBack}>返回运行列表</button>
        <div className="flex items-center gap-2">
          {!terminal && run.cancelRequestedAt === undefined ? (
            <button type="button" className={CTL_DANGER} onClick={onCancel} disabled={detail.cancelling} title={terminal ? 'Run 已到终态，不能取消' : '请求取消；是否停止以服务端终态为准'}>
              {detail.cancelling ? '提交取消请求中…' : '取消该 Run'}
            </button>
          ) : null}
          <RefreshButton onPress={() => void refreshRun(gateway)} busy={detail.refreshing} label="刷新 Run 详情" />
        </div>
      </div>
      {terminal && run.cancelRequestedAt === undefined && run.status !== 'cancelled' ? (
        <p className="text-xs text-fg-subtle">Run 已到终态，取消按钮不可用。</p>
      ) : null}
      {cancelError !== undefined ? <p role="alert" className="text-xs text-danger">{cancelError}</p> : null}
      <StatusCard run={run} />
      <UsageCard run={run} />
      <section aria-label="Run 事件流" className="panel-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">事件流（已到 seq {detail.eventsCursor}）</h3>
          <button
            type="button"
            className={CTL_SECONDARY}
            disabled={!detail.eventsHasMore || detail.eventsLoadingMore}
            onClick={() => void loadMoreEvents(gateway)}
          >
            {detail.eventsLoadingMore ? '加载中…' : detail.eventsHasMore ? '加载更多事件' : '已全部加载'}
          </button>
        </div>
        {detail.events.length === 0 ? (
          <p className="mt-2 text-xs text-fg-muted">暂无事件；事件按 seq 增量读取，序号为十进制字符串。</p>
        ) : (
          <ul className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-line">
            {detail.events.map((event) => <EventRow key={event.seq} event={event} />)}
          </ul>
        )}
      </section>
      <section aria-label="Run 工具调用" className="panel-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">工具调用（{detail.calls.length} 条）</h3>
          <button
            type="button"
            className={CTL_SECONDARY}
            disabled={!detail.callsHasMore || detail.callsLoadingMore}
            onClick={() => void loadMoreCalls(gateway)}
          >
            {detail.callsLoadingMore ? '加载中…' : detail.callsHasMore ? '加载更多调用' : '已全部加载'}
          </button>
        </div>
        {detail.calls.length === 0 ? (
          <p className="mt-2 text-xs text-fg-muted">暂无工具调用；调用按步骤游标分页读取，工具名原样展示。</p>
        ) : (
          <ul className="mt-2 rounded-lg border border-line">
            {detail.calls.map((call) => <CallRow key={call.id} call={call} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

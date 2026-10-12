import { useEffect } from 'react'
import type { AgentSession, RuntimeTask } from '@elysian/contracts'
import { runtimeRunIsActive } from '@elysian/contracts'
import { Link } from 'react-router'
import { Brain, History, ListTodo, Timer } from '../../components/icons'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { JsonView } from '../../components/agent/JsonView'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkbenchStore, type WorkbenchDetailTab } from '../../stores/agentWorkbenchStore'
import type { ElysianGateway } from '../../contracts/adapters'
import { MEMORY_STATUS_LABELS, PHASE_LABELS, formatWorkbenchBytes, isCancelRequested, isConsolidating, usageRows } from './workbenchDisplay'
import { WorkbenchWorkspace } from './WorkbenchWorkspace'

/*
 * 右栏详情面板：运行 / 工作记忆 / 模型请求 / 工作区 四页签。
 * 「整理中」＝Run running 且 phase 为 checkpoint/final-memory；「已请求取消」
 * （cancelRequestedAt 非空且未终态）与「已取消」（cancelled 终态）严格分栏；
 * interrupted 不提供重试。取消经 gateway.agentRuns.cancelRun（POST /runs/{id}/cancel
 * 的唯一网关接缝），受理不等于已停止。gateway 由页面注入。
 */

const TABS: readonly { value: WorkbenchDetailTab; label: string }[] = [
  { value: 'run', label: '运行' },
  { value: 'facts', label: '执行事实' },
  { value: 'memory', label: '工作记忆' },
  { value: 'requests', label: '模型请求' },
  { value: 'workspace', label: '工作区' },
]

export function WorkbenchDetail({
  gateway,
  task,
  session,
}: {
  gateway: ElysianGateway
  task: RuntimeTask | undefined
  session: AgentSession | undefined
}) {
  const detailTab = useAgentWorkbenchStore((state) => state.detailTab)
  const setDetailTab = useAgentWorkbenchStore((state) => state.setDetailTab)

  return (
    <section aria-label="任务详情面板" className="flex min-h-0 flex-col panel-surface">
      <div role="tablist" aria-label="任务详情页签" className="flex gap-1 border-b border-line px-2 py-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={detailTab === tab.value}
            onClick={() => setDetailTab(tab.value)}
            className={`rounded-lg px-2 py-1 text-[11px] transition-colors ${detailTab === tab.value ? 'bg-surface-raised font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto hover-scrollbar p-3">
        {task === undefined ? (
          <EmptyState title="未选择任务" description="在主区选择一个任务后，这里展示运行状态、工作记忆、模型请求与工作区。" />
        ) : detailTab === 'run' ? (
          <RunPanel gateway={gateway} task={task} />
        ) : detailTab === 'facts' ? (
          <RunFactsPanel gateway={gateway} task={task} />
        ) : detailTab === 'memory' ? (
          <MemoryPanel gateway={gateway} task={task} />
        ) : detailTab === 'requests' ? (
          <RequestsPanel gateway={gateway} task={task} />
        ) : (
          <WorkbenchWorkspace gateway={gateway} task={task} session={session} />
        )}
      </div>
    </section>
  )
}

function RunFactsPanel({ gateway, task }: { gateway: ElysianGateway; task: RuntimeTask }) {
  const runId = useAgentWorkbenchStore((state) => state.selectedRunId) ?? task.latestRun?.id
  const run = useAgentWorkbenchStore((state) => state.selectedRun)
  const status = useAgentWorkbenchStore((state) => state.runFactsStatus)
  const error = useAgentWorkbenchStore((state) => state.runFactsError)
  const operations = useAgentWorkbenchStore((state) => state.operations)
  const contextItems = useAgentWorkbenchStore((state) => state.contextItems)
  const calls = useAgentWorkbenchStore((state) => state.runCalls)
  const events = useAgentWorkbenchStore((state) => state.runEvents)
  const load = useAgentWorkbenchStore((state) => state.loadRunFacts)
  useEffect(() => { if (runId) void load(gateway) }, [gateway, load, runId])

  if (!runId) return <EmptyState title="暂无执行事实" />
  if (status === 'loading' && !run) return <LoadingState label="正在读取执行事实…" />
  if (status === 'error' && !run) return <ErrorState description={error} onRetry={() => void load(gateway)} />
  if (!run) return <EmptyState title="暂无执行事实" />

  return <div className="flex flex-col gap-4 text-xs">
    <p className="break-all text-fg-muted">运行 {run.id} · 环境摘要 {run.snapshot?.digest ?? '未报告'}</p>
    <details className="border-b border-line pb-2"><summary className="cursor-pointer font-medium">能力快照</summary>
      {run.snapshot ? <JsonView label="能力快照" text={JSON.stringify(run.snapshot, null, 2)} /> : <p className="text-fg-subtle">未报告</p>}
    </details>
    <section><h3 className="mb-1 font-medium">操作（{operations.length}）</h3>
      <ol className="space-y-2">{operations.map((operation) => <li key={operation.id} className="border-b border-line pb-2">
        <p className="break-all text-fg">{operation.capability.name} · {operation.status} · 调用 {operation.callIndex + 1}</p>
        <p className="break-all text-fg-subtle">工作区修订 {operation.workspaceRevision} · 快照 {operation.snapshotDigest}</p>
        <JsonView label="操作参数" text={operation.argumentsJson} />
      </li>)}</ol>
    </section>
    <section><h3 className="mb-1 font-medium">上下文资料（{contextItems.length}）</h3>
      <ol className="space-y-2">{contextItems.map((item) => <li key={item.id} className="border-b border-line pb-2">
        <p className="break-all text-fg">{item.source} · {item.path ?? item.ref.id} · 事件 {item.eventSeq}</p>
        <p className="whitespace-pre-wrap break-words text-fg-muted">{item.content}</p>
      </li>)}</ol>
    </section>
    <section><h3 className="mb-1 font-medium">工具调用（{calls.length}）</h3>
      <ol className="space-y-2">{calls.map((call) => <li key={call.id} className="border-b border-line pb-2">
        <p className="break-all text-fg">{call.tool} · {call.status}</p>
        {call.argumentsJson ? <JsonView label="调用参数" text={call.argumentsJson} /> : null}
        {call.result !== undefined ? <JsonView label="调用结果" text={JSON.stringify(call.result, null, 2)} /> : null}
      </li>)}</ol>
    </section>
    <section><h3 className="mb-1 font-medium">事件（{events.length}）</h3>
      <ol className="space-y-1">{events.map((event) => <li key={event.seq} className="break-all border-b border-line pb-1 text-fg-muted">#{event.seq} · {event.type} · {event.at}</li>)}</ol>
    </section>
  </div>
}

function RunPanel({ gateway, task }: { gateway: ElysianGateway; task: RuntimeTask }) {
  const cancelRun = useAgentWorkbenchStore((state) => state.cancelRun)
  const selectedRunId = useAgentWorkbenchStore((state) => state.selectedRunId)
  const selectedRun = useAgentWorkbenchStore((state) => state.selectedRun)
  const runFactsStatus = useAgentWorkbenchStore((state) => state.runFactsStatus)
  const runFactsError = useAgentWorkbenchStore((state) => state.runFactsError)
  const loadRunFacts = useAgentWorkbenchStore((state) => state.loadRunFacts)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const run = selectedRunId ? (selectedRun?.id === selectedRunId ? selectedRun : undefined) : task.latestRun

  useEffect(() => { if (selectedRunId) void loadRunFacts(gateway) }, [gateway, loadRunFacts, selectedRunId])

  if (run === undefined) {
    if (selectedRunId && runFactsStatus === 'error') return <ErrorState description={runFactsError} onRetry={() => void loadRunFacts(gateway)} />
    return selectedRunId ? <LoadingState label="正在读取所选运行…" /> : <EmptyState title="还没有运行" description="提交输入后这里展示最新一轮运行的状态、用量与限额。" />
  }
  const active = runtimeRunIsActive(run.status)
  const consolidating = isConsolidating(run)
  const cancelRequested = isCancelRequested(run)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <AgentRunStatusTag status={run.status} />
        {run.phase !== undefined ? (
          <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">{PHASE_LABELS[run.phase]}</span>
        ) : null}
        {consolidating ? (
          <span className="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] text-info" role="status">整理中</span>
        ) : null}
        {cancelRequested ? (
          <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning" role="status">已请求取消</span>
        ) : null}
        {run.runNumber !== undefined ? <span className="text-[10px] tabular-nums text-fg-subtle">第 {run.runNumber} 轮</span> : null}
      </div>

      {cancelRequested ? (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
          取消请求已提交（{run.cancelRequestedAt !== undefined ? new Date(run.cancelRequestedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''}），
          {run.status === 'running' ? '等待运行停止；是否停止以服务端终态为准。' : '等待服务端确认。'}
        </p>
      ) : null}
      {run.status === 'waiting-approval' ? (
        <p className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-muted">
          等待审批：操作在审批中心处理，批准后 Run 继续推进。
          <Link to={`/agent/approvals?tab=approvals&runId=${encodeURIComponent(run.id)}`} className="ml-1 underline underline-offset-2 hover:text-fg">去审批中心</Link>
        </p>
      ) : null}
      {run.status === 'recovery-required' ? (
        <p className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">等待人工恢复：结果未知，恢复动作以运行记录页按服务端 allowedActions 展示为准。</p>
      ) : null}
      {run.status === 'interrupted' ? (
        <p className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">运行中断：不自动重跑，也不提供盲目重试；请在运行记录页核实后处理。</p>
      ) : null}

      {active ? (
        <button
          type="button"
          disabled={submitting || cancelRequested}
          onClick={() => {
            void inFlightOnly(async () => {
              try {
                await cancelRun(gateway, run.id)
                notify({ tone: 'info', message: '取消请求已提交；运行停止以服务端终态为准' })
              } catch (error) {
                notify({ tone: 'danger', message: error instanceof Error ? error.message : '取消请求失败' })
              }
            })
          }}
          className="self-start rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger disabled:cursor-not-allowed disabled:opacity-50"
          title={cancelRequested ? '取消请求已登记，等待运行停止' : undefined}
        >
          {cancelRequested ? '取消请求已登记' : submitting ? '正在提交…' : '取消运行'}
        </button>
      ) : null}

      {run.error !== undefined ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">失败：{run.error.message}（{run.error.code}）</p>
      ) : null}
      {run.warning !== undefined ? (
        <p className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">警告：{run.warning.message}（{run.warning.code}）</p>
      ) : null}

      <div>
        <h3 className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-fg-muted"><Timer aria-hidden size={12} />用量（未知显示未报告，不计为零）</h3>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {usageRows(run.usage).map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-0.5">
              <dt className="text-fg-subtle" title={row.hint}>{row.label}</dt>
              <dd className="tabular-nums text-fg">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">限额（服务端权威）</h3>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <LimitRow label="单 Run 工具调用" value={String(run.limits.maxSteps)} />
          <LimitRow label="Run 时限" value={`${run.limits.runTimeoutSeconds} 秒`} />
          <LimitRow label="工具单次时限" value={`${run.limits.callTimeoutSeconds} 秒`} />
          <LimitRow label="模型请求" value={run.limits.maxModelRequests === undefined ? '未报告' : String(run.limits.maxModelRequests)} />
          <LimitRow label="模型单次时限" value={run.limits.modelTimeoutSeconds === undefined ? '未报告' : `${run.limits.modelTimeoutSeconds} 秒`} />
          <LimitRow label="单次输出 token" value={run.limits.outputTokens === undefined ? '未报告' : String(run.limits.outputTokens)} />
          <LimitRow label="token 总预算" value={run.limits.tokenBudget === undefined ? '未报告' : String(run.limits.tokenBudget)} />
          <LimitRow label="用户输入上限" value={run.limits.userBytes === undefined ? '未报告' : formatWorkbenchBytes(run.limits.userBytes)} />
          <LimitRow label="单次结果" value={formatWorkbenchBytes(run.limits.resultBytes)} />
          <LimitRow label="累计结果" value={formatWorkbenchBytes(run.limits.runResultBytes)} />
        </dl>
      </div>

      {run.input !== undefined ? (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">本轮输入</h3>
          <p className="whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-2 text-xs text-fg">{run.input}</p>
        </div>
      ) : null}
      {run.endedAt !== undefined ? (
        <p className="text-[10px] text-fg-subtle">结束于 {run.endedAt}{run.endReason !== undefined ? ` · ${run.endReason}` : ''}</p>
      ) : null}
    </div>
  )
}

function LimitRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-0.5">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  )
}

function MemoryPanel({ gateway, task }: { gateway: ElysianGateway; task: RuntimeTask }) {
  const workingMemory = useAgentWorkbenchStore((state) => state.workingMemory)
  const workingMemoryStatus = useAgentWorkbenchStore((state) => state.workingMemoryStatus)
  const loadWorkingMemory = useAgentWorkbenchStore((state) => state.loadWorkingMemory)

  useEffect(() => {
    void loadWorkingMemory(gateway)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  if (workingMemoryStatus === 'loading' && workingMemory === undefined) return <LoadingState label="正在读取工作记忆…" />
  if (workingMemoryStatus === 'error' && workingMemory === undefined) {
    return <ErrorState description="读取任务工作记忆失败" />
  }
  if (workingMemory === undefined) return <EmptyState title="暂无工作记忆" />

  const status = workingMemory.memoryStatus

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted"><Brain aria-hidden size={12} />任务工作记忆</span>
        <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted">修订 {workingMemory.revision}</span>
        {status !== undefined ? (
          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${status === 'stale' ? 'border-warning/40 bg-warning/10 text-warning' : status === 'invalidated' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line text-fg-muted'}`}>
            {MEMORY_STATUS_LABELS[status]}
          </span>
        ) : null}
      </div>
      {status === 'stale' ? (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">记忆未整理，下轮将补入：当前展示最近一次已确认的快照。</p>
      ) : null}
      {status === 'invalidated' ? (
        <p role="status" className="rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">记忆已失效：整理失败保留旧记忆，待下一轮重新整理。</p>
      ) : null}
      <p className="text-[10px] text-fg-subtle">
        这是按任务隔离的过程记忆（目标、事实与待办）；跨任务的长期知识在
        <Link to="/agent/memory" className="mx-0.5 underline underline-offset-2 hover:text-fg">长期记忆</Link>
        页管理，两者互不替代。
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-0.5">
          <dt className="text-fg-subtle">覆盖游标</dt>
          <dd className="tabular-nums text-fg">第 {workingMemory.coverage.runNumber} 轮 · 事件 {workingMemory.coverage.eventSeq}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-0.5">
          <dt className="text-fg-subtle">更新时间</dt>
          <dd className="text-fg">{workingMemory.updatedAt}</dd>
        </div>
      </dl>

      <div>
        <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">目标</h3>
        <p className="whitespace-pre-wrap break-words text-xs text-fg">{workingMemory.objective || '—'}</p>
      </div>
      {workingMemory.constraints.length > 0 ? (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">约束</h3>
          <ul className="list-inside list-disc text-xs text-fg">
            {workingMemory.constraints.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">事实（附证据引用）</h3>
        {workingMemory.facts.length === 0 ? <p className="text-xs text-fg-subtle">暂无整理后的事实。</p> : null}
        <ul className="flex flex-col gap-1.5">
          {workingMemory.facts.map((fact, index) => (
            <li key={index} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs">
              <p className="break-words text-fg">{fact.text}</p>
              {fact.sources.length > 0 ? (
                <p className="mt-0.5 text-[10px] text-fg-subtle">
                  证据：{fact.sources.map((source) => `运行 ${source.runId} 事件 ${source.eventSeq}`).join('；')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-1 gap-3">
        <div>
          <h3 className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-fg-muted"><ListTodo aria-hidden size={12} />待办</h3>
          {workingMemory.todos.length === 0 ? <p className="text-xs text-fg-subtle">无</p> : (
            <ul className="list-inside list-disc text-xs text-fg">
              {workingMemory.todos.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">未决问题</h3>
          {workingMemory.openQuestions.length === 0 ? <p className="text-xs text-fg-subtle">无</p> : (
            <ul className="list-inside list-disc text-xs text-fg">
              {workingMemory.openQuestions.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </div>
      </div>
      <div>
        <h3 className="mb-1 text-[11px] font-semibold text-fg-muted">摘要</h3>
        <p className="whitespace-pre-wrap break-words text-xs text-fg">{workingMemory.summary || '—'}</p>
      </div>
    </div>
  )
}

const PURPOSE_LABELS: Record<string, string> = {
  inference: '推理',
  checkpoint: '检查点整理',
  'final-memory': '收尾记忆',
  'workflow-output': '工作流输出',
  'input-material': '输入资料',
}

function RequestsPanel({ gateway, task }: { gateway: ElysianGateway; task: RuntimeTask }) {
  const modelRequests = useAgentWorkbenchStore((state) => state.modelRequests)
  const modelRequestsStatus = useAgentWorkbenchStore((state) => state.modelRequestsStatus)
  const modelRequestsHasMore = useAgentWorkbenchStore((state) => state.modelRequestsHasMore)
  const loadModelRequests = useAgentWorkbenchStore((state) => state.loadModelRequests)
  const run = task.latestRun

  useEffect(() => {
    if (run !== undefined) void loadModelRequests(gateway, run.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id])

  if (run === undefined) return <EmptyState title="还没有运行" description="提交输入后这里展示每轮模型请求。" />
  if (modelRequestsStatus === 'loading' && modelRequests.length === 0) return <LoadingState label="正在读取模型请求…" />
  if (modelRequestsStatus === 'error' && modelRequests.length === 0) return <ErrorState description="读取模型请求失败" />
  if (modelRequests.length === 0) {
    return <EmptyState title="暂无模型请求" description="运行推进后按分页出现；每条带用途、估算 token 与引用关联。" />
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1 text-[11px] font-semibold text-fg-muted"><History aria-hidden size={12} />模型请求（Run {run.id}）</p>
      <ol className="flex flex-col gap-2">
        {modelRequests.map((record) => (
          <li key={record.id} className="rounded-lg border border-line bg-surface px-2 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">#{record.index} {PURPOSE_LABELS[record.purpose] ?? record.purpose}</span>
              <AgentRunStatusTag status={record.status} />
              <span className="tabular-nums text-[10px] text-fg-subtle">估算 {record.estimatedTokens} token</span>
            </div>
            <p className="mt-1 text-[10px] text-fg-subtle">开始 {record.startedAt}{record.endedAt !== undefined ? ` · 结束 ${record.endedAt}` : ''} · 记忆修订 {record.memoryRevision}</p>
            {record.wikiSources !== undefined && record.wikiSources.length > 0 ? (
              <p className="mt-0.5 text-[10px] text-fg-subtle">随上下文 Wiki：{record.wikiSources.map((source) => `${source.pageId}（修订 ${source.revision}）`).join('、')}</p>
            ) : null}
            {record.contextItemIds !== undefined && record.contextItemIds.length > 0 ? (
              <p className="mt-0.5 break-all text-[10px] text-fg-subtle">载入资料：{record.contextItemIds.join('、')}</p>
            ) : null}
            {record.error !== undefined ? (
              <p role="alert" className="mt-1 text-[10px] text-danger">失败：{record.error.message}（{record.error.code}）</p>
            ) : null}
            {record.response !== undefined ? (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {record.response.usage.totalTokens !== undefined ? (
                  <p className="text-[10px] text-fg-subtle">供应商报告：prompt {record.response.usage.promptTokens ?? '未报告'} / completion {record.response.usage.completionTokens ?? '未报告'} / 合计 {record.response.usage.totalTokens}</p>
                ) : (
                  <p className="text-[10px] text-fg-subtle">供应商用量未报告</p>
                )}
                {record.response.toolCalls !== undefined && record.response.toolCalls.length > 0 ? (
                  <div>
                    <p className="text-[10px] text-fg-subtle">工具提议：{record.response.toolCalls.map((call) => call.name).join('、')}</p>
                    <JsonView
                      text={JSON.stringify(record.response.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })), null, 2)}
                      label="工具提议（解析值）"
                      collapseBytes={2048}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {modelRequestsHasMore ? (
        <button
          type="button"
          onClick={() => {
            if (run !== undefined) void loadModelRequests(gateway, run.id, { more: true })
          }}
          className="self-start rounded-lg border border-line px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          加载更多模型请求
        </button>
      ) : null}
    </div>
  )
}

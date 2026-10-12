import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { JsonView } from '../../components/agent/JsonView'
import { EmptyState } from '../../components/states/StateViews'
import { CTL_CARD_ACTION, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { ChevronDown, ChevronRight, History, ScrollText } from '../../components/icons'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { useGateway } from '../../adapters/GatewayProvider'

/**
 * 步骤尝试与事件两个记录面板：inputJson/outputJson 原文（JsonView，不重序列化）、
 * evidence、workspaceRevision、scopeId/nodeId；事件按 seq 十进制字符串排序展示，
 * 分页续读（游标保持字符串，空页保留当前游标）。
 */
export function WorkflowRecordsView() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <AttemptsPanel />
      <EventsPanel />
    </div>
  )
}

function AttemptsPanel() {
  const gateway = useGateway()
  const status = useAgentWorkflowsStore((state) => state.attempts.status)
  const items = useAgentWorkflowsStore((state) => state.attempts.items)
  const hasMore = useAgentWorkflowsStore((state) => state.attempts.hasMore)
  const errorMessage = useAgentWorkflowsStore((state) => state.attempts.errorMessage)
  const loadMore = useAgentWorkflowsStore((state) => state.loadMoreAttempts)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section aria-label="步骤尝试" className="relative overflow-x-auto panel-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <History aria-hidden size={15} className="text-fg-subtle" />
          <h2 className="text-sm font-semibold">步骤尝试</h2>
        </div>
        <span className="text-xs tabular-nums text-fg-subtle">{items.length} 条</span>
      </div>
      {status === 'loading' ? <div className="p-4 text-xs text-fg-muted">正在读取尝试…</div> : null}
      {status === 'error' ? <div className="p-4 text-xs text-danger" role="alert">{errorMessage}</div> : null}
      {status === 'ready' && items.length === 0 ? (
        <div className="p-4">
          <EmptyState title="暂无步骤尝试" description="实例开始推进后，每次派发都会留下一条尝试记录。" />
        </div>
      ) : null}
      {items.length > 0 ? (
        <table className="w-full min-w-[34rem] table-fixed border-separate border-spacing-0 text-left text-sm">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[10%]" />
            <col className="w-[22%]" />
            <col className="w-[18%]" />
            <col className="w-[26%]" />
          </colgroup>
          <thead>
            <tr>
              {['步骤', '尝试', 'Run', '状态', '时间'].map((label) => (
                <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((attempt) => {
              const key = `${attempt.runId}-${attempt.number}`
              const open = expanded === key
              return (
                <Fragment key={key}>
                  <tr className="transition-colors hover:bg-surface-raised">
                    <td className="border-b border-line px-3 py-2 font-mono text-xs text-fg">
                      <button type="button" aria-expanded={open} className="inline-flex items-center gap-1 text-left" onClick={() => setExpanded(open ? null : key)}>
                        {open ? <ChevronDown aria-hidden size={12} /> : <ChevronRight aria-hidden size={12} />}
                        {attempt.stepId}
                      </button>
                    </td>
                    <td className="border-b border-line px-3 py-2 tabular-nums text-xs text-fg-muted">{attempt.number}</td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs text-fg-muted"><Link className="underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(attempt.runId)}`}>{attempt.runId}</Link></td>
                    <td className="border-b border-line px-3 py-2"><AgentRunStatusTag status={attempt.status} /></td>
                    <td className="border-b border-line px-3 py-2 text-xs tabular-nums text-fg-muted">
                      {formatDateTime(attempt.createdAt)}
                      {attempt.endedAt !== undefined ? ` → ${formatDateTime(attempt.endedAt)}` : ''}
                    </td>
                  </tr>
                  {open ? (
                    <tr key={`${key}-detail`}>
                      <td colSpan={5} className="border-b border-line bg-surface-raised/40 px-3 py-3">
                        <div className="flex flex-col gap-2">
                          <JsonView text={attempt.inputJson} label="尝试输入（inputJson 原文）" collapseBytes={1024} />
                          {attempt.outputJson !== undefined ? <JsonView text={attempt.outputJson} label="尝试输出（outputJson 原文）" collapseBytes={1024} /> : null}
                          <dl className="grid gap-x-4 gap-y-1 text-xs md:grid-cols-2">
                            <div className="flex gap-2">
                              <dt className="shrink-0 text-fg-subtle">workspaceRevision</dt>
                              <dd className="tabular-nums text-fg-muted">{attempt.workspaceRevision}</dd>
                            </div>
                            {attempt.scopeId !== undefined ? (
                              <div className="flex gap-2">
                                <dt className="shrink-0 text-fg-subtle">scopeId</dt>
                                <dd className="font-mono text-fg-muted">{attempt.scopeId}</dd>
                              </div>
                            ) : null}
                            {attempt.nodeId !== undefined ? (
                              <div className="flex gap-2">
                                <dt className="shrink-0 text-fg-subtle">nodeId</dt>
                                <dd className="font-mono text-fg-muted">{attempt.nodeId}</dd>
                              </div>
                            ) : null}
                            {attempt.completionSource !== undefined ? (
                              <div className="flex gap-2">
                                <dt className="shrink-0 text-fg-subtle">完成来源</dt>
                                <dd className="text-fg-muted">{attempt.completionSource}</dd>
                              </div>
                            ) : null}
                            {attempt.evidence !== undefined ? (
                              <div className="flex gap-2">
                                <dt className="shrink-0 text-fg-subtle">核实说明</dt>
                                <dd className="text-fg-muted">{attempt.evidence}</dd>
                              </div>
                            ) : null}
                          </dl>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center border-t border-line px-4 py-2">
          <button type="button" className={CTL_SECONDARY} onClick={() => void loadMore(gateway)}>加载更多尝试</button>
        </div>
      ) : null}
    </section>
  )
}

function EventsPanel() {
  const gateway = useGateway()
  const status = useAgentWorkflowsStore((state) => state.events.status)
  const items = useAgentWorkflowsStore((state) => state.events.items)
  const hasMore = useAgentWorkflowsStore((state) => state.events.hasMore)
  const errorMessage = useAgentWorkflowsStore((state) => state.events.errorMessage)
  const loadMore = useAgentWorkflowsStore((state) => state.fetchEventsPage)

  return (
    <section aria-label="工作流事件" className="relative panel-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <ScrollText aria-hidden size={15} className="text-fg-subtle" />
          <h2 className="text-sm font-semibold">事件（seq 增量）</h2>
        </div>
        <span className="text-xs tabular-nums text-fg-subtle">{items.length} 条</span>
      </div>
      {status === 'loading' ? <div className="p-4 text-xs text-fg-muted">正在读取事件…</div> : null}
      {status === 'error' ? <div className="p-4 text-xs text-danger" role="alert">{errorMessage}</div> : null}
      {status === 'ready' && items.length === 0 ? (
        <div className="p-4">
          <EmptyState title="暂无事件" description="实例接受、排队、展开、汇合、恢复与终态都会记录事件。" />
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="flex max-h-[28rem] flex-col divide-y divide-line overflow-y-auto">
          {items.map((event) => (
            <li key={event.seq} className="flex flex-col gap-0.5 px-4 py-2">
              <div className="flex items-baseline gap-2">
                <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-fg-subtle">{event.seq}</span>
                <span className="font-mono text-xs text-fg">{event.type}</span>
                <span className="ml-auto text-xs tabular-nums text-fg-subtle">{formatDateTime(event.at)}</span>
              </div>
              <div className="ml-16 flex flex-wrap gap-x-3 text-xs text-fg-muted">
                {event.stepId !== undefined ? <span className="font-mono">step {event.stepId}</span> : null}
                {event.runId !== undefined ? <span className="font-mono">run {event.runId}</span> : null}
                {event.detail !== undefined && event.detail !== '' ? <span className="min-w-0 break-all">{event.detail}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center border-t border-line px-4 py-2">
          <button type="button" className={CTL_CARD_ACTION} onClick={() => void loadMore(gateway)}>加载更多事件</button>
        </div>
      ) : null}
    </section>
  )
}

import {
  AGENT_STATUS_LABELS,
  RUN_STATUS_LABELS,
  TURN_END_REASON_LABELS,
  responsibilityModuleName,
} from '@elysian/contracts'
import type { AgentRun, RunStatus } from '@elysian/contracts'
import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { DataCell, DataRow, DataTable } from '../../components/DataTable'
import { PageHeader } from '../../components/PageHeader'
import { Section } from '../../components/Section'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { Timeline } from '../../components/Timeline'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import type { TimelineEntry } from '@elysian/contracts'

const RUN_STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: 'neutral',
  running: 'info',
  'waiting-approval': 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

const TOOL_PHASE_LABELS = {
  'pre-execute': '执行前',
  execute: '执行',
  'post-execute': '执行后',
} as const

const DECISION_LABELS = {
  allow: '放行',
  deny: '拒绝',
  ask: '转审批',
} as const

const MODULE_COLUMNS = [
  { key: 'module', header: '职责模块', width: '22%' },
  { key: 'status', header: 'Agent 状态', width: '104px' },
  { key: 'run', header: '当前运行', width: '24%' },
  { key: 'incident', header: '关联事故', width: '18%' },
  { key: 'action', header: '操作', width: '88px' },
]

/** 从事件流里挑出属于这次运行的事件，用于时间线的增量刷新。 */
function eventsForRun(
  events: readonly { id: string; name: string; at: string; payload: unknown }[],
  run: AgentRun,
): TimelineEntry[] {
  return events
    .filter((event) => {
      const payload = event.payload as { moduleId?: string; runId?: string }
      return payload.runId === run.id || payload.moduleId === run.moduleId
    })
    .map((event) => ({
      id: `live-${event.id}`,
      at: event.at,
      kind: 'note' as const,
      actor: '事件流',
      summary: `实时事件 ${event.name}`,
    }))
}

export function AgentRunsPage() {
  const gateway = useGateway()
  const [searchParams, setSearchParams] = useSearchParams()

  const requestedRunId = searchParams.get('run') ?? searchParams.get('focus') ?? undefined

  const status = useAgentRunsStore((state) => state.status)
  const runs = useAgentRunsStore((state) => state.runs)
  const moduleStatuses = useAgentRunsStore((state) => state.moduleStatuses)
  const errorMessage = useAgentRunsStore((state) => state.errorMessage)
  const load = useAgentRunsStore((state) => state.load)

  const recentEvents = useEventStreamStore((state) => state.recent)

  useEffect(() => {
    void load(gateway.runs)
  }, [gateway, load])

  const selectedRun = useMemo(() => {
    if (requestedRunId) {
      const requested = runs.find((run) => run.id === requestedRunId)
      if (requested) return requested
    }
    return (
      runs.find((run) => run.status === 'waiting-approval') ??
      runs.find((run) => run.status === 'running') ??
      runs[0]
    )
  }, [runs, requestedRunId])

  const liveEntries = useMemo(
    () => (selectedRun ? eventsForRun(recentEvents, selectedRun) : []),
    [recentEvents, selectedRun],
  )

  const capabilities = useMemo(() => {
    if (!selectedRun) return []
    const names = new Set<string>()
    for (const turn of selectedRun.turns) {
      for (const step of turn.steps) {
        for (const call of step.toolCalls) names.add(call.name)
      }
    }
    return [...names]
  }, [selectedRun])

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Agent 运行" description="按职责模块查看运行状态与事件时间线。" />
        <ErrorState
          title="Agent 运行加载失败"
          description={errorMessage}
          onRetry={() => void load(gateway.runs)}
        />
      </>
    )
  }

  if (status !== 'ready') {
    return (
      <>
        <PageHeader title="Agent 运行" description="按职责模块查看运行状态与事件时间线。" />
        <LoadingState label="正在加载 Agent 运行…" />
      </>
    )
  }

  const runningCount = moduleStatuses.filter((module) => module.status === 'running').length

  return (
    <>
      <PageHeader
        title="Agent 运行"
        description={`按职责模块查看运行状态。当前 ${runningCount} 个模块有活跃运行，其余空闲。`}
        actions={
          <button
            type="button"
            onClick={() => void load(gateway.runs)}
            className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
          >
            刷新
          </button>
        }
      />

      <Section title="职责模块" description="13 个职责模块的忙闲状态与当前关联的事故。">
        <DataTable label="职责模块" columns={MODULE_COLUMNS}>
          {moduleStatuses.map((module) => {
            const moduleRuns = runs.filter((run) => run.moduleId === module.moduleId)
            const activeRun = module.activeRunId
              ? moduleRuns.find((run) => run.id === module.activeRunId)
              : undefined
            return (
              <DataRow key={module.moduleId}>
                <DataCell>{responsibilityModuleName(module.moduleId)}</DataCell>
                <DataCell>
                  <StatusTag
                    label={AGENT_STATUS_LABELS[module.status]}
                    tone={module.status === 'running' ? 'info' : 'neutral'}
                  />
                </DataCell>
                <DataCell muted>
                  {activeRun ? (
                    <span className="flex flex-col gap-0.5">
                      <code className="text-xs">{activeRun.id}</code>
                      <StatusTag
                        label={RUN_STATUS_LABELS[activeRun.status]}
                        tone={RUN_STATUS_TONE[activeRun.status]}
                      />
                    </span>
                  ) : (
                    '—'
                  )}
                </DataCell>
                <DataCell muted>
                  {module.incidentId ? (
                    <Link className="text-accent underline" to={`/incidents/${module.incidentId}`}>
                      {module.incidentId}
                    </Link>
                  ) : (
                    '—'
                  )}
                </DataCell>
                <DataCell>
                  {activeRun ? (
                    <button
                      type="button"
                      onClick={() => setSearchParams({ run: activeRun.id })}
                      className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg"
                    >
                      查看
                    </button>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                </DataCell>
              </DataRow>
            )
          })}
        </DataTable>
      </Section>

      {selectedRun ? (
        <>
          <Section
            title={`运行 ${selectedRun.id}`}
            description="一次运行以轮次与步骤呈现，不渲染成没有上下文的聊天记录。"
            actions={
              <>
                {selectedRun.incidentId ? (
                  <Link
                    className="text-xs text-accent underline"
                    to={`/incidents/${selectedRun.incidentId}`}
                  >
                    查看关联事故
                  </Link>
                ) : null}
                {capabilities[0] ? (
                  <Link
                    className="text-xs text-accent underline"
                    to={`/skills?capability=${encodeURIComponent(capabilities[0])}`}
                  >
                    查看相关技能
                  </Link>
                ) : null}
              </>
            }
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span>职责模块 {responsibilityModuleName(selectedRun.moduleId)}</span>
              <StatusTag
                label={RUN_STATUS_LABELS[selectedRun.status]}
                tone={RUN_STATUS_TONE[selectedRun.status]}
              />
              <span>
                开始 <time className="tabular-nums">{formatDateTime(selectedRun.startedAt)}</time>
              </span>
              {selectedRun.endedAt ? (
                <span>
                  结束 <time className="tabular-nums">{formatDateTime(selectedRun.endedAt)}</time>
                </span>
              ) : null}
            </div>

            {selectedRun.waitingReason ? (
              <p className="mb-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
                等待原因：{selectedRun.waitingReason}
              </p>
            ) : null}

            {selectedRun.error ? (
              <p className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
                运行失败：{selectedRun.error.message}（结束原因{' '}
                {TURN_END_REASON_LABELS[selectedRun.error.endReason]}）
              </p>
            ) : null}

            {selectedRun.turns.map((turn) => (
              <div key={turn.id} className="mb-2.5 last:mb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="text-xs font-semibold">轮次 {turn.index}</h3>
                  <time className="text-xs tabular-nums text-fg-subtle">
                    {formatDateTime(turn.startedAt)}
                  </time>
                  {turn.endReason ? (
                    <StatusTag label={TURN_END_REASON_LABELS[turn.endReason]} />
                  ) : null}
                </div>
                <ol className="mt-1 space-y-1.5 border-l border-line pl-3">
                  {turn.steps.map((step) => (
                    <li key={step.id}>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-xs tabular-nums text-fg-subtle">
                          步骤 {step.index}
                        </span>
                        <span className="text-sm">{step.title}</span>
                        <time className="text-xs tabular-nums text-fg-subtle">
                          {formatDateTime(step.at)}
                        </time>
                      </div>
                      <ul className="mt-0.5 space-y-0.5 text-xs text-fg-muted">
                        {step.modelRequests.map((request) => (
                          <li key={request.id}>
                            模型请求 · {request.model} · {request.summary}
                            {request.promptTokens === undefined
                              ? ''
                              : ` · 输入 ${request.promptTokens} tokens`}
                          </li>
                        ))}
                        {step.toolCalls.map((call) => (
                          <li key={call.id}>
                            工具调用 · <code>{call.name}</code> · {TOOL_PHASE_LABELS[call.phase]}
                            {call.decision ? ` · 决策 ${DECISION_LABELS[call.decision]}` : ''}
                            {call.durationMs === undefined ? '' : ` · ${call.durationMs}ms`}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </Section>

          <Section
            title="本运行的实时事件"
            description="事件流到达且属于本次运行或本职责模块的事件会即时追加在这里。"
          >
            {liveEntries.length === 0 ? (
              <p className="text-sm text-fg-muted">暂时没有新的实时事件。</p>
            ) : (
              <Timeline entries={liveEntries} />
            )}
          </Section>
        </>
      ) : (
        <EmptyState
          title="没有可查看的运行"
          description="演示数据集里还没有任何 Agent 运行。"
        />
      )}
    </>
  )
}

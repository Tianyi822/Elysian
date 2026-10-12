import type { AgentSession } from '@elysian/contracts'
import { Bot, Plus, Workflow } from '../../components/icons'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import type { ElysianGateway } from '../../contracts/adapters'

/*
 * 左栏会话导航：列表（busy 徽标 + lastSeq 十进制字符串回显）、手动刷新与
 * 「新建会话」入口。选中态驱动主区与详情面板；会话设置入口挂在主区头部。
 */

export function WorkbenchSessions({ gateway, onCreate }: { gateway: ElysianGateway; onCreate(): void }) {
  const sessionsStatus = useAgentWorkbenchStore((state) => state.sessionsStatus)
  const sessions = useAgentWorkbenchStore((state) => state.sessions)
  const sessionsError = useAgentWorkbenchStore((state) => state.sessionsError)
  const sessionsRefreshing = useAgentWorkbenchStore((state) => state.sessionsRefreshing)
  const sessionsHasMore = useAgentWorkbenchStore((state) => state.sessionsHasMore)
  const selectedSessionId = useAgentWorkbenchStore((state) => state.selectedSessionId)
  const selectSession = useAgentWorkbenchStore((state) => state.selectSession)
  const loadSessions = useAgentWorkbenchStore((state) => state.loadSessions)

  return (
    <section aria-label="Ely 会话列表" className="relative flex min-h-0 flex-col panel-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg"><Bot aria-hidden size={14} />会话</h2>
        <div className="flex items-center gap-1">
          <RefreshButton
            label="刷新会话列表"
            onPress={() => void loadSessions(gateway)}
            busy={sessionsRefreshing}
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto hover-scrollbar">
        <BusyVeil busy={sessionsRefreshing} />
        {sessionsStatus === 'loading' ? <LoadingState label="正在加载会话…" /> : null}
        {sessionsStatus === 'error' ? (
          <div className="p-3">
            <ErrorState description={sessionsError} onRetry={() => void loadSessions(gateway)} />
          </div>
        ) : null}
        {sessionsStatus === 'ready' && sessions.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="还没有会话"
              description="创建一个会话开始与 Ely 协作；会话固定模型修订与能力环境。"
              action={(
                <button type="button" onClick={onCreate} className={`${CTL_SECONDARY} mt-1 px-2`}>
                  新建会话
                </button>
              )}
            />
          </div>
        ) : null}
        {sessionsStatus === 'ready' && sessions.length > 0 ? (
          <ul className="flex flex-col p-1">
            {sessions.map((session) => (
              <li key={session.id}>
                <SessionRow
                  session={session}
                  selected={session.id === selectedSessionId}
                  onSelect={() => selectSession(session.id)}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {sessionsStatus === 'ready' && sessionsHasMore ? (
          <button type="button" className={`${CTL_SECONDARY} m-2 px-2 py-1 text-xs`} onClick={() => void loadSessions(gateway, { more: true })} disabled={sessionsRefreshing}>加载更多会话</button>
        ) : null}
      </div>
      <div className="border-t border-line p-2">
        <button type="button" onClick={onCreate} className={`${CTL_SECONDARY} w-full px-2 py-1.5 text-xs`}>
          <span className="inline-flex items-center gap-1.5"><Plus aria-hidden size={13} />新建会话</span>
        </button>
      </div>
    </section>
  )
}

function SessionRow({ session, selected, onSelect }: { session: AgentSession; selected: boolean; onSelect(): void }) {
  const busyRun = session.activeRunId !== undefined
  const busyWorkflow = session.activeWorkflowId !== undefined
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`w-full rounded-lg px-2 py-2 text-left transition-colors ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg" title={session.title}>{session.title}</span>
        {busyRun ? <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[10px] text-warning">运行中</span> : null}
        {busyWorkflow ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-info/40 bg-info/10 px-1 py-0.5 text-[10px] text-info" title="工作流实例进行中，会话同样保持 busy">
            <Workflow aria-hidden size={10} />工作流
          </span>
        ) : null}
      </span>
      <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-fg-subtle">
        <span>{formatDateTime(session.lastActivityAt)} 活跃</span>
        <span className="tabular-nums" title="会话事件序号（十进制）">seq {session.lastSeq}</span>
      </span>
    </button>
  )
}

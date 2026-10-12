import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { runtimeRunIsActive } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentUnavailableState } from '../../components/agent/AgentUnavailableState'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import { WorkbenchSessions } from './WorkbenchSessions'
import { WorkbenchTasks } from './WorkbenchTasks'
import { WorkbenchDetail } from './WorkbenchDetail'
import { CreateSessionDialog, SessionSettingsDialog } from './WorkbenchDialogs'

/**
 * Ely 工作台（会话 → 任务 → 运行）。三栏：左会话导航、中任务与公开消息流、
 * 右详情面板（运行/工作记忆/模型请求/工作区）；窄屏按单列堆叠降级。
 * 深链契约（模块间导航只许查询参数，不得新增路由）：
 *   /agent?session=<sessionId>&task=<taskId>&run=<runId>
 *   - session：选中会话；task：选中任务（展开消息流与详情）；run：切到「运行」页签。
 * 轮询节奏：选中会话有活动 Run（activeRunId）3 秒，空闲 15 秒；静默轮询不驱动
 * 刷新指示，连续失败标「连接中断，正在重试」。增量经 after 游标，seq 恒为十进制
 * 字符串。页面刷新后只回读服务端事实，绝不自动重放任何提交。
 */
export function AgentWorkbenchPage() {
  const gateway = useGateway()
  const status = useAgentRuntimeStore((state) => state.status)
  const info = useAgentRuntimeStore((state) => state.info)
  const errorMessage = useAgentRuntimeStore((state) => state.errorMessage)
  const load = useAgentRuntimeStore((state) => state.load)

  const sessionsStatus = useAgentWorkbenchStore((state) => state.sessionsStatus)
  const sessions = useAgentWorkbenchStore((state) => state.sessions)
  const selectedSessionId = useAgentWorkbenchStore((state) => state.selectedSessionId)
  const sessionDetail = useAgentWorkbenchStore((state) => state.sessionDetail)
  const sessionStatus = useAgentWorkbenchStore((state) => state.sessionStatus)
  const sessionError = useAgentWorkbenchStore((state) => state.sessionError)
  const selectedTaskId = useAgentWorkbenchStore((state) => state.selectedTaskId)
  const selectedRunId = useAgentWorkbenchStore((state) => state.selectedRunId)
  const taskDetail = useAgentWorkbenchStore((state) => state.taskDetail)
  const selectSession = useAgentWorkbenchStore((state) => state.selectSession)
  const loadSessions = useAgentWorkbenchStore((state) => state.loadSessions)
  const loadSessionDetail = useAgentWorkbenchStore((state) => state.loadSessionDetail)
  const loadTasks = useAgentWorkbenchStore((state) => state.loadTasks)
  const loadMessages = useAgentWorkbenchStore((state) => state.loadMessages)
  const loadTaskDetail = useAgentWorkbenchStore((state) => state.loadTaskDetail)
  const poll = useAgentWorkbenchStore((state) => state.poll)
  const setDetailTab = useAgentWorkbenchStore((state) => state.setDetailTab)

  const [searchParams, setSearchParams] = useSearchParams()
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const hydratedRef = useRef(false)
  const hydrationStartedRef = useRef(false)
  const lastSyncedSearchRef = useRef(searchParams.toString())
  const applyingLocationRef = useRef(false)
  const [hydrated, setHydrated] = useState(false)
  const [locationRevision, setLocationRevision] = useState(0)
  const [mobilePane, setMobilePane] = useState<'sessions' | 'tasks' | 'detail'>('tasks')
  const currentSearch = searchParams.toString()

  useEffect(() => {
    const controller = new AbortController()
    void load(gateway, { signal: controller.signal })
    return () => controller.abort()
  }, [gateway, load])

  // 首次加载会话列表；后续由静默轮询与手动刷新推进。
  useEffect(() => {
    if (!info?.available) return
    const controller = new AbortController()
    void loadSessions(gateway, { signal: controller.signal })
    return () => controller.abort()
  }, [gateway, loadSessions, info?.available])

  // 首次进入：加载会话列表，回放深链（session/task/run）或回落第一个会话。
  useEffect(() => {
    if (hydrationStartedRef.current) return
    if (sessionsStatus !== 'ready') return
    hydrationStartedRef.current = true
    const controller = new AbortController()
    const initialSelection = useAgentWorkbenchStore.getState().selectedSessionId
    const session = searchParams.get('session') ?? undefined
    const task = searchParams.get('task') ?? undefined
    const run = searchParams.get('run') ?? undefined
    void (async () => {
      let resolvedSession = session
      if (resolvedSession) {
        try { await gateway.agentWorkbench.getSession(resolvedSession, controller.signal) }
        catch { resolvedSession = undefined }
      }
      if (controller.signal.aborted) return
      if (useAgentWorkbenchStore.getState().selectedSessionId !== initialSelection) {
        hydratedRef.current = true
        setHydrated(true)
        return
      }
      resolvedSession ??= sessions.at(0)?.id
      if (resolvedSession) selectSession(resolvedSession)
      if (resolvedSession === session && task) {
        try {
          const resolvedTask = await gateway.agentWorkbench.getTask(task, controller.signal)
          if (controller.signal.aborted || useAgentWorkbenchStore.getState().selectedSessionId !== resolvedSession) return
          if ('sessionId' in resolvedTask && resolvedTask.sessionId === resolvedSession) {
            useAgentWorkbenchStore.getState().selectTask(task)
            if (run) {
              const resolvedRun = await gateway.agentRuns.getRun(run, controller.signal)
              if (controller.signal.aborted || useAgentWorkbenchStore.getState().selectedTaskId !== task) return
              if (resolvedRun.taskId === task) {
                useAgentWorkbenchStore.getState().selectRun(run)
                setDetailTab('run')
                setMobilePane('detail')
              }
            }
          }
        } catch { /* Invalid deep links fall back to the resolved session. */ }
      }
    })().finally(() => {
      if (!controller.signal.aborted) {
        hydratedRef.current = true
        setHydrated(true)
      }
    })
    return () => {
      controller.abort()
      if (!hydratedRef.current) hydrationStartedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsStatus === 'ready', gateway])

  // 会话选择变化：回读会话详情、任务列表与公开消息（全量首载）。
  useEffect(() => {
    if (selectedSessionId === undefined) return
    const controller = new AbortController()
    void loadSessionDetail(gateway, { signal: controller.signal })
    void loadTasks(gateway, { signal: controller.signal })
    void loadMessages(gateway, { signal: controller.signal })
    return () => controller.abort()
  }, [selectedSessionId, gateway, loadSessionDetail, loadTasks, loadMessages])

  // 任务选择变化：回读任务详情。
  useEffect(() => {
    if (selectedTaskId === undefined) return
    const controller = new AbortController()
    void loadTaskDetail(gateway, { signal: controller.signal })
    return () => controller.abort()
  }, [selectedTaskId, gateway, loadTaskDetail])

  // Back/forward and links to an already mounted workbench must revalidate ownership.
  useEffect(() => {
    if (!hydrated || currentSearch === lastSyncedSearchRef.current) return
    const controller = new AbortController()
    applyingLocationRef.current = true
    const target = new URLSearchParams(currentSearch)
    void (async () => {
      const requestedSession = target.get('session') ?? undefined
      let session = requestedSession
      if (session) {
        try { await gateway.agentWorkbench.getSession(session, controller.signal) }
        catch { session = undefined }
      }
      if (controller.signal.aborted) return
      session ??= useAgentWorkbenchStore.getState().sessions.at(0)?.id
      const store = useAgentWorkbenchStore.getState()
      if (store.selectedSessionId !== session) store.selectSession(session)

      const requestedTask = target.get('task') ?? undefined
      let task: string | undefined
      if (session === requestedSession && requestedTask) {
        try {
          const resolved = await gateway.agentWorkbench.getTask(requestedTask, controller.signal)
          if ('sessionId' in resolved && resolved.sessionId === session) task = requestedTask
        } catch { /* Invalid task links resolve to the session. */ }
      }
      if (controller.signal.aborted) return
      if (useAgentWorkbenchStore.getState().selectedTaskId !== task) useAgentWorkbenchStore.getState().selectTask(task)

      const requestedRun = target.get('run') ?? undefined
      let run: string | undefined
      if (task && requestedRun) {
        try {
          const resolved = await gateway.agentRuns.getRun(requestedRun, controller.signal)
          if (resolved.taskId === task) run = requestedRun
        } catch { /* Invalid run links resolve to the task. */ }
      }
      if (controller.signal.aborted) return
      if (useAgentWorkbenchStore.getState().selectedRunId !== run) useAgentWorkbenchStore.getState().selectRun(run)
      if (run) {
        setDetailTab('run')
        setMobilePane('detail')
      }
    })().finally(() => {
      if (!controller.signal.aborted) {
        applyingLocationRef.current = false
        setLocationRevision((value) => value + 1)
      }
    })
    return () => controller.abort()
  }, [currentSearch, gateway, hydrated, setDetailTab])

  // 选择态同步进地址栏（replace，不产生历史项），供跨模块深链回来时恢复。
  useEffect(() => {
    if (!hydrated || !hydratedRef.current || applyingLocationRef.current) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (selectedSessionId === undefined) next.delete('session')
      else next.set('session', selectedSessionId)
      if (selectedTaskId === undefined) next.delete('task')
      else next.set('task', selectedTaskId)
      if (selectedRunId === undefined) next.delete('run')
      else next.set('run', selectedRunId)
      lastSyncedSearchRef.current = next.toString()
      return next
    }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, selectedTaskId, selectedRunId, hydrated, locationRevision])

  const sessionActive = (sessionDetail !== undefined &&
    (sessionDetail.activeRunId !== undefined || sessionDetail.activeWorkflowId !== undefined)) ||
    (taskDetail?.latestRun !== undefined && runtimeRunIsActive(taskDetail.latestRun.status))
  const { degraded } = useSilentPolling(
    async (signal) => {
      await load(gateway, { silent: true, signal })
      if (signal.aborted || !useAgentRuntimeStore.getState().info?.available) return
      await poll(gateway, signal)
    },
    { intervalMs: sessionActive ? 3000 : 15000 },
  )

  if (status === 'loading' || status === 'idle') return <LoadingState />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void load(gateway)} />
  }
  if (info !== undefined && !info.available) {
    return <AgentUnavailableState reason={info.reason} worker={info.worker} storage={info.storage} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 xl:grid xl:grid-cols-[15rem_minmax(0,1fr)_21rem]">
      <nav aria-label="工作台视图" className="flex gap-1 border-b border-line pb-2 xl:hidden">
        {([['sessions', '会话'], ['tasks', '任务'], ['detail', '详情']] as const).map(([pane, label]) => (
          <button key={pane} type="button" aria-current={mobilePane === pane ? 'page' : undefined} onClick={() => setMobilePane(pane)} className={`rounded px-3 py-1.5 text-xs ${mobilePane === pane ? 'bg-surface-raised text-fg' : 'text-fg-muted'}`}>{label}</button>
        ))}
      </nav>
      <div className={`min-h-0 xl:max-h-[calc(100vh-11rem)] ${mobilePane === 'sessions' ? '' : 'hidden xl:block'}`}>
        <WorkbenchSessions gateway={gateway} onCreate={() => setCreateOpen(true)} />
      </div>
      <div className={`${mobilePane === 'tasks' ? 'flex' : 'hidden xl:flex'} min-h-0 flex-col`}>
        {sessionStatus === 'error' && selectedSessionId !== undefined ? (
          <div className="mb-3">
            <ErrorState description={sessionError} onRetry={() => void loadSessionDetail(gateway)} />
          </div>
        ) : null}
        <WorkbenchTasks gateway={gateway} session={sessionDetail} degraded={degraded} onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      <div className={`min-h-0 ${mobilePane === 'detail' ? '' : 'hidden xl:block'}`}>
        <WorkbenchDetail gateway={gateway} task={selectedTaskId === undefined ? undefined : (taskDetail ?? undefined)} session={sessionDetail} />
      </div>
      {createOpen ? <CreateSessionDialog onClose={() => setCreateOpen(false)} /> : null}
      {settingsOpen && sessionDetail !== undefined ? (
        <SessionSettingsDialog session={sessionDetail} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  )
}

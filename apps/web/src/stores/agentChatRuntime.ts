import { RUNTIME_RUN_STATUS_LABELS, type AgentChatOutput, type AgentChatTimelineSnapshot, type AgentMessage, type AgentMessageAttachment, type AgentSession } from '@elysian/contracts'
import type { AgentChatRun, AgentChatSession, AgentConversationAdapter } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf } from '../utils/errorMessage'
import type { MessageTone } from './messageStore'

type RuntimeDisplay = {
  remoteSession: AgentSession | null
  messages: readonly AgentMessage[]
  /** 仅用于发送过程的即时回显，正式消息回读后移除，不写入公开历史或本地消息记录。 */
  outgoingMessage: { content: string; attachments: readonly AgentMessageAttachment[]; runId?: string } | null
  reasoning: Readonly<Record<string, string>>
  timelines: Readonly<Record<string, AgentChatTimelineSnapshot>>
  liveOutput: AgentChatOutput | null
  run: AgentChatRun | null
  stopping: boolean
  refreshing: boolean
  syncErrorMessage?: string
}

type RuntimeActions = {
  stop(api: AgentConversationAdapter): Promise<void>
  refresh(api: AgentConversationAdapter, signal?: AbortSignal, refreshRunIds?: readonly string[]): Promise<void>
  watchOutput(api: AgentConversationAdapter, runId: string, signal: AbortSignal): Promise<void>
}

export type AgentChatRuntimeState = RuntimeDisplay & RuntimeActions

type RuntimeContext = {
  get: () => AgentChatRuntimeState & { session: AgentChatSession | null }
  set: (state: Partial<RuntimeDisplay> | ((state: RuntimeDisplay) => Partial<RuntimeDisplay>)) => void
  current: () => AgentChatSession
  update: (patch: Partial<AgentChatSession>) => boolean
  notify: (message: string, tone?: MessageTone) => void
  captureLifetime: () => () => boolean
  acceptRun: (run: AgentChatRun) => void
  onMessagesUpdated: (messages: readonly AgentMessage[]) => void
  onSessionMissing: (api: AgentConversationAdapter, id: string, current: () => boolean, signal?: AbortSignal) => Promise<void>
}

export const isChatRunActive = (run: AgentChatRun | null) => !!run && ['queued', 'running', 'waiting-input', 'waiting-approval', 'waiting-resource', 'waiting-task', 'waiting-recovery', 'waiting-model', 'waiting-storage', 'recovery-required'].includes(run.status)
export const isChatReplyActive = (run: AgentChatRun | null) => isChatRunActive(run) && run?.phase !== 'final-memory'
export const chatRunFailure = (run: AgentChatRun | null) => run && !isChatRunActive(run) && run.status !== 'succeeded' && run.status !== 'cancelled' && !run.budgetStop
  ? `${RUNTIME_RUN_STATUS_LABELS[run.status]}${run.error ? `：${run.error.message}` : ''}`
  : null
const failureMessage = (error: unknown) => messageOf(error, '会话请求失败')

export function createAgentChatRuntime({ get, set, current, update, notify, captureLifetime, acceptRun, onMessagesUpdated, onSessionMissing }: RuntimeContext) {
  let remoteVersion = 0
  const observedActiveRuns = new Set<string>()
  const notifiedRunFailures = new Set<string>()
  const notifiedRunStatuses = new Map<string, string>()
  const clearRunFeedback = () => {
    observedActiveRuns.clear()
    notifiedRunFailures.clear()
    notifiedRunStatuses.clear()
  }
  const observeRun = (run: AgentChatRun, submitted = false) => {
    if (submitted || isChatRunActive(run)) observedActiveRuns.add(run.id)
    const failure = chatRunFailure(run)
    // 历史失败也记录在消息列表中，轮询与重新进入同一会话不重复播报。
    if (failure && !notifiedRunFailures.has(run.id)) {
      notifiedRunFailures.add(run.id)
      notify(failure)
    }
    if (observedActiveRuns.has(run.id) && notifiedRunStatuses.get(run.id) !== run.status) {
      notifiedRunStatuses.set(run.id, run.status)
      // 成功回复已在聊天正文中呈现，不再额外记录完成消息。
      const feedback = run.budgetStop ? { message: '本轮额度已用完，进度已保存。', tone: 'info' as const }
        : run.status === 'cancelled' ? { message: '已停止回复。', tone: 'info' as const }
        : run.status === 'waiting-approval' ? { message: '操作等待批准，请确认待审批操作。', tone: 'warning' as const }
        : run.status === 'waiting-input' ? { message: 'Ely 需要你回答问题后继续。', tone: 'info' as const }
        : run.status === 'recovery-required' ? { message: '运行结果尚未确认，需要处理后才能继续。', tone: 'warning' as const }
        : null
      if (feedback) notify(feedback.message, feedback.tone)
    }
    if (!isChatRunActive(run)) observedActiveRuns.delete(run.id)
  }
  const completedReasoning = new Set<string>()

  const removeReplacedMessage = (messages: readonly AgentMessage[], messageId: string) => {
    const replaced = messages.find(message => message.id === messageId || message.replacesMessageId === messageId)
    return replaced ? messages.filter(message => message.runId !== replaced.runId) : [...messages]
  }
  const setMessages = (messages: readonly AgentMessage[]) => {
    const ids = new Set(messages.map(message => message.runId))
    for (const id of completedReasoning) if (!ids.has(id)) completedReasoning.delete(id)
    set(state => ({ messages,
      outgoingMessage: messages.some(message => message.role === 'user' && message.runId === state.outgoingMessage?.runId) ? null : state.outgoingMessage,
      reasoning: Object.fromEntries(Object.entries(state.reasoning).filter(([id]) => ids.has(id))),
      timelines: Object.fromEntries(Object.entries(state.timelines).filter(([id]) => ids.has(id))),
      liveOutput: state.liveOutput && ids.has(state.liveOutput.runId) ? state.liveOutput : null }))
    onMessagesUpdated(messages)
  }

  const actions: RuntimeActions = {
    async stop(api) {
      const run = get().run
      if (!run || !isChatRunActive(run) || get().stopping || run.cancelRequestedAt) return
      const localId = current().id
      const lifetime = captureLifetime()
      const valid = () => lifetime() && get().session?.id === localId && get().run?.id === run.id
      set({ stopping: true })
      try {
        const stopped = await api.cancelRun(run.id)
        if (valid()) { remoteVersion += 1; observeRun(stopped, true); set({ run: stopped }) }
      } catch (error) { if (valid()) notify(failureMessage(error)) }
      finally {
        if (valid()) { await get().refresh(api); if (valid()) set({ stopping: false }) }
      }
    },
    async watchOutput(api, runId, signal) {
      const localId = current().id
      const lifetime = captureLifetime()
      const valid = () => lifetime() && !signal.aborted && get().session?.id === localId && get().run?.id === runId
      try {
        await api.stream(runId, output => {
          if (!valid() || !isChatRunActive(get().run)) return
          if (get().timelines[runId]?.done && !output.done) return
          set(state => ({ liveOutput: output, reasoning: { ...state.reasoning, [runId]: output.reasoning },
            ...(output.timeline ? { timelines: { ...state.timelines, [runId]: output.timeline } } : {}) }))
        }, signal)
        if (valid()) await get().refresh(api, signal)
      } catch {
        if (valid()) set({ syncErrorMessage: '实时连接暂时中断，正在重新连接；已接收的内容已保留。' })
      }
    },
    async refresh(api, signal, refreshRunIds) {
      const session = current()
      if (!session.remote) return
      const lifetime = captureLifetime()
      const version = ++remoteVersion
      const valid = () => lifetime() && !signal?.aborted && get().session?.id === session.id && version === remoteVersion
      set({ refreshing: true })
      let sessionMissing = false
      try {
        let remote = await api.getSession(session.remote.sessionId, signal).catch(error => {
          sessionMissing = error instanceof AgentHttpError && error.status === 404
          throw error
        })
        let taskId: string | undefined
        let latestRun: AgentChatRun | undefined
        let cursor = ''
        for (;;) {
          const page = await api.listTasks(remote.id, cursor, signal)
          if (!valid()) return
          taskId = page.items.find(task => task.kind === 'agent')?.id
          if (taskId || !page.hasMore) break
          if (page.nextCursor === cursor) throw new Error('会话任务分页未前进，请重新读取')
          cursor = page.nextCursor
        }
        if (taskId) {
          const task = await api.getTask(taskId, signal)
          if (!valid()) return
          if (task.kind !== 'agent' || task.sessionId !== remote.id) throw new Error('会话任务归属不一致，请重新读取')
          latestRun = task.latestRun
        }
        if (!valid()) return
        // 工作流的活动运行只用于显示忙碌，不成为聊天任务的续轮指针。
        update({ remote: { sessionId: remote.id, taskId, runId: latestRun?.id } })
        const runId = remote.activeRunId ?? latestRun?.id
        // 先读运行，再读消息；终态回执后的最终答复一定被读取。
        let run = runId ? latestRun?.id === runId ? latestRun : await api.getRun(runId, signal) : null
        if (!valid()) return
        if (remote.activeRunId && run && !isChatRunActive(run)) remote = await api.getSession(remote.id, signal)
        let messages = [...get().messages]
        let after = messages.at(-1)?.seq ?? '0'
        for (;;) {
          const page = await api.messages(remote.id, after, signal)
          if (!valid()) return
          for (const message of page.items) {
            if (message.replacesMessageId) messages = removeReplacedMessage(messages, message.replacesMessageId)
            messages.push(message)
          }
          after = page.nextCursor
          if (!page.hasMore) break
        }
        if (!valid()) return
        if (run) messages = messages.map(message => message.runId === run.id ? { ...message, runStatus: run.status } : message)
        setMessages(messages)
        set({ remoteSession: remote, run, syncErrorMessage: undefined })
        // 从历史新打开的会话，以服务端模型初始化本地偏好。
        if (!current().modelId) update({ modelId: remote.modelProfileId })
        if (latestRun) acceptRun(latestRun)
        if (run) set({ run })
        if (run) observeRun(run)
        // 只有成功读过终态的旧轮才跳过；生成中快照仍需补齐，以服务端快照替换而非累加。
        const runIds = [...new Set([...messages.map(message => message.runId), ...(run ? [run.id] : [])])]
        for (const id of runIds) {
          if (id !== run?.id && !refreshRunIds?.includes(id) && !get().timelines[id]?.blockingRecovery?.length && completedReasoning.has(id)) continue
          if (id === run?.id && isChatRunActive(run) && get().liveOutput?.runId === id) continue
          const before = get().timelines[id]
          const timeline = await api.timeline(id, signal)
          if (!valid()) return
          // 读取期间若有 SSE 到达，以更新的流式快照为准；终态稍后重新回读确认。
          if (get().timelines[id] !== before || (before?.done && !timeline.done)) continue
          if (timeline.done) completedReasoning.add(id)
          const text = timeline.entries.flatMap(entry => entry.kind === 'reasoning' ? [entry.text] : []).join('\n\n')
          set(state => ({ reasoning: { ...state.reasoning, [id]: text }, timelines: { ...state.timelines, [id]: timeline } }))
        }
      } catch (error) {
        if (valid()) {
          if (sessionMissing) await onSessionMissing(api, session.remote.sessionId, lifetime, signal)
          else set({ syncErrorMessage: failureMessage(error) })
        }
      } finally { if (valid()) set({ refreshing: false }) }
    },
  }
  return {
    actions,
    observeRun,
    setMessages,
    clearRunFeedback,
    invalidateReads() { remoteVersion += 1 },
    clearTimelineCache() { completedReasoning.clear() },
  }
}

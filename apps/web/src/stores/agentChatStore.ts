import { create } from 'zustand'
import type { AgentChatOutput, AgentMessage, AgentModelProfile, AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { agentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatPermissionMode, AgentChatSession, AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'

type AgentChatState = {
  session: AgentChatSession | null
  sessions: readonly AgentSession[]
  localSessions: readonly AgentChatSession[]
  listLoading: boolean
  listError: string | null
  listHasMore: boolean
  listCursor: string
  initialize(api: AgentConversationAdapter, requestedId?: string): Promise<void>
  selectSession(api: AgentConversationAdapter, key: string): Promise<void>
  loadSessions(api: AgentConversationAdapter, more?: boolean, quiet?: boolean): Promise<void>
  clearDisplay(): void
  loading: boolean
  notice: string | null
  remoteSession: AgentSession | null
  messages: readonly AgentMessage[]
  reasoning: Readonly<Record<string, string>>
  liveOutput: AgentChatOutput | null
  run: AgentChatRun | null
  sending: boolean
  refreshing: boolean
  error: string | null
  syncError: string | null
  ensureSession(): Promise<void>
  newSession(): Promise<void>
  setDraft(draft: string): void
  setPermissionMode(permissionMode: AgentChatPermissionMode): void
  setModel(modelId: string | null): void
  setReasoningLevel(reasoningLevel: string | null): void
  addAttachments(files: readonly File[]): Promise<void>
  removeAttachment(id: string): void
  send(api: AgentConversationAdapter, model?: AgentModelProfile): Promise<boolean>
  refresh(api: AgentConversationAdapter, signal?: AbortSignal): Promise<void>
  watchOutput(api: AgentConversationAdapter, runId: string, signal: AbortSignal): Promise<void>
  clearNotice(): void
}

const allAttachments = (session: AgentChatSession) => [...session.attachments, ...session.messages.flatMap(message => message.attachments)]
const persistenceNotice = '浏览器暂时无法保存会话，刷新后可能丢失本页内容。'
const remoteBlank = { remoteSession: null, messages: [], reasoning: {}, liveOutput: null, run: null, sending: false, refreshing: false, error: null, syncError: null }
export const isChatRunActive = (run: AgentChatRun | null) => !!run && ['queued', 'running', 'waiting-approval', 'waiting-resource', 'recovery-required'].includes(run.status)
const failureMessage = (error: unknown) => error instanceof Error ? error.message : '会话请求失败'
// 这些业务拒绝发生在 submitAgent 核对 requestId 之后，可确认该请求未被接受。
// 前置来源/请求体守卫、未知 4xx 与请求标识冲突都不能证明先前的未确认请求未执行。
const confirmedRejections: Readonly<Record<string, number>> = {
  'invalid-task': 400, 'model-capability': 400, 'unsupported-reasoning-level': 400,
  'session-not-found': 404, 'task-not-found': 404, 'profile-not-found': 404, 'profile-revision-not-found': 404,
  'session-busy': 409, 'model-changed': 409, 'profile-inactive': 409, 'queue-full': 429,
}
const isConfirmedRejection = (error: unknown) => error instanceof AgentHttpError &&
  !!error.code && Object.hasOwn(confirmedRejections, error.code) && confirmedRejections[error.code] === error.status

export function createAgentChatStore(adapter: AgentChatAdapter, now: () => string = () => new Date().toISOString(), id: () => string = () => crypto.randomUUID()) {
  return create<AgentChatState>((set, get) => {
    let restoring: Promise<void> | undefined
    let generation = 0
    let remoteVersion = 0
    let listVersion = 0
    let listInitialized = false
    let lifecycle = 0
    let navigationVersion = 0
    let initialBlank = false
    let initialized = false
    let initialization: Promise<void> | undefined
    const completedReasoning = new Set<string>()
    const blankSession = (): AgentChatSession => ({
      id: `draft:${id()}`, createdAt: now(), draft: '', messages: [], attachments: [],
      permissionMode: 'ask', modelId: null, reasoningLevel: null,
    })
    const persist = (session: AgentChatSession) => {
      set({ session })
      const saved = adapter.write(session)
      set({ localSessions: adapter.list() })
      if (!saved) set({ notice: persistenceNotice })
      return saved
    }
    const restore = async (session: AgentChatSession) => {
      const currentGeneration = ++generation
      if (get().session?.id !== session.id) { remoteVersion += 1; completedReasoning.clear(); set(remoteBlank) }
      set({ session, loading: true, notice: null })
      const attachments = await adapter.restore(allAttachments(session))
      if (currentGeneration !== generation || get().session?.id !== session.id) return
      const restored = new Map(attachments.map(attachment => [attachment.id, attachment]))
      const match = (attachment: AgentChatAttachment) => restored.get(attachment.id) ?? attachment
      const current = get().session!
      set({
        session: { ...current, attachments: current.attachments.map(match), messages: current.messages.map(message => ({ ...message, attachments: message.attachments.map(match) })) },
        loading: false,
        notice: attachments.some(attachment => !attachment.available) ? '部分附件已无法从浏览器恢复，请重新选择需要发送的文件。' : get().notice,
      })
    }
    // 跨标签只同步当前会话的数据，选中项由各标签自己的 URL 与内存决定。
    adapter.subscribe(() => {
      if (!get().session) return
      set({ localSessions: adapter.list() })
      const currentSession = get().session
      if (!currentSession || get().sending) return
      const session = adapter.read(agentChatSessionKey(currentSession))
      if (session && JSON.stringify(session) !== JSON.stringify(currentSession)) void restore(session)
    })
    const current = (): AgentChatSession => get().session ?? adapter.read() ?? blankSession()
    const update = (patch: Partial<AgentChatSession>) => persist({ ...current(), ...patch })
    const stillCurrent = (localId: string) => get().session?.id === localId
    const acceptRun = (run: AgentChatRun, owner = current(), display = true) => {
      const session = get().session?.id === owner.id ? current() : adapter.read(agentChatSessionKey(owner)) ?? owner
      const pending = session.pending
      const next = { ...session, remote: { sessionId: run.sessionId ?? session.remote!.sessionId, taskId: run.taskId, runId: run.id },
        ...(pending && pending.input.requestId === run.requestId ? { pending: undefined, draft: session.draft.trim() === pending.input.content ? '' : session.draft } : {}) }
      if (!display || get().session?.id !== owner.id) { adapter.write(next, false); if (get().session) set({ localSessions: adapter.list() }); return }
      persist(next)
      set({ run, ...(pending && pending.input.requestId === run.requestId ? { error: null } : {}) })
    }
    const dispatchPending = async (api: AgentConversationAdapter, localId: string, lifecycleAtStart: number): Promise<boolean> => {
      const session = current()
      const pending = session.pending!
      try {
        const run = pending.taskId
          ? await api.continueTask(pending.taskId, pending.input)
          : await api.createTask(session.remote!.sessionId, pending.input)
        acceptRun(run, session, lifecycleAtStart === lifecycle)
        if (lifecycleAtStart !== lifecycle || !stillCurrent(localId)) return false
        remoteVersion += 1
        set({ sending: false })
        // POST 回执已经确认接受；后续读取失败不把提交标成失败。
        await get().refresh(api)
        void get().loadSessions(api)
        return true
      } catch (error) {
        if (lifecycleAtStart !== lifecycle || !stillCurrent(localId)) return false
        const rejected = isConfirmedRejection(error)
        if (rejected) update({ pending: undefined })
        set({ error: rejected ? failureMessage(error) : `${failureMessage(error)}。发送结果尚未确认，可重试确认同一条消息。` })
        return false
      }
    }
    return {
      ...remoteBlank,
      session: null,
      sessions: [], localSessions: [], listLoading: false, listError: null, listHasMore: false, listCursor: '',
      clearDisplay() {
        generation += 1; remoteVersion += 1; listVersion += 1; lifecycle += 1; navigationVersion += 1
        initialBlank = false
        listInitialized = false
        initialized = false; initialization = undefined; restoring = undefined
        completedReasoning.clear()
        set({ ...remoteBlank, session: null, sessions: [], localSessions: [], loading: false, listLoading: false, listError: null, listHasMore: false, listCursor: '' })
      },
      async loadSessions(api, more = false, quiet = false) {
        if (!api.available || (more && (!get().listHasMore || get().listLoading))) return
        const version = ++listVersion
        const cursor = more ? get().listCursor : ''
        set({ listLoading: true, listError: null, localSessions: adapter.list() })
        try {
          const page = await api.listSessions(cursor)
          if (version !== listVersion) return
          if (page.hasMore && page.nextCursor === cursor) throw new Error('会话列表分页未前进，请重新读取')
          if (quiet && listInitialized) {
            // 静默回读只更新列表内容，保留最后已加载页的游标和结束标记。
            // 显式刷新才重置分页；活动时间变化带来的重复由后续加载按 ID 去重。
            const records = new Map(page.items.map(row => [row.id, row]))
            for (const row of get().sessions) if (!records.has(row.id)) records.set(row.id, row)
            set({ sessions: [...records.values()] })
            return
          }
          const records = new Map((more ? get().sessions : []).map(row => [row.id, row]))
          for (const row of page.items) records.set(row.id, row)
          listInitialized = true
          set({ sessions: [...records.values()], listCursor: page.nextCursor, listHasMore: page.hasMore })
        } catch (error) { if (version === listVersion) set({ listError: failureMessage(error) }) }
        finally { if (version === listVersion) set({ listLoading: false }) }
      },
      async initialize(api, requestedId) {
        const lifetime = lifecycle
        if (requestedId) {
          // 立即切换会话并清除旧内容；列表慢请求不能让旧会话继续承接输入。
          await Promise.all([get().selectSession(api, requestedId), get().loadSessions(api)])
          return
        }
        if (initialization) return initialization
        if (initialized) return
        const navigation = ++navigationVersion
        initialization = (async () => {
          await get().ensureSession()
          if (lifetime !== lifecycle) return
          await get().loadSessions(api)
          if (lifetime !== lifecycle || navigation !== navigationVersion || !get().session) return
          if (initialBlank && !get().session?.draft && !get().session?.attachments.length && get().sessions[0]) await get().selectSession(api, get().sessions[0]!.id)
          initialized = true
        })()
        try { await initialization } finally { initialization = undefined }
      },
      async selectSession(api, key) {
        if (get().sending) return
        const navigation = ++navigationVersion
        const lifetime = lifecycle
        if (get().session && agentChatSessionKey(get().session!) === key) return
        initialBlank = false
        const stored = adapter.read(key)
        const session = stored ?? { ...blankSession(), id: key, remote: { sessionId: key } }
        adapter.select(key)
        await restore(session)
        if (lifetime !== lifecycle || navigation !== navigationVersion || get().session?.id !== session.id) return
        set({ localSessions: adapter.list() })
        if (session.remote && api.available) await get().refresh(api)
      },
      loading: false,
      notice: null,
      async ensureSession() {
        if (get().session) { await restoring; return }
        if (restoring) { await restoring; return }
        const session = adapter.read()
        if (session) {
          restoring = restore(session)
          try { await restoring } finally { restoring = undefined }
        } else { initialBlank = true; persist(blankSession()) }
      },
      async newSession() {
        if (get().sending) return
        navigationVersion += 1
        initialBlank = false
        initialized = true
        generation += 1
        remoteVersion += 1
        completedReasoning.clear()
        restoring = undefined
        set({ ...remoteBlank, loading: false, notice: null })
        persist(blankSession())
      },
      setDraft: draft => { if (!current().pending) update({ draft }) },
      setPermissionMode: permissionMode => { if (!get().sending && !isChatRunActive(get().run) && !current().pending) update({ permissionMode }) },
      setModel: modelId => { if (!get().sending && !isChatRunActive(get().run) && !current().pending) update({ modelId, reasoningLevel: null }) },
      setReasoningLevel: reasoningLevel => { if (!get().sending && !isChatRunActive(get().run) && !current().pending) update({ reasoningLevel }) },
      async addAttachments(files) {
        if (!files.length) return
        const lifetime = lifecycle
        const ready = get().ensureSession()
        const sessionId = current().id
        await ready
        if (lifetime !== lifecycle || get().session?.id !== sessionId) return
        const result = await adapter.attach(files)
        const session = current()
        if (lifetime !== lifecycle || get().session?.id !== sessionId) { await adapter.discard(result.attachments.map(attachment => attachment.id)); return }
        persist({ ...session, attachments: [...session.attachments, ...result.attachments] })
        if (!result.persisted) set({ notice: '附件仅在当前页面可用，浏览器暂时无法保存文件；刷新后请重新选择。' })
      },
      removeAttachment(attachmentId) {
        const session = current()
        persist({ ...session, attachments: session.attachments.filter(attachment => attachment.id !== attachmentId) })
        void adapter.discard([attachmentId])
      },
      async send(api, model) {
        const session = current()
        const lifetime = lifecycle
        const valid = () => lifetime === lifecycle && stillCurrent(session.id)
        const text = session.draft.trim()
        if (!api.available || !text || get().loading || get().sending || isChatRunActive(get().run)) return false
        if (session.attachments.length) {
          set({ error: '当前聊天仅支持文本，请移除附件后发送。' })
          return false
        }
        if (new TextEncoder().encode(text).length > 32768) { set({ error: '消息不能超过 32 KiB，请缩短后发送。' }); return false }
        if (!session.pending && (!model?.active || !model.capabilities.text || !model.capabilities.tools)) {
          set({ error: '请选择已启用且支持文本和工具调用的模型。' }); return false
        }
        if (!session.pending && session.reasoningLevel && !model?.capabilities.reasoningLevels?.includes(session.reasoningLevel)) {
          set({ error: '当前模型不支持已选思考等级，请重新选择。' }); return false
        }
        set({ sending: true, error: null })
        remoteVersion += 1
        try {
          if (session.pending) return await dispatchPending(api, session.id, lifetime)
          if (!model) return false
          let remote: AgentSession
          if (session.remote) {
            remote = await api.getSession(session.remote.sessionId)
            if (!valid()) return false
            set({ remoteSession: remote })
            if (remote.activeRunId || remote.activeWorkflowId) {
              await get().refresh(api)
              set({ error: '会话仍在运行，请结束后再发送。' }); return false
            }
            // 同一模型的修订固定在会话中；仅用户选择不同模型时切换。
            if (remote.modelProfileId !== model.id) remote = await api.switchModel(remote.id, { modelProfileId: model.id, modelRevision: model.revision })
          } else {
            remote = await api.createSession({ title: [...text].slice(0, 40).join(''), modelProfileId: model.id, modelRevision: model.revision })
          }
          if (!valid()) return false
          set({ remoteSession: remote })
          const saved = update({ remote: { ...current().remote, sessionId: remote.id }, pending: { input: { requestId: id(), content: text, ...(session.reasoningLevel ? { reasoningLevel: session.reasoningLevel } : {}) }, taskId: current().remote?.taskId } })
          if (!saved) { update({ pending: undefined }); set({ error: '无法保存发送标识，请恢复浏览器存储后再发送。' }); return false }
          return await dispatchPending(api, session.id, lifetime)
        } catch (error) {
          if (valid()) set({ error: failureMessage(error) })
          return false
        } finally { if (valid()) set({ sending: false }) }
      },
      async watchOutput(api, runId, signal) {
        const localId = current().id
        const valid = () => !signal.aborted && stillCurrent(localId) && get().run?.id === runId
        try {
          await api.stream(runId, output => {
            if (!valid() || !isChatRunActive(get().run)) return
            set(state => ({ liveOutput: output, reasoning: { ...state.reasoning, [runId]: output.reasoning } }))
          }, signal)
          if (valid()) await get().refresh(api, signal)
        } catch {
          if (valid()) set({ syncError: '实时连接暂时中断，正在重新连接；已接收的内容已保留。' })
        }
      },
      async refresh(api, signal) {
        const session = current()
        if (!session.remote) return
        const version = ++remoteVersion
        const valid = () => !signal?.aborted && stillCurrent(session.id) && version === remoteVersion
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
          const messages = [...get().messages]
          let after = messages.at(-1)?.seq ?? '0'
          for (;;) {
            const page = await api.messages(remote.id, after, signal)
            if (!valid()) return
            messages.push(...page.items)
            after = page.nextCursor
            if (!page.hasMore) break
          }
          if (!valid()) return
          set({ remoteSession: remote, messages, run, syncError: null })
          // 从历史新打开的会话，以服务端模型初始化本地偏好。
          if (!current().modelId) update({ modelId: remote.modelProfileId })
          if (latestRun) acceptRun(latestRun)
          if (run) set({ run })
          // 只有成功读过终态的旧轮才跳过；生成中快照仍需补齐，以服务端快照替换而非累加。
          const runIds = [...new Set([...messages.map(message => message.runId), ...(run ? [run.id] : [])])]
          for (const id of runIds) {
            if (id !== run?.id && completedReasoning.has(id)) continue
            if (id === run?.id && isChatRunActive(run) && get().liveOutput?.runId === id) continue
            const text = await api.reasoning(id, signal)
            if (!valid()) return
            if (id === run?.id && isChatRunActive(run) && get().liveOutput?.runId === id) continue
            if (id !== run?.id || !isChatRunActive(run)) completedReasoning.add(id)
            set(state => ({ reasoning: { ...state.reasoning, [id]: text } }))
          }
        } catch (error) {
          if (valid()) {
            if (sessionMissing) {
              const missing = session.remote.sessionId
              const fallback = get().sessions.find(row => row.id !== missing)
              set({ sessions: get().sessions.filter(row => row.id !== missing) })
              if (fallback) await get().selectSession(api, fallback.id)
              else await get().newSession()
              set({ notice: '原会话已不存在，已切换会话。原草稿和未确认请求仍保存在本地。' })
            } else set({ syncError: failureMessage(error) })
          }
        } finally { if (valid()) set({ refreshing: false }) }
      },
      clearNotice: () => set({ notice: null }),
    }
  })
}

export const useAgentChatStore = createAgentChatStore(agentChatLocalAdapter)

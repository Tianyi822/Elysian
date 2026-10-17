import { create } from 'zustand'
import { AGENT_ATTACHMENT_LIMITS, RUNTIME_RUN_STATUS_LABELS, type AgentChatOutput, type AgentChatTimelineSnapshot, type AgentMessage, type AgentModelProfile, type AgentSession } from '@elysian/contracts'
import { agentChatAllAttachments, agentChatSessionKey } from '../contracts/agentChat'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { agentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import { prepareAgentImage } from '../adapters/local/agentImagePreparation'
import { useNotificationStore, type NotificationTone } from './notificationStore'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatPermissionMode, AgentChatSession, AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'
import type { AgentUserInputAnswer, AgentUserInputRequest } from '@elysian/contracts'

type AgentChatState = {
  setUserInputAnswer(request: AgentUserInputRequest, questionId: string, answer: AgentUserInputAnswer): void
  answerUserInput(api: AgentConversationAdapter, request: AgentUserInputRequest): Promise<void>
  session: AgentChatSession | null
  sessions: readonly AgentSession[]
  localSessions: readonly AgentChatSession[]
  listLoading: boolean
  listError: string | null
  listHasMore: boolean
  listCursor: string
  initialize(api: AgentConversationAdapter, requestedId?: string): Promise<void>
  selectSession(api: AgentConversationAdapter, key: string): Promise<void>
  loadSessions(api: AgentConversationAdapter, more?: boolean, quiet?: boolean, userInitiated?: boolean): Promise<void>
  renameSession(api: AgentConversationAdapter, id: string, title: string): Promise<void>
  deleteSession(api: AgentConversationAdapter, id: string): Promise<void>
  clearDisplay(): void
  loading: boolean
  reportOperation(message: string, tone?: NotificationTone): void
  remoteSession: AgentSession | null
  messages: readonly AgentMessage[]
  reasoning: Readonly<Record<string, string>>
  timelines: Readonly<Record<string, AgentChatTimelineSnapshot>>
  liveOutput: AgentChatOutput | null
  run: AgentChatRun | null
  sending: boolean
  uploadingAttachments: boolean
  stopping: boolean
  refreshing: boolean
  syncError: string | null
  ensureSession(): Promise<void>
  prepareRemoteSession(api: AgentConversationAdapter, model: AgentModelProfile): Promise<void>
  newSession(): Promise<void>
  setDraft(draft: string): void
  editMessage(messageId: string): void
  setEditText(text: string): void
  cancelEdit(): void
  stop(api: AgentConversationAdapter): Promise<void>
  setPermissionMode(permissionMode: AgentChatPermissionMode): void
  setModel(modelId: string | null): void
  setReasoningLevel(reasoningLevel: string | null): void
  addAttachments(api: AgentConversationAdapter, files: readonly File[]): Promise<void>
  removeAttachment(id: string): void
  send(api: AgentConversationAdapter, model?: AgentModelProfile): Promise<boolean>
  refresh(api: AgentConversationAdapter, signal?: AbortSignal): Promise<void>
  watchOutput(api: AgentConversationAdapter, runId: string, signal: AbortSignal): Promise<void>
}

const allAttachments = agentChatAllAttachments
const persistenceNotice = '浏览器暂时无法保存会话，刷新后可能丢失本页内容。'
const attachmentTotalNotice = '本条消息附件合计超过 8 MiB，请分批发送。'
const remoteBlank = { remoteSession: null, messages: [], reasoning: {}, timelines: {}, liveOutput: null, run: null, sending: false, uploadingAttachments: false, stopping: false, refreshing: false, syncError: null }
export const isChatRunActive = (run: AgentChatRun | null) => !!run && ['queued', 'running', 'waiting-input', 'waiting-approval', 'waiting-resource', 'waiting-task', 'recovery-required'].includes(run.status)
export const isChatReplyActive = (run: AgentChatRun | null) => isChatRunActive(run) && run?.phase !== 'final-memory'
export const chatRunFailure = (run: AgentChatRun | null) => run && !isChatRunActive(run) && run.status !== 'succeeded' && run.status !== 'cancelled'
  ? `${RUNTIME_RUN_STATUS_LABELS[run.status]}${run.error ? `：${run.error.message}` : ''}`
  : null
const failureMessage = (error: unknown) => error instanceof Error ? error.message : '会话请求失败'
// 这些业务拒绝发生在 submitAgent 核对 requestId 之后，可确认该请求未被接受。
// 前置来源/请求体守卫、未知 4xx 与请求标识冲突都不能证明先前的未确认请求未执行。
const confirmedRejections: Readonly<Record<string, number>> = {
  'invalid-task': 400, 'model-capability': 400, 'unsupported-reasoning-level': 400,
  'session-not-found': 404, 'task-not-found': 404, 'profile-not-found': 404, 'profile-revision-not-found': 404,
  'session-busy': 409, 'model-changed': 409, 'profile-inactive': 409, 'queue-full': 429,
  'invalid-replacement': 400, 'message-changed': 409,
  'image-unsupported': 400, 'attachment-invalid': 400, 'attachment-too-many': 400, 'attachment-too-large': 400, 'attachment-message-too-large': 400,
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
    let attachmentUploadVersion = 0
    let submissionVersion = 0
    let attachmentPreparation: AbortController | undefined
    let initialBlank = false
    let initialized = false
    let initialization: Promise<void> | undefined
    let persistenceFailed = false
    let attachmentPersistenceFailed = false
    let listFeedback: string | null = null
    const notificationIds = new Set<string>()
    const runNotificationIds = new Set<string>()
    const observedActiveRuns = new Set<string>()
    const notifiedRunFailures = new Set<string>()
    const notifiedRunStatuses = new Map<string, string>()
    const missingAttachmentSets = new Map<string, string>()
    const notify = (message: string, tone: NotificationTone = 'danger') => {
      const notifications = useNotificationStore.getState()
      const active = new Set(notifications.notifications.map(item => item.id))
      for (const id of notificationIds) if (!active.has(id)) notificationIds.delete(id)
      const notificationId = notifications.notify({ message, tone })
      notificationIds.add(notificationId)
      return notificationId
    }
    const clearRunFeedback = () => {
      for (const id of runNotificationIds) {
        useNotificationStore.getState().dismiss(id)
        notificationIds.delete(id)
      }
      runNotificationIds.clear()
      observedActiveRuns.clear()
      notifiedRunFailures.clear()
      notifiedRunStatuses.clear()
    }
    const observeRun = (run: AgentChatRun, submitted = false) => {
      if (submitted || isChatRunActive(run)) observedActiveRuns.add(run.id)
      const failure = chatRunFailure(run)
      // 历史失败也在通知区回显，轮询与重新进入同一会话不重复播报。
      if (failure && !notifiedRunFailures.has(run.id)) {
        notifiedRunFailures.add(run.id)
        runNotificationIds.add(notify(failure))
      }
      if (observedActiveRuns.has(run.id) && notifiedRunStatuses.get(run.id) !== run.status) {
        notifiedRunStatuses.set(run.id, run.status)
        const feedback = run.status === 'succeeded' ? { message: '回复已完成。', tone: 'success' as const }
          : run.status === 'cancelled' ? { message: '已停止回复。', tone: 'info' as const }
          : run.status === 'waiting-approval' ? { message: '操作等待批准，请确认待审批操作。', tone: 'warning' as const }
          : run.status === 'waiting-input' ? { message: 'Ely 需要你回答问题后继续。', tone: 'info' as const }
          : run.status === 'recovery-required' ? { message: '运行结果尚未确认，需要处理后才能继续。', tone: 'warning' as const }
          : null
        if (feedback) runNotificationIds.add(notify(feedback.message, feedback.tone))
      }
      if (!isChatRunActive(run)) observedActiveRuns.delete(run.id)
    }
    const checkAttachmentTotal = (bytes: number) => {
      if (bytes > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) throw new Error(attachmentTotalNotice)
    }
    const completedReasoning = new Set<string>()
    const blankSession = (): AgentChatSession => ({
      id: `draft:${id()}`, createdAt: now(), draft: '', messages: [], attachments: [],
      permissionMode: 'ask', permissionVersion: 1, modelId: null, reasoningLevel: null,
    })
    const persist = (session: AgentChatSession) => {
      set({ session })
      const saved = adapter.write(session)
      set({ localSessions: adapter.list() })
      if (!saved && !persistenceFailed) notify(persistenceNotice, 'info')
      persistenceFailed = !saved
      return saved
    }
    const restore = async (session: AgentChatSession) => {
      const currentGeneration = ++generation
      if (get().session?.id !== session.id) { attachmentPreparation?.abort(); remoteVersion += 1; attachmentUploadVersion += 1; completedReasoning.clear(); set(remoteBlank) }
      set({ session, loading: true })
      const attachments = await adapter.restore(allAttachments(session))
      if (currentGeneration !== generation || get().session?.id !== session.id) return
      const restored = new Map(attachments.map(attachment => [attachment.id, attachment]))
      const match = (attachment: AgentChatAttachment) => restored.get(attachment.id) ?? attachment
      const current = get().session!
      set({
        session: { ...current, attachments: current.attachments.map(match), messages: current.messages.map(message => ({ ...message, attachments: message.attachments.map(match) })),
          ...(current.editing ? { editing: { ...current.editing, preparedAttachments: current.editing.preparedAttachments?.map(item => ({ ...item, attachment: match(item.attachment) })) } } : {}) },
        loading: false,
      })
      const missing = attachments.filter(attachment => !attachment.available).map(attachment => attachment.id).sort().join(',')
      if (missing && missingAttachmentSets.get(session.id) !== missing) notify('部分附件已无法从浏览器恢复，请重新选择需要发送的文件。', 'info')
      missingAttachmentSets.set(session.id, missing)
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
    const uploadAndStore = async (api: AgentConversationAdapter, files: readonly File[], valid: () => boolean, signal: AbortSignal) => {
      const uploaded = await api.uploadAttachments(files, signal)
      if (!valid()) return null
      if (uploaded.items.length !== files.length) throw new Error('图片上传回执不完整，请重新添加。')
      const result = await adapter.attach(files)
      if (!valid()) {
        await adapter.discard(result.attachments.map(attachment => attachment.id))
        return null
      }
      const attachments = result.attachments.map((attachment, index) => {
        const item = uploaded.items[index]!
        return { ...attachment, serverId: item.id, width: item.width, height: item.height, type: item.mimeType, size: item.bytes }
      })
      if (!result.persisted && !attachmentPersistenceFailed) notify('附件仅在当前页面可用，浏览器暂时无法保存文件；刷新后请重新选择。', 'info')
      attachmentPersistenceFailed = !result.persisted
      return attachments
    }
    const discardPrepared = (session: AgentChatSession) => {
      const ids = session.editing?.preparedAttachments?.map(item => item.attachment.id) ?? []
      if (ids.length) void adapter.discard(ids)
    }
    const prepareExistingAttachments = async (api: AgentConversationAdapter, owner: AgentChatSession, valid: () => boolean, signal: AbortSignal) => {
      const editing = owner.editing
      const original = editing ? get().messages.find(message => message.id === editing.messageId) : undefined
      const sources = editing
        ? (editing.attachments ?? []).map(ref => {
          const item = original?.attachments?.find(attachment => attachment.id === ref.id)
          const prepared = editing.preparedAttachments?.find(item => item.sourceId === ref.id)?.attachment
          return { sourceId: ref.id, name: item?.name, bytes: prepared?.size ?? item?.bytes, width: prepared?.width ?? item?.width, height: prepared?.height ?? item?.height, prepared: !!prepared }
        })
        : owner.attachments.map(item => ({ sourceId: item.serverId!, name: item.name, bytes: item.size, width: item.width, height: item.height, prepared: false }))
      const replacements: { sourceId: string; file: File }[] = []
      let total = 0
      for (const source of sources) {
        if (source.prepared || (source.bytes !== undefined && source.bytes <= AGENT_ATTACHMENT_LIMITS.maxFileBytes && Math.max(source.width ?? 0, source.height ?? 0) <= 6000)) {
          total += source.bytes ?? 0
          checkAttachmentTotal(total)
          continue
        }
        const blob = await api.attachmentBlob(source.sourceId, signal)
        if (!valid()) return
        const file = new File([blob], source.name ?? (blob.type === 'image/jpeg' ? '图片.jpg' : '图片.png'), { type: blob.type })
        const prepared = await prepareAgentImage(file, signal)
        total += prepared.size
        checkAttachmentTotal(total)
        if (prepared !== file) replacements.push({ sourceId: source.sourceId, file: prepared })
        if (!valid()) return
      }
      if (!replacements.length) return
      const additions = await uploadAndStore(api, replacements.map(item => item.file), valid, signal)
      if (!additions) return
      const bySource = new Map(replacements.map((item, index) => [item.sourceId, additions[index]!]))
      const session = current()
      const saved = editing
        ? update({ editing: { ...session.editing!, preparedAttachments: [...(session.editing?.preparedAttachments ?? []),
          ...replacements.map((item, index) => ({ sourceId: item.sourceId, attachment: additions[index]! }))] } })
        : update({ attachments: session.attachments.map(attachment => bySource.get(attachment.serverId!) ?? attachment) })
      if (!editing) await adapter.discard(session.attachments.filter(attachment => bySource.has(attachment.serverId!)).map(attachment => attachment.id))
      if (!valid()) return
      if (!saved) throw new Error('无法保存图片处理结果，请恢复浏览器存储后再发送。')
    }
    const removeReplacedMessage = (messages: readonly AgentMessage[], messageId: string) => {
      const replaced = messages.find(message => message.id === messageId || message.replacesMessageId === messageId)
      return replaced ? messages.filter(message => message.runId !== replaced.runId) : [...messages]
    }
    const setMessages = (messages: readonly AgentMessage[]) => {
      const ids = new Set(messages.map(message => message.runId))
      for (const id of completedReasoning) if (!ids.has(id)) completedReasoning.delete(id)
      set(state => ({ messages, reasoning: Object.fromEntries(Object.entries(state.reasoning).filter(([id]) => ids.has(id))),
        timelines: Object.fromEntries(Object.entries(state.timelines).filter(([id]) => ids.has(id))),
        liveOutput: state.liveOutput && ids.has(state.liveOutput.runId) ? state.liveOutput : null }))
      const session = current()
      if (session.editing && !session.pending && messages.filter(message => message.role === 'user').at(-1)?.id !== session.editing.messageId) {
        discardPrepared(session)
        update({ editing: undefined })
      }
    }
    const acceptRun = (run: AgentChatRun, owner = current(), display = true) => {
      const session = get().session?.id === owner.id ? current() : adapter.read(agentChatSessionKey(owner)) ?? owner
      const pending = session.pending
      if (pending && pending.input.requestId === run.requestId && pending.input.replaceMessageId) discardPrepared(session)
      const next = { ...session, remote: { sessionId: run.sessionId ?? session.remote!.sessionId, taskId: run.taskId, runId: run.id },
        ...(pending && pending.input.requestId === run.requestId ? { pending: undefined,
          ...(pending.input.replaceMessageId ? { editing: undefined } : { draft: session.draft.trim() === pending.input.content ? '' : session.draft }) } : {}) }
      // 确认接受后只清本次发送引用的草稿附件并释放其本地字节：pending 未确认窗口内
      // 新增的草稿附件（如跨标签写入）不属于本次发送集合，保留给用户后续处置。
      if (pending && pending.input.requestId === run.requestId && !pending.input.replaceMessageId && pending.input.attachments?.length && session.attachments.length) {
        const sent = new Set(pending.input.attachments.map(ref => ref.id))
        const consumed = session.attachments.filter(attachment => attachment.serverId && sent.has(attachment.serverId))
        if (consumed.length) {
          next.attachments = session.attachments.filter(attachment => !attachment.serverId || !sent.has(attachment.serverId))
          void adapter.discard(consumed.map(attachment => attachment.id))
        }
      }
      if (!display || get().session?.id !== owner.id) { adapter.write(next, false); if (get().session) set({ localSessions: adapter.list() }); return }
      persist(next)
      if (pending && pending.input.requestId === run.requestId && pending.input.replaceMessageId) {
        const replaced = get().messages.find(message => message.id === pending.input.replaceMessageId)
        if (replaced) setMessages(get().messages
          .filter(message => message.runId !== replaced.runId || message.id === replaced.id)
          .map(message => message.id === replaced.id ? { ...message, content: pending.input.content, runId: run.id, runStatus: run.status,
            attachments: message.attachments?.map(attachment => {
              const prepared = session.editing?.preparedAttachments?.find(item => item.sourceId === attachment.id)?.attachment
              return prepared?.serverId ? { id: prepared.serverId, name: prepared.name, mimeType: prepared.type as 'image/jpeg' | 'image/png', bytes: prepared.size, width: prepared.width!, height: prepared.height! } : attachment
            }),
          } : message))
      }
      set({ run })
    }
    const dispatchPending = async (api: AgentConversationAdapter, localId: string, lifecycleAtStart: number, version: number): Promise<boolean> => {
      const session = current()
      const pending = session.pending!
      const valid = () => lifecycleAtStart === lifecycle && version === submissionVersion && stillCurrent(localId)
      try {
        const run = pending.taskId
          ? await api.continueTask(pending.taskId, pending.input)
          : await api.createTask(session.remote!.sessionId, pending.input)
        acceptRun(run, session, lifecycleAtStart === lifecycle && version === submissionVersion)
        if (!valid()) return false
        observeRun(run, true)
        remoteVersion += 1
        set({ sending: false })
        // POST 回执已经确认接受；后续读取失败不把提交标成失败。
        await get().refresh(api)
        if (!valid()) return false
        void get().loadSessions(api)
        return true
      } catch (error) {
        if (!valid()) return false
        const rejected = isConfirmedRejection(error)
        if (rejected) {
          if (error instanceof AgentHttpError && error.code === 'attachment-invalid' && current().editing?.preparedAttachments?.length) {
            discardPrepared(current())
            update({ editing: { ...current().editing!, preparedAttachments: undefined }, pending: undefined })
          } else update({ pending: undefined })
        }
        notify(rejected ? failureMessage(error) : `${failureMessage(error)}。发送结果尚未确认，可重试确认同一条消息。`)
        return false
      }
    }
    return {
      ...remoteBlank,
      session: null,
      sessions: [], localSessions: [], listLoading: false, listError: null, listHasMore: false, listCursor: '',
      reportOperation: notify,
      clearDisplay() {
        listFeedback = null
        attachmentPreparation?.abort()
        generation += 1; remoteVersion += 1; listVersion += 1; lifecycle += 1; navigationVersion += 1
        attachmentUploadVersion += 1
        initialBlank = false
        listInitialized = false
        initialized = false; initialization = undefined; restoring = undefined
        completedReasoning.clear()
        clearRunFeedback()
        for (const id of notificationIds) useNotificationStore.getState().dismiss(id)
        notificationIds.clear()
        missingAttachmentSets.clear()
        persistenceFailed = false
        attachmentPersistenceFailed = false
        set({ ...remoteBlank, session: null, sessions: [], localSessions: [], loading: false, listLoading: false, listError: null, listHasMore: false, listCursor: '' })
      },
      async loadSessions(api, more = false, quiet = false, userInitiated = false) {
        if (!api.available || (more && (!get().listHasMore || get().listLoading))) return
        const version = ++listVersion
        const cursor = more ? get().listCursor : ''
        set({ listLoading: true, listError: null, localSessions: adapter.list() })
        try {
          const page = await api.listSessions(cursor)
          if (version !== listVersion) return
          if (page.hasMore && page.nextCursor === cursor) throw new Error('会话列表分页未前进，请重新读取')
          listFeedback = null
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
        } catch (error) {
          if (version === listVersion) {
            if (userInitiated || listFeedback !== failureMessage(error)) notify(failureMessage(error))
            listFeedback = failureMessage(error)
            set({ listError: userInitiated && listInitialized ? null : failureMessage(error) })
          }
        }
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
      async renameSession(api, id, title) {
        if (get().sending) return
        const lifetime = lifecycle
        let remote: AgentSession
        try {
          remote = await api.renameSession(id, { title: title.trim() })
        } catch (error) {
          if (lifetime !== lifecycle) return
          if (error instanceof AgentHttpError && error.status === 404) {
            // 会话已被别处删除：按会话消失处理，过滤行并说明，弹窗正常关闭。
            listVersion += 1
            set({ sessions: get().sessions.filter(row => row.id !== id), listLoading: false })
            notify('原会话已不存在，列表已更新。', 'info')
            return
          }
          throw error
        }
        if (lifetime !== lifecycle) return
        // 服务端回执为权威：列表行与聊天页头标题都展示落库值（TrimSpace 后）。
        // 作废在途的列表读取，避免静默回读用旧标题覆盖刚确认的回执。
        listVersion += 1
        set({
          listLoading: false,
          sessions: get().sessions.map(row => row.id === id ? remote : row),
          ...(get().remoteSession?.id === id ? { remoteSession: { ...get().remoteSession!, title: remote.title } } : {}),
        })
        notify('会话已重命名。', 'success')
      },
      async deleteSession(api, id) {
        if (get().sending) return
        const lifetime = lifecycle
        try {
          await api.deleteSession(id)
        } catch (error) {
          if (lifetime !== lifecycle) return
          // 404 视为已删（幂等清理）；409 busy/unresolved 与其他错误不做本地清理，交给弹窗透传。
          if (!(error instanceof AgentHttpError && error.status === 404)) throw error
        }
        if (lifetime !== lifecycle) return
        listVersion += 1
        const fallback = get().sessions.find(row => row.id !== id)
        set({ sessions: get().sessions.filter(row => row.id !== id), listLoading: false })
        adapter.remove(id)
        set({ localSessions: adapter.list() })
        if (get().session && agentChatSessionKey(get().session!) === id) {
          const navigation = navigationVersion + 1
          if (fallback) await get().selectSession(api, fallback.id)
          else await get().newSession()
          if (lifetime === lifecycle && navigation === navigationVersion) notify(fallback ? '会话已删除，已切换到其他会话。' : '会话已删除，已新建空白会话。', 'info')
        } else notify('会话已删除。', 'success')
      },
      loading: false,
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
        attachmentPreparation?.abort()
        navigationVersion += 1
        initialBlank = false
        initialized = true
        generation += 1
        remoteVersion += 1
        attachmentUploadVersion += 1
        completedReasoning.clear()
        restoring = undefined
        set({ ...remoteBlank, loading: false })
        persist(blankSession())
      },
      async prepareRemoteSession(api, model) {
        if (get().sending || get().loading || !api.available || !model.active || !model.capabilities.text || !model.capabilities.tools) return
        const session = current()
        if (session.remote || session.pending) return
        const lifetime = lifecycle
        set({ sending: true })
        try {
          const remote = await api.createSession({ title: [...session.draft.trim()].slice(0, 40).join('') || '新会话', modelProfileId: model.id, modelRevision: model.revision })
          if (lifetime !== lifecycle || !stillCurrent(session.id)) return
          update({ remote: { sessionId: remote.id } })
          set({ remoteSession: remote })
          void get().loadSessions(api, false, true)
        } catch (cause) { if (lifetime === lifecycle && stillCurrent(session.id)) notify(failureMessage(cause)) }
        finally { if (lifetime === lifecycle && stillCurrent(session.id)) set({ sending: false }) }
      },
      setDraft: draft => { if (!current().pending) update({ draft }) },
      setUserInputAnswer(request, questionId, answer) {
        if (get().sending || get().stopping || get().run?.id !== request.runId || get().run?.status !== 'waiting-input' || request.status !== 'pending') return
        const draft = current().userInput
        if (draft?.id === request.id && draft.pending) return
        update({ userInput: { id: request.id, runId: request.runId, answers: { ...(draft?.id === request.id ? draft.answers : {}), [questionId]: answer } } })
      },
      async answerUserInput(api, request) {
        const session = current()
        const draft = session.userInput
        if (!api.available || get().sending || get().stopping || get().run?.id !== request.runId || get().run?.status !== 'waiting-input' || !draft || draft.id !== request.id) return
        const lifetime = lifecycle
        const valid = () => lifetime === lifecycle && stillCurrent(session.id)
        const input = draft.pending ?? { requestId: id(), answers: draft.answers }
        if (!draft.pending && !update({ userInput: { ...draft, pending: input } })) {
          update({ userInput: draft }); notify('无法保存回答标识，请恢复浏览器存储后再提交。'); return
        }
        set({ sending: true })
        try {
          const receipt = await api.answerUserInput(request.runId, request.id, input)
          if (!valid()) return
          update({ userInput: undefined })
          set({ run: receipt.run })
        } catch (error) {
          if (!valid()) return
          // 只回读确认，不自动重发；结果未知时保留精确回答和请求编号。
          try {
            const timeline = await api.timeline(request.runId)
            if (!valid()) return
            set({ timelines: { ...get().timelines, [request.runId]: timeline } })
            const confirmed = timeline.entries.find(entry => entry.kind === 'user-input' && entry.userInput.id === request.id)
            if (confirmed?.kind === 'user-input' && confirmed.userInput.status !== 'pending') update({ userInput: undefined })
          } catch { /* 保留未确认回答，供人工重试。 */ }
          if (valid()) {
            if (error instanceof AgentHttpError && ['invalid-user-input-answer', 'queue-full'].includes(error.code ?? '') && current().userInput?.id === request.id) update({ userInput: { ...draft, pending: undefined } })
            notify(failureMessage(error))
          }
        } finally {
          if (valid()) { set({ sending: false }); await get().refresh(api) }
        }
      },
      editMessage(messageId) {
        if (get().sending || get().uploadingAttachments || get().stopping || isChatRunActive(get().run) || current().pending || get().remoteSession?.activeRunId || get().remoteSession?.activeWorkflowId) return
        const last = get().messages.filter(message => message.role === 'user').at(-1)
        // 保存原轮引用；仅超限图片在提交前准备新附件，编辑模式仍只改文本。
        if (last?.id === messageId && current().editing?.messageId !== messageId) update({ editing: { messageId, taskId: last.taskId, text: last.content,
          ...(last.attachments?.length ? { attachments: last.attachments.map(attachment => ({ id: attachment.id })) } : {}) } })
      },
      setEditText(text) { if (current().editing && !get().sending && !current().pending) update({ editing: { ...current().editing!, text } }) },
      cancelEdit() { if (!get().sending && !current().pending) { discardPrepared(current()); update({ editing: undefined }) } },
      async stop(api) {
        const run = get().run
        if (!run || !isChatRunActive(run) || get().stopping || run.cancelRequestedAt) return
        const localId = current().id
        const lifetime = lifecycle
        const valid = () => lifetime === lifecycle && stillCurrent(localId) && get().run?.id === run.id
        set({ stopping: true })
        try {
          const stopped = await api.cancelRun(run.id)
          if (valid()) { remoteVersion += 1; observeRun(stopped, true); set({ run: stopped }) }
        } catch (error) { if (valid()) notify(failureMessage(error)) }
        finally {
          if (valid()) { await get().refresh(api); if (valid()) set({ stopping: false }) }
        }
      },
      setPermissionMode: permissionMode => { if (!get().sending && !isChatRunActive(get().run) && !get().remoteSession?.activeRunId && !get().remoteSession?.activeWorkflowId && !current().pending) update({ permissionMode, permissionVersion: 1 }) },
      setModel: modelId => { if (!get().sending && !get().uploadingAttachments && !isChatReplyActive(get().run) && !current().pending) update({ modelId, reasoningLevel: null }) },
      setReasoningLevel: reasoningLevel => { if (!get().sending && !isChatReplyActive(get().run) && !current().pending) update({ reasoningLevel }) },
      async addAttachments(api, files) {
        if (!files.length || get().uploadingAttachments) return
        const lifetime = lifecycle
        const ready = get().ensureSession()
        const sessionId = current().id
        const version = ++attachmentUploadVersion
        const valid = () => version === attachmentUploadVersion && lifetime === lifecycle && stillCurrent(sessionId)
        const controller = new AbortController()
        attachmentPreparation = controller
        set({ uploadingAttachments: true })
        try {
          await ready
          if (!valid()) return
          if (!api.available) { notify('当前为本地演示，请在已连接后端的面板中添加附件。'); return }
          // 编辑只改文本：编辑期间不允许往草稿添加附件，避免编辑重发静默捎带新图。
          if (current().editing) { notify('正在编辑消息，完成后才能添加附件。'); return }
          const existing = current().attachments
          // 整批压缩和总量校验成功后再上传，失败保留原草稿。
          const acceptedMime = AGENT_ATTACHMENT_LIMITS.acceptMimeTypes as readonly string[]
          const rejected = files.filter(file => !acceptedMime.includes(file.type))
          if (rejected.length) { notify('图片仅支持 JPEG 与 PNG，其他格式暂不支持。'); return }
          const prepared: File[] = []
          let total = existing.reduce((sum, attachment) => sum + attachment.size, 0)
          for (const file of files) {
            const processed = await prepareAgentImage(file, controller.signal)
            if (!valid()) return
            total += processed.size
            checkAttachmentTotal(total)
            prepared.push(processed)
          }
          checkAttachmentTotal(current().attachments.reduce((sum, attachment) => sum + attachment.size, 0) + prepared.reduce((sum, file) => sum + file.size, 0))
          const additions = await uploadAndStore(api, prepared, valid, controller.signal)
          if (!additions) return
          const session = current()
          if (session.attachments.reduce((sum, attachment) => sum + attachment.size, 0) + additions.reduce((sum, attachment) => sum + attachment.size, 0) > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) {
            await adapter.discard(additions.map(attachment => attachment.id))
            throw new Error(attachmentTotalNotice)
          }
          persist({ ...session, attachments: [...session.attachments, ...additions] })
        } catch (error) {
          if (valid()) notify(failureMessage(error))
        } finally {
          if (attachmentPreparation === controller) attachmentPreparation = undefined
          if (version === attachmentUploadVersion) set({ uploadingAttachments: false })
        }
      },
      removeAttachment(attachmentId) {
        if (get().sending) return
        const session = current()
        persist({ ...session, attachments: session.attachments.filter(attachment => attachment.id !== attachmentId) })
        void adapter.discard([attachmentId])
      },
      async send(api, model) {
        const session = current()
        const lifetime = lifecycle
        const text = session.pending?.input.content ?? (session.editing?.text ?? session.draft).trim()
        if (!api.available || !text || get().loading || get().sending || get().uploadingAttachments || get().stopping || isChatRunActive(get().run)) return false
        const version = ++submissionVersion
        const valid = () => lifetime === lifecycle && version === submissionVersion && stillCurrent(session.id)
        if (!session.pending) {
          // 新建发送：无 serverId 的旧版存量附件显式拦截并逐个点名，绝不静默丢弃或产出空引用。
          const stale = session.editing ? [] : session.attachments.filter(attachment => !attachment.serverId)
          if (stale.length) {
            notify(`存在未上传的附件（旧版本添加），请移除后重新添加再发送：${stale.map(attachment => attachment.name).join('、')}。`)
            return false
          }
          // 编辑重发：原轮附件 id 随 editing 携带；当前模型无图能力时提前拦截且不写 pending。
          if (session.editing?.attachments?.length && !model?.capabilities.image) {
            notify('当前模型不支持图片输入，无法重发带图消息，请切换支持图片的模型。')
            return false
          }
          if (!session.editing && session.attachments.length && !model?.capabilities.image) {
            notify('当前模型不支持图片输入，请移除附件或切换支持图片的模型。')
            return false
          }
        }
        if (new TextEncoder().encode(text).length > 32768) { notify('消息不能超过 32 KiB，请缩短后发送。'); return false }
        if (!session.pending && (!model?.active || !model.capabilities.text || !model.capabilities.tools)) {
          notify('请选择已启用且支持文本和工具调用的模型。'); return false
        }
        if (!session.pending && session.reasoningLevel && !model?.capabilities.reasoningLevels?.includes(session.reasoningLevel)) {
          notify('当前模型不支持已选思考等级，请重新选择。'); return false
        }
        set({ sending: true })
        remoteVersion += 1
        const controller = new AbortController()
        attachmentPreparation = controller
        try {
          if (session.pending) return await dispatchPending(api, session.id, lifetime, version)
          if (!model) return false
          const preparationValid = () => valid() && (!session.editing || (current().editing?.messageId === session.editing.messageId && current().editing?.taskId === session.editing.taskId))
          await prepareExistingAttachments(api, session, preparationValid, controller.signal)
          if (!valid()) return false
          if (!preparationValid()) throw new Error('原消息已变化，请重新选择需要编辑的消息。')
          let remote: AgentSession
          if (session.remote) {
            remote = await api.getSession(session.remote.sessionId)
            if (!valid()) return false
            set({ remoteSession: remote })
            if (remote.activeRunId || remote.activeWorkflowId) {
              await get().refresh(api)
              if (valid()) notify('会话仍在运行，请结束后再发送。')
              return false
            }
            // 同一模型的修订固定在会话中；仅用户选择不同模型时切换。
            if (remote.modelProfileId !== model.id) remote = await api.switchModel(remote.id, { modelProfileId: model.id, modelRevision: model.revision })
          } else {
            remote = await api.createSession({ title: [...text].slice(0, 40).join(''), modelProfileId: model.id, modelRevision: model.revision })
          }
          if (!valid()) return false
          set({ remoteSession: remote })
          // 编辑仅替换超限旧图的引用，绝不携带底部草稿中的附件。
          const preparedSession = current()
          const attachments = preparedSession.editing ? preparedSession.editing.attachments?.map(ref => ({
            id: preparedSession.editing!.preparedAttachments?.find(item => item.sourceId === ref.id)?.attachment.serverId ?? ref.id,
          })) : preparedSession.attachments.length ? preparedSession.attachments.map(attachment => ({ id: attachment.serverId! })) : undefined
          const saved = update({ remote: { ...current().remote, sessionId: remote.id }, pending: { input: { requestId: id(), content: text, permissionMode: session.permissionMode,
            ...(session.editing ? { replaceMessageId: session.editing.messageId } : {}),
            ...(session.reasoningLevel ? { reasoningLevel: session.reasoningLevel } : {}),
            ...(attachments?.length ? { attachments } : {}) }, taskId: session.editing?.taskId ?? current().remote?.taskId } })
          if (!saved) { update({ pending: undefined }); notify('无法保存发送标识，请恢复浏览器存储后再发送。'); return false }
          return await dispatchPending(api, session.id, lifetime, version)
        } catch (error) {
          if (valid()) notify(failureMessage(error))
          return false
        } finally {
          if (attachmentPreparation === controller) attachmentPreparation = undefined
          if (valid()) set({ sending: false })
        }
      },
      async watchOutput(api, runId, signal) {
        const localId = current().id
        const lifetime = lifecycle
        const valid = () => lifetime === lifecycle && !signal.aborted && stillCurrent(localId) && get().run?.id === runId
        try {
          await api.stream(runId, output => {
            if (!valid() || !isChatRunActive(get().run)) return
            if (get().timelines[runId]?.done && !output.done) return
            set(state => ({ liveOutput: output, reasoning: { ...state.reasoning, [runId]: output.reasoning },
              ...(output.timeline ? { timelines: { ...state.timelines, [runId]: output.timeline } } : {}) }))
          }, signal)
          if (valid()) await get().refresh(api, signal)
        } catch {
          if (valid()) set({ syncError: '实时连接暂时中断，正在重新连接；已接收的内容已保留。' })
        }
      },
      async refresh(api, signal) {
        const session = current()
        if (!session.remote) return
        const lifetime = lifecycle
        const version = ++remoteVersion
        const valid = () => lifetime === lifecycle && !signal?.aborted && stillCurrent(session.id) && version === remoteVersion
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
          set({ remoteSession: remote, run, syncError: null })
          // 从历史新打开的会话，以服务端模型初始化本地偏好。
          if (!current().modelId) update({ modelId: remote.modelProfileId })
          if (latestRun) acceptRun(latestRun)
          if (run) set({ run })
          if (run) observeRun(run)
          // 只有成功读过终态的旧轮才跳过；生成中快照仍需补齐，以服务端快照替换而非累加。
          const runIds = [...new Set([...messages.map(message => message.runId), ...(run ? [run.id] : [])])]
          for (const id of runIds) {
            if (id !== run?.id && completedReasoning.has(id)) continue
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
            if (sessionMissing) {
              const missing = session.remote.sessionId
              const fallback = get().sessions.find(row => row.id !== missing)
              set({ sessions: get().sessions.filter(row => row.id !== missing) })
              const navigation = navigationVersion + 1
              if (fallback) await get().selectSession(api, fallback.id)
              else await get().newSession()
              if (lifetime === lifecycle && navigation === navigationVersion && !signal?.aborted) notify('原会话已不存在，已切换会话。原草稿和未确认请求仍保存在本地。', 'info')
            } else set({ syncError: failureMessage(error) })
          }
        } finally { if (valid()) set({ refreshing: false }) }
      },
    }
  })
}

export const useAgentChatStore = createAgentChatStore(agentChatLocalAdapter)

import { randomId } from '../utils/randomId'
import { AGENT_CHAT_TEXT_BYTES } from '../contracts/agentChat'
import { create } from 'zustand'
import { RUNTIME_RUN_STATUS_LABELS, type AgentAttachmentRef, type AgentChatOutput, type AgentChatTimelineSnapshot, type AgentMessage, type AgentMessageAttachment, type AgentModelProfile, type AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'
import { agentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import { useMessageStore, type MessageTone } from './messageStore'
import type { AgentChatAdapter, AgentChatPermissionMode, AgentChatSession, AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'
import type { AgentUserInputAnswer, AgentUserInputRequest } from '@elysian/contracts'
import { messageOf } from '../utils/errorMessage'
import { createAgentChatAttachments, type AgentChatAttachmentState } from './agentChatAttachments'
import { createAgentChatDirectory, type AgentChatDirectoryState } from './agentChatDirectory'
import { applySubmissionReceipt, isConfirmedRejection } from './agentChatSubmission'

type AgentChatState = AgentChatDirectoryState & AgentChatAttachmentState & {
  setUserInputAnswer(request: AgentUserInputRequest, questionId: string, answer: AgentUserInputAnswer): void
  answerUserInput(api: AgentConversationAdapter, request: AgentUserInputRequest): Promise<void>
  session: AgentChatSession | null
  initialize(api: AgentConversationAdapter, requestedId?: string): Promise<void>
  selectSession(api: AgentConversationAdapter, key: string): Promise<void>
  clearDisplay(): void
  reportOperation(message: string, tone?: MessageTone): void
  inputError: string | null
  reportInput(message: string): void
  remoteSession: AgentSession | null
  messages: readonly AgentMessage[]
  /** 仅用于发送过程的即时回显，正式消息回读后移除，不写入公开历史或本地消息记录。 */
  outgoingMessage: { content: string; attachments: readonly AgentMessageAttachment[]; runId?: string } | null
  reasoning: Readonly<Record<string, string>>
  timelines: Readonly<Record<string, AgentChatTimelineSnapshot>>
  liveOutput: AgentChatOutput | null
  run: AgentChatRun | null
  sending: boolean
  stopping: boolean
  refreshing: boolean
  syncErrorMessage?: string
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
  send(api: AgentConversationAdapter, model?: AgentModelProfile, continueFromRunId?: string): Promise<boolean>
  continueTask(api: AgentConversationAdapter, model?: AgentModelProfile): Promise<boolean>
  refresh(api: AgentConversationAdapter, signal?: AbortSignal, refreshRunIds?: readonly string[]): Promise<void>
  watchOutput(api: AgentConversationAdapter, runId: string, signal: AbortSignal): Promise<void>
}

const persistenceNotice = '浏览器暂时无法保存会话，刷新后可能丢失本页内容。'
const remoteBlank = { remoteSession: null, messages: [], outgoingMessage: null, reasoning: {}, timelines: {}, liveOutput: null, run: null, sending: false, uploadingAttachments: false, stopping: false, refreshing: false, syncErrorMessage: undefined, inputError: null }
const outgoingMessageFor = (session: AgentChatSession, content: string, refs?: readonly AgentAttachmentRef[]) => ({
  content,
  attachments: session.attachments.filter(attachment => attachment.serverId && (!refs || refs.some(ref => ref.id === attachment.serverId)))
    .map((attachment): AgentMessageAttachment => ({ id: attachment.serverId!, name: attachment.name, mimeType: attachment.type as 'image/jpeg' | 'image/png', bytes: attachment.size, width: attachment.width!, height: attachment.height! })),
})
export const isChatRunActive = (run: AgentChatRun | null) => !!run && ['queued', 'running', 'waiting-input', 'waiting-approval', 'waiting-resource', 'waiting-task', 'waiting-recovery', 'waiting-model', 'waiting-storage', 'recovery-required'].includes(run.status)
export const isChatReplyActive = (run: AgentChatRun | null) => isChatRunActive(run) && run?.phase !== 'final-memory'
export const chatRunFailure = (run: AgentChatRun | null) => run && !isChatRunActive(run) && run.status !== 'succeeded' && run.status !== 'cancelled' && !run.budgetStop
  ? `${RUNTIME_RUN_STATUS_LABELS[run.status]}${run.error ? `：${run.error.message}` : ''}`
  : null
const failureMessage = (error: unknown) => messageOf(error, '会话请求失败')

export function createAgentChatStore(adapter: AgentChatAdapter, now: () => string = () => new Date().toISOString(), id: () => string = () => randomId()) {
  return create<AgentChatState>((set, get) => {
    let restoring: Promise<void> | undefined
    let generation = 0
    let remoteVersion = 0
    let lifecycle = 0
    let navigationVersion = 0
    let submissionVersion = 0
    let initialBlank = false
    let initialized = false
    let initialization: Promise<void> | undefined
    let persistenceFailed = false
    const observedActiveRuns = new Set<string>()
    const notifiedRunFailures = new Set<string>()
    const notifiedRunStatuses = new Map<string, string>()
    const notify = (message: string, tone: MessageTone = 'danger') => useMessageStore.getState().notify({ message, tone })
    const reportInput = (message: string) => set({ inputError: message })
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
    const captureLifetime = () => {
      const lifetime = lifecycle
      return () => lifetime === lifecycle
    }
    const directory = createAgentChatDirectory({
      adapter, set, get, notify, captureLifetime,
      async onSelectedSessionDeleted(api, fallback, current) {
        attachmentFlow.invalidate()
        generation += 1; remoteVersion += 1; submissionVersion += 1
        completedReasoning.clear()
        set({ ...remoteBlank, restoringAttachments: false })
        const navigation = navigationVersion + 1
        if (fallback) await get().selectSession(api, fallback.id)
        else await get().newSession()
        if (current() && navigation === navigationVersion) notify(fallback ? '会话已删除，已切换到其他会话。' : '会话已删除，已新建空白会话。', 'info')
      },
    })
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
    const current = (): AgentChatSession => get().session ?? adapter.read() ?? blankSession()
    const update = (patch: Partial<AgentChatSession>) => persist({ ...current(), ...patch })
    const stillCurrent = (localId: string) => get().session?.id === localId
    const attachmentFlow = createAgentChatAttachments({
      adapter, get, set, current, persist, update, notify, reportInput, captureLifetime,
      startRestore(session) {
        const currentGeneration = ++generation
        if (get().session?.id !== session.id) { attachmentFlow.invalidate(); remoteVersion += 1; completedReasoning.clear(); set(remoteBlank) }
        set({
          session,
          restoringAttachments: true,
          outgoingMessage: session.pending && !session.pending.input.replaceMessageId
            ? outgoingMessageFor(session, session.pending.input.content, session.pending.input.attachments ?? [])
            : null,
        })
        return () => currentGeneration === generation && get().session?.id === session.id
      },
    })
    // 跨标签只同步当前会话的数据，选中项由各标签自己的 URL 与内存决定。
    adapter.subscribe(() => {
      if (!get().session) return
      set({ localSessions: adapter.list() })
      const currentSession = get().session
      if (!currentSession || get().sending) return
      const session = adapter.read(agentChatSessionKey(currentSession))
      if (session && JSON.stringify(session) !== JSON.stringify(currentSession)) void attachmentFlow.restore(session)
    })
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
      const session = current()
      if (session.editing && !session.pending && messages.filter(message => message.role === 'user').at(-1)?.id !== session.editing.messageId) {
        attachmentFlow.discardPrepared(session)
        update({ editing: undefined })
      }
    }
    const acceptRun = (run: AgentChatRun, owner = current(), display = true) => {
      const session = get().session?.id === owner.id ? current() : adapter.read(agentChatSessionKey(owner)) ?? owner
      const { next, acceptedInput, consumedAttachmentIds } = applySubmissionReceipt(session, run)
      if (acceptedInput?.replaceMessageId) attachmentFlow.discardPrepared(session)
      if (consumedAttachmentIds.length) void adapter.discard(consumedAttachmentIds)
      if (!display || get().session?.id !== owner.id) { adapter.write(next, false); if (get().session) set({ localSessions: adapter.list() }); return }
      if (acceptedInput && !acceptedInput.replaceMessageId) {
        set({ outgoingMessage: get().messages.some(message => message.role === 'user' && message.runId === run.id)
          ? null : { ...outgoingMessageFor(session, acceptedInput.content, acceptedInput.attachments ?? []), runId: run.id } })
      }
      persist(next)
      if (acceptedInput?.replaceMessageId) {
        const replaced = get().messages.find(message => message.id === acceptedInput.replaceMessageId)
        if (replaced) setMessages(get().messages
          .filter(message => message.runId !== replaced.runId || message.id === replaced.id)
          .map(message => message.id === replaced.id ? { ...message, content: acceptedInput.content, runId: run.id, runStatus: run.status,
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
      const remoteId = session.remote!.sessionId
      const deletionVersion = directory.deletionVersion(remoteId)
      const valid = () => lifecycleAtStart === lifecycle && version === submissionVersion && stillCurrent(localId)
      try {
        const run = pending.taskId
          ? await api.continueTask(pending.taskId, pending.input)
          : await api.createTask(session.remote!.sessionId, pending.input)
        if (directory.deletionVersion(remoteId) !== deletionVersion) return false
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
          set({ outgoingMessage: null })
          if (error instanceof AgentHttpError && error.code === 'attachment-invalid' && current().editing?.preparedAttachments?.length) {
            attachmentFlow.discardPrepared(current())
            update({ editing: { ...current().editing!, preparedAttachments: undefined }, pending: undefined })
          } else update({ pending: undefined })
        }
        const message = rejected ? failureMessage(error) : `${failureMessage(error)}。发送结果尚未确认，可重试确认同一条消息。`
        reportInput(message)
        notify(message)
        return false
      }
    }
    return {
      ...remoteBlank,
      ...directory.state,
      ...attachmentFlow.actions,
      session: null,
      reportOperation: notify,
      reportInput,
      clearDisplay() {
        attachmentFlow.invalidate()
        generation += 1; remoteVersion += 1; lifecycle += 1; navigationVersion += 1
        const directoryDisplay = directory.resetDisplay()
        initialBlank = false
        initialized = false; initialization = undefined; restoring = undefined
        completedReasoning.clear()
        clearRunFeedback()
        attachmentFlow.clearFeedback()
        persistenceFailed = false
        set({ ...remoteBlank, ...directoryDisplay, session: null, restoringAttachments: false })
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
        await attachmentFlow.restore(session)
        if (lifetime !== lifecycle || navigation !== navigationVersion || get().session?.id !== session.id) return
        set({ localSessions: adapter.list() })
        if (session.remote && api.available) await get().refresh(api)
      },
      restoringAttachments: false,
      async ensureSession() {
        if (get().session) { await restoring; return }
        if (restoring) { await restoring; return }
        const session = adapter.read()
        if (session) {
          restoring = attachmentFlow.restore(session)
          try { await restoring } finally { restoring = undefined }
        } else { initialBlank = true; persist(blankSession()) }
      },
      async newSession() {
        if (get().sending) return
        const session = blankSession()
        attachmentFlow.invalidate()
        navigationVersion += 1
        initialBlank = false
        initialized = true
        generation += 1
        remoteVersion += 1
        completedReasoning.clear()
        restoring = undefined
        set({ ...remoteBlank, restoringAttachments: false })
        persist(session)
      },
      async prepareRemoteSession(api, model) {
        if (get().sending || get().restoringAttachments || !api.available || !model.active || !model.capabilities.text || !model.capabilities.tools) return
        const session = current()
        if (session.remote || session.pending) return
        const lifetime = lifecycle
        set({ sending: true })
        try {
          const remote = await api.createSession({ title: [...session.draft.trim()].slice(0, 40).join('') || '新会话', modelProfileId: model.id, modelRevision: model.revision })
          if (lifetime !== lifecycle || !stillCurrent(session.id)) return
          update({ remote: { sessionId: remote.id } })
          set({ remoteSession: remote })
          void get().loadSessions(api, { silent: true })
        } catch (cause) { if (lifetime === lifecycle && stillCurrent(session.id)) notify(failureMessage(cause)) }
        finally { if (lifetime === lifecycle && stillCurrent(session.id)) set({ sending: false }) }
      },
      setDraft: draft => { set({ inputError: null }); if (!current().pending) update({ draft }) },
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
      setEditText(text) { set({ inputError: null }); if (current().editing && !get().sending && !current().pending) update({ editing: { ...current().editing!, text } }) },
      cancelEdit() { if (!get().sending && !current().pending) { attachmentFlow.discardPrepared(current()); update({ editing: undefined }) } },
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
      setModel: modelId => { set({ inputError: null }); if (!get().sending && !get().uploadingAttachments && !isChatReplyActive(get().run) && !current().pending) update({ modelId, reasoningLevel: null }) },
      setReasoningLevel: reasoningLevel => { set({ inputError: null }); if (!get().sending && !isChatReplyActive(get().run) && !current().pending) update({ reasoningLevel }) },
      async continueTask(api, model) {
        const session = current()
        if (session.pending) {
          if (!session.pending.input.continueFromRunId) return false
          return get().send(api, model)
        }
        const source = get().run
        if (!source?.continuation?.allowed || source.id !== session.remote?.runId || source.taskId !== session.remote.taskId || session.editing) {
          reportInput(source?.continuation?.blockedReason ?? '原轮次不再支持继续，请刷新会话。')
          return false
        }
        return get().send(api, model, source.id)
      },
      async send(api, model, continueFromRunId) {
        const session = current()
        const lifetime = lifecycle
        const continuing = session.pending?.input.continueFromRunId ?? continueFromRunId
        const text = session.pending?.input.content ?? (continuing ? '继续完成上轮未完成的任务。' : (session.editing?.text ?? session.draft).trim())
        if (!api.available || !text || get().restoringAttachments || get().sending || get().uploadingAttachments || get().stopping || isChatRunActive(get().run)) return false
        const version = ++submissionVersion
        const valid = () => lifetime === lifecycle && version === submissionVersion && stillCurrent(session.id)
        if (!session.pending) {
          // 新建发送：无 serverId 的旧版存量附件显式拦截并逐个点名，绝不静默丢弃或产出空引用。
          const stale = session.editing || continuing ? [] : session.attachments.filter(attachment => !attachment.serverId)
          if (stale.length) {
            reportInput(`存在未上传的附件（旧版本添加），请移除后重新添加再发送：${stale.map(attachment => attachment.name).join('、')}。`)
            return false
          }
          // 编辑重发：原轮附件 id 随 editing 携带；当前模型无图能力时提前拦截且不写 pending。
          if (session.editing?.attachments?.length && !model?.capabilities.image) {
            reportInput('当前模型不支持图片输入，无法重发带图消息，请切换支持图片的模型。')
            return false
          }
          if (!continuing && !session.editing && session.attachments.length && !model?.capabilities.image) {
            reportInput('当前模型不支持图片输入，请移除附件或切换支持图片的模型。')
            return false
          }
        }
        if (new TextEncoder().encode(text).length > AGENT_CHAT_TEXT_BYTES) { reportInput('消息不能超过 32 KiB，请缩短后发送。'); return false }
        if (!session.pending && (!model?.active || !model.capabilities.text || !model.capabilities.tools)) {
          reportInput('请选择已启用且支持文本和工具调用的模型。'); return false
        }
        if (!session.pending && session.reasoningLevel && !model?.capabilities.reasoningLevels?.includes(session.reasoningLevel)) {
          reportInput('当前模型不支持已选思考等级，请重新选择。'); return false
        }
        set({ sending: true, inputError: null, outgoingMessage: session.editing || session.pending?.input.replaceMessageId ? null
          : outgoingMessageFor(session, text, session.pending ? session.pending.input.attachments ?? [] : continuing ? [] : undefined) })
        remoteVersion += 1
        const controller = attachmentFlow.beginPreparation()
        try {
          if (session.pending) return await dispatchPending(api, session.id, lifetime, version)
          if (!model) return false
          const preparationValid = () => valid() && (!session.editing || (current().editing?.messageId === session.editing.messageId && current().editing?.taskId === session.editing.taskId))
          if (!continuing) await attachmentFlow.prepareExistingAttachments(api, session, preparationValid, controller.signal)
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
          const attachments = continuing ? undefined : preparedSession.editing ? preparedSession.editing.attachments?.map(ref => ({
            id: preparedSession.editing!.preparedAttachments?.find(item => item.sourceId === ref.id)?.attachment.serverId ?? ref.id,
          })) : preparedSession.attachments.length ? preparedSession.attachments.map(attachment => ({ id: attachment.serverId! })) : undefined
          const saved = update({ remote: { ...current().remote, sessionId: remote.id }, pending: { input: { requestId: id(), content: text, permissionMode: session.permissionMode, extensionMode: 'enabled', authorizationMode: 'on-demand',
            ...(session.editing ? { replaceMessageId: session.editing.messageId } : {}),
            ...(continuing ? { continueFromRunId: continuing } : {}),
            ...(session.reasoningLevel ? { reasoningLevel: session.reasoningLevel } : {}),
            ...(attachments?.length ? { attachments } : {}) }, taskId: session.editing?.taskId ?? current().remote?.taskId } })
          if (!saved) { update({ pending: undefined }); notify('无法保存发送标识，请恢复浏览器存储后再发送。'); return false }
          if (!session.editing) set({ outgoingMessage: outgoingMessageFor(preparedSession, text, attachments ?? []) })
          return await dispatchPending(api, session.id, lifetime, version)
        } catch (error) {
          if (valid()) { reportInput(failureMessage(error)); notify(failureMessage(error)) }
          return false
        } finally {
          attachmentFlow.finishPreparation(controller)
          if (valid()) set({ sending: false, ...(!current().pending && !get().outgoingMessage?.runId ? { outgoingMessage: null } : {}) })
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
          if (valid()) set({ syncErrorMessage: '实时连接暂时中断，正在重新连接；已接收的内容已保留。' })
        }
      },
      async refresh(api, signal, refreshRunIds) {
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
            if (sessionMissing) {
              const missing = session.remote.sessionId
              const fallback = get().sessions.find(row => row.id !== missing)
              set({ sessions: get().sessions.filter(row => row.id !== missing) })
              const navigation = navigationVersion + 1
              if (fallback) await get().selectSession(api, fallback.id)
              else await get().newSession()
              if (lifetime === lifecycle && navigation === navigationVersion && !signal?.aborted) notify('原会话已不存在，已切换会话。原草稿和未确认请求仍保存在本地。', 'info')
            } else set({ syncErrorMessage: failureMessage(error) })
          }
        } finally { if (valid()) set({ refreshing: false }) }
      },
    }
  })
}

export const useAgentChatStore = createAgentChatStore(agentChatLocalAdapter)

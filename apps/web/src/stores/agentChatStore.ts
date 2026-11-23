import { randomId } from '../utils/randomId'
import { AGENT_CHAT_TEXT_BYTES } from '../contracts/agentChat'
import { create } from 'zustand'
import type { AgentAttachmentRef, AgentMessageAttachment, AgentModelProfile, AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'
import { agentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import { useMessageStore, type MessageTone } from './messageStore'
import type { AgentChatAdapter, AgentChatPermissionMode, AgentChatSession, AgentChatRun, AgentConversationAdapter } from '../contracts/agentChat'
import type { AgentUserInputAnswer, AgentUserInputRequest } from '@elysian/contracts'
import { messageOf } from '../utils/errorMessage'
import { createAgentChatAttachments, type AgentChatAttachmentState } from './agentChatAttachments'
import { createAgentChatDirectory, type AgentChatDirectoryState } from './agentChatDirectory'
import { createAgentChatRuntime, hasActiveChatRun, type AgentChatRuntimeState } from './agentChatRuntime'
import { applySubmissionReceipt, isConfirmedRejection } from './agentChatSubmission'

export { chatRunFailure, hasActiveChatRun, isChatReplyActive, isChatRunActive } from './agentChatRuntime'

type AgentChatState = AgentChatDirectoryState & AgentChatAttachmentState & AgentChatRuntimeState & {
  setUserInputAnswer(request: AgentUserInputRequest, questionId: string, answer: AgentUserInputAnswer): void
  answerUserInput(api: AgentConversationAdapter, request: AgentUserInputRequest): Promise<void>
  session: AgentChatSession | null
  initialize(api: AgentConversationAdapter, requestedId?: string): Promise<void>
  selectSession(api: AgentConversationAdapter, key: string): Promise<void>
  clearDisplay(): void
  reportOperation(message: string, tone?: MessageTone): void
  inputError: string | null
  reportInput(message: string): void
  sending: boolean
  ensureSession(): Promise<void>
  prepareRemoteSession(api: AgentConversationAdapter, model: AgentModelProfile): Promise<void>
  newSession(): Promise<void>
  setDraft(draft: string): void
  editMessage(messageId: string): void
  setEditText(text: string): void
  cancelEdit(): void
  setPermissionMode(permissionMode: AgentChatPermissionMode): void
  setModel(modelId: string | null): void
  setReasoningLevel(reasoningLevel: string | null): void
  send(api: AgentConversationAdapter, model?: AgentModelProfile, continueFromRunId?: string): Promise<boolean>
  continueTask(api: AgentConversationAdapter, model?: AgentModelProfile): Promise<boolean>

}

const persistenceNotice = '浏览器暂时无法保存会话，刷新后可能丢失本页内容。'
const remoteBlank = { remoteSession: null, messages: [], outgoingMessage: null, reasoning: {}, timelines: {}, liveOutput: null, confirmedReplyId: undefined, run: null, sending: false, uploadingAttachments: false, stopping: false, refreshing: false, syncErrorMessage: undefined, inputError: null }
const outgoingMessageFor = (session: AgentChatSession, content: string, refs?: readonly AgentAttachmentRef[]) => ({
  content,
  attachments: session.attachments.filter(attachment => attachment.serverId && (!refs || refs.some(ref => ref.id === attachment.serverId)))
    .map((attachment): AgentMessageAttachment => ({ id: attachment.serverId!, name: attachment.name, mimeType: attachment.type as 'image/jpeg' | 'image/png', bytes: attachment.size, width: attachment.width!, height: attachment.height! })),
})
const failureMessage = (error: unknown) => messageOf(error, '会话请求失败')

export function createAgentChatStore(adapter: AgentChatAdapter, now: () => string = () => new Date().toISOString(), id: () => string = () => randomId()) {
  return create<AgentChatState>((set, get) => {
    let restoring: Promise<void> | undefined
    let generation = 0
    let lifecycle = 0
    let navigationVersion = 0
    let submissionVersion = 0
    let initialBlank = false
    let initialized = false
    let initialization: Promise<void> | undefined
    let persistenceFailed = false
    const notify = (message: string, tone: MessageTone = 'danger') => useMessageStore.getState().notify({ message, tone })
    const reportInput = (message: string) => set({ inputError: message })
    const captureLifetime = () => {
      const lifetime = lifecycle
      return () => lifetime === lifecycle
    }
    const directory = createAgentChatDirectory({
      adapter, set, get, notify, captureLifetime,
      async onSelectedSessionDeleted(api, fallback, current) {
        attachmentFlow.invalidate()
        generation += 1; runtime.invalidateReads(); submissionVersion += 1
        runtime.clearTimelineCache()
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
    const preferencesLocked = () => {
      const state = get()
      return state.sending || state.stopping || state.restoringAttachments || !!current().pending
    }
    const stillCurrent = (localId: string) => get().session?.id === localId
    const attachmentFlow = createAgentChatAttachments({
      adapter, get, set, current, persist, update, notify, reportInput, captureLifetime,
      startRestore(session) {
        const currentGeneration = ++generation
        if (get().session?.id !== session.id) { attachmentFlow.invalidate(); runtime.invalidateReads(); runtime.clearTimelineCache(); set(remoteBlank) }
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
    const runtime = createAgentChatRuntime({
      get, set, current, update, notify, captureLifetime,
      acceptRun: run => acceptRun(run),
      onMessagesUpdated(messages) {
        const session = current()
        if (session.editing && !session.pending && messages.filter(message => message.role === 'user').at(-1)?.id !== session.editing.messageId) {
          attachmentFlow.discardPrepared(session)
          update({ editing: undefined })
        }
      },
      async onSessionMissing(api, missing, current, signal) {
        const fallback = get().sessions.find(row => row.id !== missing)
        set({ sessions: get().sessions.filter(row => row.id !== missing) })
        const navigation = navigationVersion + 1
        if (fallback) await get().selectSession(api, fallback.id)
        else await get().newSession()
        if (current() && navigation === navigationVersion && !signal?.aborted) notify('原会话已不存在，已切换会话。原草稿和未确认请求仍保存在本地。', 'info')
      },
    })
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
        if (replaced) runtime.setMessages(get().messages
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
        runtime.observeRun(run, true)
        runtime.invalidateReads()
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
      ...runtime.actions,
      session: null,
      reportOperation: notify,
      reportInput,
      clearDisplay() {
        attachmentFlow.invalidate()
        generation += 1; runtime.invalidateReads(); lifecycle += 1; navigationVersion += 1
        const directoryDisplay = directory.resetDisplay()
        initialBlank = false
        initialized = false; initialization = undefined; restoring = undefined
        runtime.clearTimelineCache()
        runtime.clearRunFeedback()
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
        runtime.invalidateReads()
        runtime.clearTimelineCache()
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
        if (get().sending || get().uploadingAttachments || get().stopping || current().pending || hasActiveChatRun(get())) return
        const last = get().messages.filter(message => message.role === 'user').at(-1)
        // 保存原轮引用；仅超限图片在提交前准备新附件，编辑模式仍只改文本。
        if (last?.id === messageId && current().editing?.messageId !== messageId) update({ editing: { messageId, taskId: last.taskId, text: last.content,
          ...(last.attachments?.length ? { attachments: last.attachments.map(attachment => ({ id: attachment.id })) } : {}) } })
      },
      setEditText(text) { set({ inputError: null }); if (current().editing && !get().sending && !current().pending) update({ editing: { ...current().editing!, text } }) },
      cancelEdit() { if (!get().sending && !current().pending) { attachmentFlow.discardPrepared(current()); update({ editing: undefined }) } },
      setPermissionMode: permissionMode => { if (!preferencesLocked()) update({ permissionMode, permissionVersion: 1 }) },
      setModel: modelId => { if (!preferencesLocked()) { set({ inputError: null }); update({ modelId, reasoningLevel: null }) } },
      setReasoningLevel: reasoningLevel => { if (!preferencesLocked()) { set({ inputError: null }); update({ reasoningLevel }) } },
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
        if (!api.available || !text || get().restoringAttachments || get().sending || get().uploadingAttachments || get().stopping || hasActiveChatRun(get())) return false
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
        runtime.invalidateReads()
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
    }
  })
}

export const useAgentChatStore = createAgentChatStore(agentChatLocalAdapter)

import { useCallback, useEffect, useRef, type ClipboardEvent, type DragEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useShellLayout } from '../../app/layout/ShellLayoutContext'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { Plus } from '../../components/icons'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useImeEnterGuard } from '../../components/useImeEnterGuard'
import { isChatReplyActive, isChatRunActive, useAgentChatStore } from '../../stores/agentChatStore'
import { ChatComposer } from './ChatComposer'
import { ChatMessageList } from './ChatMessageList'
import { ChatSessionPane } from './ChatSessionPane'
import { defaultReasoningLevel, useChatModels } from './useChatModels'
import { useChatDirectoryPolling, useChatPolling } from './useChatPolling'
import { useChatUrlSync } from './useChatUrlSync'
import './agentChat.css'

/** 基本文本聊天，沿用现有会话、模型目录与任务续轮接口。 */
export function AgentChatPage() {
  const chat = useAgentChatStore(useShallow(state => ({
    session: state.session,
    remoteSession: state.remoteSession,
    messages: state.messages,
    run: state.run,
    timelines: state.timelines,
    reasoning: state.reasoning,
    liveOutput: state.liveOutput,
    outgoingMessage: state.outgoingMessage,
    restoringAttachments: state.restoringAttachments,
    refreshing: state.refreshing,
    sending: state.sending,
    stopping: state.stopping,
    uploadingAttachments: state.uploadingAttachments,
    syncErrorMessage: state.syncErrorMessage,
    inputError: state.inputError,
    localSessions: state.localSessions,
    initialize: state.initialize,
    newSession: state.newSession,
    selectSession: state.selectSession,
    loadSessions: state.loadSessions,
    refresh: state.refresh,
    watchOutput: state.watchOutput,
    send: state.send,
    stop: state.stop,
    continueTask: state.continueTask,
    setDraft: state.setDraft,
    editMessage: state.editMessage,
    setEditText: state.setEditText,
    cancelEdit: state.cancelEdit,
    setModel: state.setModel,
    setReasoningLevel: state.setReasoningLevel,
    setPermissionMode: state.setPermissionMode,
    setUserInputAnswer: state.setUserInputAnswer,
    answerUserInput: state.answerUserInput,
    addAttachments: state.addAttachments,
    removeAttachment: state.removeAttachment,
    reportInput: state.reportInput,
    reportOperation: state.reportOperation,
  })))
  const shell = useShellLayout()
  const { agentConversation: api, agentMemory } = useGateway()
  const { models, status, error, reload } = useChatModels()
  const navigation = useChatUrlSync(api, chat)
  const { navigationFailure } = navigation
  const input = useRef<HTMLTextAreaElement>(null)
  const editInput = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const ime = useImeEnterGuard()
  const session = chat.session
  const waitingInput = chat.run?.status === 'waiting-input'
  const model = models.find(item => item.id === session?.modelId)
  const busy = chat.sending || chat.stopping || isChatRunActive(chat.run) || !!chat.remoteSession?.activeRunId || !!chat.remoteSession?.activeWorkflowId
  const stopping = chat.stopping || (isChatRunActive(chat.run) && !!chat.run?.cancelRequestedAt)
  const finalizing = isChatRunActive(chat.run) && !isChatReplyActive(chat.run) && !chat.remoteSession?.activeWorkflowId
  const preferencesLocked = chat.sending || chat.uploadingAttachments || stopping || (busy && !finalizing)
  /** 思考等级只提供模型声明的档位：未选择或与当前模型不符时，取模型声明的默认档（官方预设按文档填入），未声明时优先「高」。 */
  const reasoningLevels = model?.reasoningLevels ?? []
  const reasoningLevel = session?.reasoningLevel && reasoningLevels.includes(session.reasoningLevel) ? session.reasoningLevel : defaultReasoningLevel(reasoningLevels, model?.defaultReasoningLevel) ?? ''
  const restoring = !!session?.remote && !chat.remoteSession
  const attachmentsLocked = !session || chat.restoringAttachments || busy || chat.uploadingAttachments || restoring || !!session.pending || !!session.editing
  const readError = navigationFailure || (chat.syncErrorMessage && error && chat.syncErrorMessage !== error
    ? `会话：${chat.syncErrorMessage}\n模型：${error}`
    : chat.syncErrorMessage || error)
  const retryReadLabel = navigationFailure ? '重新初始化会话' : chat.syncErrorMessage && error ? '重新读取会话和模型' : chat.syncErrorMessage ? '重新读取会话' : '重新读取模型'
  useFeedbackMessage(readError, !error && chat.syncErrorMessage?.startsWith('实时连接暂时中断') ? 'warning' : 'danger', { replace: true })
  const retryReads = () => {
    if (navigationFailure) navigation.retryNavigation()
    if (chat.syncErrorMessage) void chat.refresh(api)
    if (error) reload()
  }

  useChatDirectoryPolling(api, chat.loadSessions)
  useEffect(() => {
    if (!session || status !== 'ready' || model || busy || session.pending) return
    // 已绑定的会话不在目录刷新时静默更换模型。
    if (!session.remote && session.modelId !== (models[0]?.id ?? null)) chat.setModel(models[0]?.id ?? null)
  }, [session?.id, session?.modelId, session?.remote, session?.pending, model, models, status, busy, chat.setModel])
  useEffect(() => {
    // 选择器不提供「默认」项：未选择或旧选择失效时把模型声明的默认档落进会话记录，提交与展示同一来源。
    if (!model || chat.restoringAttachments || chat.sending || session?.pending) return
    if ((session?.reasoningLevel ?? '') !== reasoningLevel) chat.setReasoningLevel(reasoningLevel || null)
  }, [model, reasoningLevel, session?.reasoningLevel, session?.pending, chat.restoringAttachments, chat.sending, chat.setReasoningLevel])

  const liveRunId = isChatRunActive(chat.run) ? chat.run!.id : undefined
  const streamingRunId = waitingInput || chat.run?.status === 'waiting-approval' ? undefined : liveRunId
  const waitingForMessage = chat.sending || (!!liveRunId && !finalizing && !chat.messages.some(message => message.role === 'user' && message.runId === liveRunId))
  useChatPolling(api, chat, streamingRunId)
  const followContent = useCallback(() => {
    if (following.current && history.current) history.current.scrollTop = history.current.scrollHeight
  }, [])

  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [session?.draft])
  useEffect(() => { following.current = true }, [session?.id])
  useEffect(() => { if (session?.editing) editInput.current?.focus() }, [session?.editing?.messageId])
  useEffect(() => {
    if (following.current && history.current) history.current.scrollTop = history.current.scrollHeight
  }, [chat.messages.length, chat.outgoingMessage, chat.reasoning[chat.run?.id ?? ''], session?.id])

  const canSubmit = Boolean(api.available && (model || session?.pending) && !busy && !chat.uploadingAttachments && !chat.restoringAttachments && !restoring && (status === 'ready' || session?.pending))
  const canSend = Boolean(canSubmit && !session?.editing && !session?.pending?.input.replaceMessageId && !session?.pending?.input.continueFromRunId && session?.draft.trim())
  const canResend = Boolean(canSubmit && (session?.pending?.input.replaceMessageId || session?.editing?.text.trim()))
  const resend = () => {
    if (!canResend) return
    following.current = true
    void chat.send(api, model?.profile)
  }
  const send = () => {
    if (!canSend) return
    following.current = true
    void chat.send(api, model?.profile).then(sent => { if (sent) input.current?.focus() })
  }
  const insertPastedText = (event: ClipboardEvent<HTMLTextAreaElement>, editing: boolean) => {
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    const target = event.currentTarget
    const start = target.selectionStart
    const next = `${target.value.slice(0, start)}${text}${target.value.slice(target.selectionEnd)}`
    if (editing) chat.setEditText(next)
    else chat.setDraft(next)
    requestAnimationFrame(() => target.setSelectionRange(start + text.length, start + text.length))
  }
  const addFiles = (files: File[], editing = false) => {
    if (editing) { chat.reportInput('编辑消息时仅可修改文本，请完成编辑后再添加文件。'); return }
    if (attachmentsLocked) { chat.reportInput('当前暂不能添加文件，请等待会话读取或发送完成。'); return }
    void chat.addAttachments(api, files, model?.supportsImage ?? false)
  }
  const pasteFiles = (event: ClipboardEvent<HTMLTextAreaElement>, editing = false) => {
    const files = Array.from(event.clipboardData.files ?? [])
    if (!files.length) {
      for (const item of Array.from(event.clipboardData.items ?? [])) {
        if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
      }
    }
    if (!files.length) return
    event.preventDefault()
    insertPastedText(event, editing)
    addFiles(files, editing)
  }
  const dragFiles = (event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
  }
  const dropFiles = (event: DragEvent<HTMLElement>, editing = false) => {
    const files = Array.from(event.dataTransfer.files)
    if (!files.length && !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    if (!files.length) { chat.reportInput('无法添加文件夹，请选择具体文件。'); return }
    addFiles(files, editing)
  }
  const title = chat.remoteSession?.title || chat.messages[0]?.content || (session?.remote ? '当前会话' : '新会话')
  const newConversation = () => navigation.newConversation(() => {
    shell.closeConversationDrawer()
    input.current?.focus()
  })
  const selectConversation = (key: string) => navigation.selectConversation(key, shell.closeConversationDrawer)

  return <ChatSessionPane api={api} loadSessions={chat.loadSessions} onNew={newConversation} onSelect={selectConversation}>
    {toggle => <section aria-label="Ely 会话" className="agent-chat">
      <header className="chat-header">
        {toggle}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="chat-title max-w-64 truncate text-sm font-medium" title={title}>{title}</span>
        </div>
        <Button variant="outline" type="button" className="chat-new" disabled={chat.sending} onClick={newConversation}><Plus size={14} aria-hidden /><span>新会话</span></Button>
      </header>
      <ChatMessageList api={api} agentMemory={agentMemory} chat={chat} model={model} history={history} following={following}
        followContent={followContent} liveRunId={liveRunId} waitingForMessage={waitingForMessage} waitingInput={waitingInput}
        busy={busy} restoring={restoring} finalizing={finalizing} stopping={stopping} canSubmit={canSubmit}
        editor={{ ...ime, editInput, dragFiles, dropFiles, pasteFiles, canResend, resend }} />
      <ChatComposer api={api} chat={chat} input={input} model={model} models={models} status={status}
        reasoningLevels={reasoningLevels} reasoningLevel={reasoningLevel} readError={readError} retryReadLabel={retryReadLabel}
        retryReads={retryReads} liveRunId={liveRunId} waitingInput={waitingInput} busy={busy} stopping={stopping} finalizing={finalizing}
        restoring={restoring} attachmentsLocked={attachmentsLocked} canSubmit={canSubmit}
        controls={{ ...ime, preferencesLocked, canSend, send, dragFiles, dropFiles, pasteFiles, addFiles, followContent }} />
    </section>}
  </ChatSessionPane>
}

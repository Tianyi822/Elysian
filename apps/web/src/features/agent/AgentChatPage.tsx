import { Fragment, useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type Ref } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { useShellLayout } from '../../app/layout/ShellLayoutContext'
import { ChatSessionList } from './ChatSessionList'
import { Bot, Brain, Hand, Image as ImageIcon, List, Loader2, Paperclip, Pencil, Plus, Send, Square, ShieldAlert, ShieldCheck, X, type IconComponent } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { SelectDropdown } from '../../components/SelectDropdown'
import { RefreshButton } from '../../components/RefreshState'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { AGENT_COMPOSER_FILE_ACCEPT } from '../../adapters/local/agentTextFiles'
import { mediaQuery, observeMediaQuery } from '../../utils/mediaQuery'
import type { AgentChatPermissionMode } from '../../contracts/agentChat'
import { isChatReplyActive, isChatRunActive, useAgentChatStore } from '../../stores/agentChatStore'
import { ChatAttachment } from './ChatAttachment'
import { ChatMessageAttachments } from './ChatMessageAttachments'
import { ChatMessageCopy } from './ChatMessageCopy'
import { ChatApprovals } from './ChatApprovals'
import { ChatMemorySources } from './ChatMemory'
import { ChatResponse } from './ChatResponse'
import { ChatRuntimeResult } from './ChatRuntimeResult'
import { ChatPlan } from './ChatPlan'
import { ChatSwitchNotice, chatSwitchNotice } from './ChatSwitchNotice'
import { ChatTimeline } from './ChatTimeline'
import { ChatUserInput } from './ChatUserInput'
import { ChatUsageIndicator } from './ChatUsageIndicator'
import { defaultReasoningLevel, reasoningLabel, useChatModels } from './useChatModels'
import './agentChat.css'

const PERMISSION_MODES: readonly { value: AgentChatPermissionMode; label: string; description: string; Icon: IconComponent }[] = [
  { value: 'ask', label: '请求批准', description: '需要批准的操作，按服务端规则请求确认。', Icon: Hand },
  { value: 'assist', label: '帮我批准', description: '自动批准可恢复的工作区写入，以及无宿主写权限、无出网的隔离执行。', Icon: ShieldCheck },
  { value: 'full', label: '完全开放', description: '自动批准已启用能力所需的操作与运行时权限，系统禁区与资源限制继续生效。', Icon: ShieldAlert },
]

/** 会话列表开关固定在聊天页头内，仅保留读屏标签。 */
function SessionToggle({ expanded, controls, onClick, buttonRef }: {
  expanded: boolean
  controls: string
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const label = expanded ? '收起会话列表' : '打开会话列表'
  return <button ref={buttonRef} type="button" className="chat-session-toggle" aria-label={label}
    aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
    <List size={16} aria-hidden />
  </button>
}

/** 基本文本聊天，沿用现有会话、模型目录与任务续轮接口。 */
export function AgentChatPage() {
  const chat = useAgentChatStore()
  const shell = useShellLayout()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [navigationReady, setNavigationReady] = useState<string | null>(null)
  const [navigationFailure, setNavigationFailure] = useState<string | null>(null)
  const [navigationAttempt, setNavigationAttempt] = useState(0)
  const [listCollapsed, setListCollapsed] = useState(false)
  const [wide, setWide] = useState(() => mediaQuery('(min-width: 1100px)')?.matches ?? false)
  const [listRefreshing, setListRefreshing] = useState(false)
  const requestedId = params.get('session') || undefined
  const routeState = location.state && typeof location.state === 'object' ? location.state : {}
  const requestedDraft = typeof routeState.agentDraftId === 'string' ? routeState.agentDraftId : undefined
  const listTrigger = useRef<HTMLButtonElement>(null)
  const listDrawer = useRef<HTMLDivElement>(null)
  const restoreListFocus = useRef(false)
  const { agentConversation: api, agentMemory } = useGateway()
  const { models, status, error, reload } = useChatModels()
  const input = useRef<HTMLTextAreaElement>(null)
  const editInput = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const composing = useRef(false)
  const session = chat.session
  const usageTimeline = session?.remote?.runId ? chat.timelines[session.remote.runId] : undefined
  const waitingInput = chat.run?.status === 'waiting-input'
  const inputEntry = waitingInput ? chat.timelines[chat.run!.id]?.entries.find(entry => entry.kind === 'user-input' && entry.userInput.status === 'pending') : undefined
  const inputRequest = inputEntry?.kind === 'user-input' ? inputEntry.userInput : undefined
  const inputDraft = session?.userInput?.id === inputRequest?.id ? session?.userInput : undefined
  const permissionMode = PERMISSION_MODES.find(mode => mode.value === session?.permissionMode) ?? PERMISSION_MODES[0]!
  const PermissionIcon = permissionMode.Icon
  const model = models.find(item => item.id === session?.modelId)
  /** 模型标识与设置页的「模型 ID」列同一口径；服务名放副行，不占触发器宽度。 */
  const modelOptions = models.map(item => ({
    value: item.id,
    label: models.some(other => other.id !== item.id && other.model === item.model) ? `${item.model} · ${item.serviceName}` : item.model,
    description: item.serviceName,
  }))
  const busy = chat.sending || chat.stopping || isChatRunActive(chat.run) || !!chat.remoteSession?.activeRunId || !!chat.remoteSession?.activeWorkflowId
  const stopping = chat.stopping || (isChatRunActive(chat.run) && !!chat.run?.cancelRequestedAt)
  const finalizing = isChatRunActive(chat.run) && !isChatReplyActive(chat.run) && !chat.remoteSession?.activeWorkflowId
  const preferencesLocked = chat.sending || chat.uploadingAttachments || stopping || (busy && !finalizing)
  const lastUserMessage = chat.messages.filter(message => message.role === 'user').at(-1)
  /** 思考等级只提供模型声明的档位：未选择或与当前模型不符时，取模型声明的默认档（官方预设按文档填入），未声明时优先「高」。 */
  const reasoningLevels = model?.reasoningLevels ?? []
  const reasoningLevel = session?.reasoningLevel && reasoningLevels.includes(session.reasoningLevel) ? session.reasoningLevel : defaultReasoningLevel(reasoningLevels, model?.defaultReasoningLevel) ?? ''
  const restoring = !!session?.remote && !chat.remoteSession
  const attachmentsLocked = !session || chat.loading || busy || chat.uploadingAttachments || restoring || !!session.pending || !!session.editing
  const readError = navigationFailure || (chat.syncError && error && chat.syncError !== error
    ? `会话：${chat.syncError}\n模型：${error}`
    : chat.syncError || error)
  const retryReadLabel = navigationFailure ? '重新初始化会话' : chat.syncError && error ? '重新读取会话和模型' : chat.syncError ? '重新读取会话' : '重新读取模型'
  useFeedbackMessage(readError, !error && chat.syncError?.startsWith('实时连接暂时中断') ? 'warning' : 'danger', { replace: true })
  const modelUnavailable = api.available && status === 'ready' && !chat.loading && !restoring && (!models.length || (session?.remote && !model))
  const inputHints = [
    modelUnavailable ? '请选择支持文本与工具调用的可用模型，或前往设置添加模型。' : null,
    !api.available ? '当前为本地演示，请在已连接后端的面板中使用聊天。' : null,
    session?.attachments.length && model && !model.supportsImage ? '当前模型不支持图片输入，请移除附件或切换支持图片的模型。' : null,
    session?.attachments.some(attachment => !attachment.serverId) ? '存在旧版本添加、尚未上传的附件，请移除后重新添加。' : null,
  ].filter(Boolean)
  const retryReads = () => {
    if (navigationFailure) setNavigationAttempt(value => value + 1)
    if (chat.syncError) void chat.refresh(api)
    if (error) reload()
  }
  const focusListTrigger = () => listTrigger.current?.focus()

  useEffect(() => {
    let active = true
    setNavigationReady(null)
    setNavigationFailure(null)
    const restore = async () => {
      await chat.initialize(api, requestedId ?? requestedDraft)
      if (active) setNavigationReady(location.key)
    }
    void restore().catch(cause => {
      if (active) setNavigationFailure(`会话初始化失败：${cause instanceof Error ? cause.message : '请重新读取会话。'}`)
    })
    return () => { active = false }
  }, [api, location.key, requestedId, requestedDraft, chat.initialize, navigationAttempt])
  useEffect(() => {
    if (navigationReady !== location.key || !session || chat.loading || chat.sending) return
    const remoteId = session?.remote?.sessionId
    const draftId = remoteId ? undefined : session.id
    if (remoteId === requestedId && draftId === requestedDraft) return
    const next = new URLSearchParams(params)
    if (remoteId) next.set('session', remoteId)
    else next.delete('session')
    setParams(next, { replace: true, state: { ...routeState, agentDraftId: draftId } })
  }, [navigationReady, location.key, session?.id, session?.remote?.sessionId, requestedId, requestedDraft, chat.loading, chat.sending, params, setParams])
  useEffect(() => {
    if (!listCollapsed || !restoreListFocus.current) return
    restoreListFocus.current = false
    focusListTrigger()
  }, [listCollapsed])
  useEffect(() => {
    const media = mediaQuery('(min-width: 1100px)')
    if (!media) return
    const update = () => setWide(media.matches)
    update()
    return observeMediaQuery(media, update)
  }, [])
  useEffect(() => {
    if (wide && shell.conversationDrawerOpen) shell.closeConversationDrawer()
  }, [wide, shell.conversationDrawerOpen, shell.closeConversationDrawer])
  useEffect(() => {
    if (!api.available) return
    const timer = setInterval(() => {
      const state = useAgentChatStore.getState()
      if (document.visibilityState !== 'hidden' && !state.listLoading &&
          (state.sessions.some(row => row.activeRunId || row.activeWorkflowId) || state.localSessions.some(row => row.pending))) void chat.loadSessions(api, false, true)
    }, 5000)
    return () => clearInterval(timer)
  }, [api, chat.loadSessions])
  useEffect(() => {
    if (!session || status !== 'ready' || model || busy || session.pending) return
    // 已绑定的会话不在目录刷新时静默更换模型。
    if (!session.remote && session.modelId !== (models[0]?.id ?? null)) chat.setModel(models[0]?.id ?? null)
  }, [session?.id, session?.modelId, session?.remote, session?.pending, model, models, status, busy, chat.setModel])
  useEffect(() => {
    // 选择器不提供「默认」项：未选择或旧选择失效时把模型声明的默认档落进会话记录，提交与展示同一来源。
    if (!model || chat.loading || chat.sending || session?.pending) return
    if ((session?.reasoningLevel ?? '') !== reasoningLevel) chat.setReasoningLevel(reasoningLevel || null)
  }, [model, reasoningLevel, session?.reasoningLevel, session?.pending, chat.loading, chat.sending, chat.setReasoningLevel])

  useEffect(() => {
    if (!session?.remote || chat.loading || chat.sending || !api.available) return
    return subscribeWhileVisible(() => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const poll = async () => {
        await chat.refresh(api, controller.signal)
        const latest = useAgentChatStore.getState()
        if (!controller.signal.aborted && (isChatRunActive(latest.run) || latest.remoteSession?.activeRunId || latest.remoteSession?.activeWorkflowId || latest.session?.pending)) {
          timer = setTimeout(() => { void poll() }, 1500)
        }
      }
      void poll()
      return () => { controller.abort(); clearTimeout(timer) }
    })
  }, [api, session?.id, session?.remote?.sessionId, chat.loading, chat.sending, chat.refresh])

  const liveRunId = isChatRunActive(chat.run) ? chat.run!.id : undefined
  const streamingRunId = waitingInput || chat.run?.status === 'waiting-approval' ? undefined : liveRunId
  const waitingForMessage = chat.sending || (!!liveRunId && !finalizing && !chat.messages.some(message => message.role === 'user' && message.runId === liveRunId))
  useEffect(() => {
    if (!streamingRunId || !api.available) return
    return subscribeWhileVisible(() => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const connect = async () => {
        await chat.watchOutput(api, streamingRunId, controller.signal)
        if (!controller.signal.aborted) timer = setTimeout(() => { void connect() }, 1000)
      }
      void connect()
      return () => { controller.abort(); clearTimeout(timer) }
    })
  }, [api, streamingRunId, chat.watchOutput])
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

  const canSubmit = Boolean(api.available && (model || session?.pending) && !busy && !chat.uploadingAttachments && !chat.loading && !restoring && (status === 'ready' || session?.pending))
  const canSend = Boolean(canSubmit && !session?.editing && !session?.pending?.input.replaceMessageId && session?.draft.trim())
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
  const title = chat.remoteSession?.title || chat.messages[0]?.content || '新会话'
  const run = chat.run

  const closeList = () => {
    restoreListFocus.current = !shell.conversationDrawerOpen
    setListCollapsed(true)
    shell.closeConversationDrawer()
  }
  const newConversation = () => {
    if (chat.sending) return
    setNavigationReady(null)
    void chat.newSession().then(() => {
      const next = new URLSearchParams(params); next.delete('session')
      setParams(next, { state: { ...routeState, agentDraftId: useAgentChatStore.getState().session?.id } })
      shell.closeConversationDrawer(); input.current?.focus()
    }).catch(cause => chat.reportOperation(`新建会话失败：${cause instanceof Error ? cause.message : '请重试。'}`))
  }
  const selectConversation = (key: string) => {
    if (chat.sending) return
    setNavigationReady(null)
    if (chat.localSessions.some(row => row.id === key && !row.remote)) {
      void chat.selectSession(api, key).then(() => {
        const next = new URLSearchParams(params); next.delete('session')
        setParams(next, { state: { ...routeState, agentDraftId: key } })
      })
    } else { const next = new URLSearchParams(params); next.set('session', key); setParams(next) }
    shell.closeConversationDrawer()
  }
  const refreshList = () => { setListRefreshing(true); void chat.loadSessions(api, false, false, true).finally(() => setListRefreshing(false)) }
  const list = <ChatSessionList onSelect={selectConversation} onNew={newConversation}
    onRefresh={refreshList} onMore={() => { void chat.loadSessions(api, true, false, true) }} refreshing={listRefreshing}
    onClose={closeList} />
  // 会话栏与主导航互不联动：宽屏默认展开、两栏可同开，开关不写主导航收展，主导航收展也不影响本栏。
  const showSidebar = wide && !listCollapsed
  const expanded = showSidebar || shell.conversationDrawerOpen
  const toggle = <SessionToggle expanded={expanded} buttonRef={listTrigger}
    controls={wide ? 'chat-session-sidebar' : 'chat-session-drawer'} onClick={() => {
      if (expanded) closeList()
      else if (wide) setListCollapsed(false)
      else shell.openConversationDrawer()
    }} />

  return <div className="agent-workspace">
    {wide && <aside id="chat-session-sidebar" aria-label="会话列表"
      className="chat-session-sidebar" data-open={showSidebar || undefined}
      aria-hidden={!showSidebar || undefined} inert={!showSidebar}>{list}</aside>}
    <Dialog.Root open={shell.conversationDrawerOpen} onOpenChange={shell.setConversationDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
        <Dialog.Content ref={listDrawer} id="chat-session-drawer" aria-describedby={undefined} className="chat-session-drawer panel-surface fixed inset-y-0 left-0 z-50 flex flex-col rounded-none shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-drawer-panel-in data-[state=closed]:animate-drawer-panel-out"
          onOpenAutoFocus={event => { event.preventDefault(); listDrawer.current?.focus() }}
          onCloseAutoFocus={event => { event.preventDefault(); if (!shell.navigationOpen) focusListTrigger() }}>
          <Dialog.Title className="sr-only">会话列表</Dialog.Title>{list}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <section aria-label="Ely 会话" className="agent-chat">

    <header className="chat-header">
      {toggle}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="chat-title max-w-64 truncate text-sm font-medium" title={title}>{title}</span>
      </div>
      <button type="button" className="chat-new" disabled={chat.sending} onClick={newConversation}><Plus size={14} aria-hidden /><span>新会话</span></button>
    </header>

    <div ref={history} className="chat-history hover-scrollbar" onScroll={event => {
      const element = event.currentTarget
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    }}>
      {!chat.messages.length && !chat.outgoingMessage && !waitingForMessage ? <div className="chat-empty">
        <Bot size={38} className="mb-5 text-fg-muted" aria-hidden />
        <h2 className="text-2xl font-medium tracking-tight sm:text-[28px]">今天想聊什么？</h2>
        <p className="mt-3 text-sm text-fg-muted">选择模型，向 Ely 发送第一条消息。</p>
        {!!session?.messages.length && <p className="mt-3 text-xs text-fg-muted">本地预览消息未发送给模型。</p>}
      </div> : <div className="chat-messages" role="log" aria-label="会话消息">
        {chat.messages.filter(message => message.role === 'user').map((message, index, users) => {
          const answer = chat.messages.find(item => item.runId === message.runId && item.role === 'assistant' && item.origin === 'runtime') ?? chat.messages.find(item => item.runId === message.runId && item.role === 'assistant')
          const active = liveRunId === message.runId
          const stopped = (chat.run?.id === message.runId ? chat.run.status : message.runStatus) === 'cancelled' && !chat.timelines[message.runId]?.terminalResult && answer?.origin !== 'runtime'
          const editing = session?.editing?.messageId === message.id
          const live = (active || stopped) && chat.liveOutput?.runId === message.runId ? chat.liveOutput : null
          const switchText = chatSwitchNotice(users[index - 1], message)
          return <Fragment key={message.id}>
            {switchText && <ChatSwitchNotice text={switchText} />}
            <article className="chat-message" aria-label="你的消息">
              {editing ? <form className="chat-message-editor panel-surface" aria-label="编辑最后一条消息" onSubmit={event => { event.preventDefault(); resend() }} onDragOver={dragFiles} onDrop={event => dropFiles(event, true)}
                onKeyDown={event => {
                  if (event.key === 'Escape' && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
                    event.preventDefault()
                    event.stopPropagation()
                    chat.cancelEdit()
                  }
                }}>
                <label htmlFor="agent-edit-message" className="sr-only">编辑消息内容</label>
                <textarea id="agent-edit-message" ref={editInput} value={session.editing!.text} rows={4} className="chat-textarea hover-scrollbar"
                  disabled={chat.sending || !!session.pending} onChange={event => chat.setEditText(event.target.value)}
                  onPaste={event => pasteFiles(event, true)}
                  onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); resend() }
                  }} />
                {!!session.editing!.attachments?.length && (() => {
                  const editing = session.editing!
                  const original = chat.messages.find(message => message.id === editing.messageId)
                  return <ul aria-label="随重发发送的图片" className="flex flex-wrap gap-2 px-1 pt-2">
                    <li className="w-full text-xs text-fg-muted">图片将随重发一并发送</li>
                    {editing.attachments!.map(ref => <li key={ref.id} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-xs text-fg-muted">
                      <ImageIcon size={14} aria-hidden /><span className="max-w-40 truncate">{original?.attachments?.find(attachment => attachment.id === ref.id)?.name ?? '图片'}</span>
                    </li>)}
                  </ul>
                })()}
                <div className="chat-edit-actions">
                  <IconButton label="取消编辑" disabled={chat.sending || !!session.pending} onPress={chat.cancelEdit}><X size={18} aria-hidden /></IconButton>
                  <IconButton label={session.pending ? '重试发送' : '发送'} disabled={!canResend} onPress={resend}><Send size={18} aria-hidden /></IconButton>
                </div>
              </form> : <>
                <div className="chat-message-body">
                  <p className="chat-message-text">{message.content}</p>
                  {!!message.attachments?.length && <ChatMessageAttachments attachments={message.attachments} fetchBlob={api.attachmentBlob} />}
                </div>
                <ChatMessageCopy value={message.content} noun="这条消息" />
                {lastUserMessage?.id === message.id && <IconButton
                  label={message.attachments?.length && !model?.supportsImage ? '当前模型不支持图片输入，暂不能编辑带图消息' : '编辑这条消息'}
                  variant="ghost" tooltipSide="bottom" className="chat-copy chat-edit"
                  disabled={busy || restoring || !!session?.pending || (!!message.attachments?.length && !model?.supportsImage)}
                  onPress={() => chat.editMessage(message.id)}><Pencil size={13} aria-hidden /></IconButton>}
              </>}
            </article>
            {(chat.timelines[message.runId]?.entries.length || chat.timelines[message.runId]?.done || chat.timelines[message.runId]?.plan) ? <ChatTimeline key={message.runId} timeline={chat.timelines[message.runId]!} answer={answer} showPlan={message.runId !== session?.remote?.runId}
              active={active && !finalizing && !waitingInput} stopped={stopped} stopping={active && stopping} api={api} onProgress={followContent} />
              : answer?.origin === 'runtime' && !stopped ? <ChatRuntimeResult key={message.runId} content={answer.content} /> : <ChatResponse key={message.runId} content={(chat.timelines[message.runId] || chat.syncError ? answer?.content : undefined) ?? live?.content ?? ''} reasoning={chat.reasoning[message.runId] ?? ''}
                active={active && !finalizing} stopped={stopped} stopping={active && stopping} copyable={!!answer} quarantined={answer?.quarantined} onProgress={followContent} />}
            {!!answer?.wikiSources?.length && <ChatMemorySources sources={answer.wikiSources} api={agentMemory} />}
          </Fragment>
        })}
        {chat.outgoingMessage && <article className="chat-message" aria-label="你的消息">
          <div className="chat-message-body">
            <p className="chat-message-text">{chat.outgoingMessage.content}</p>
            {!!chat.outgoingMessage.attachments.length && <ChatMessageAttachments attachments={chat.outgoingMessage.attachments} fetchBlob={api.attachmentBlob} />}
            <p role="status" className="mt-1 text-right text-xs text-fg-muted">{chat.outgoingMessage.runId ? '已发送' : chat.sending ? '正在发送…' : '发送结果待确认'}</p>
          </div>
        </article>}
        {waitingForMessage && <ChatResponse content="" reasoning="" active onProgress={followContent} />}
      </div>}
    </div>

    <div className="chat-compose-area">
      {chat.inputError && <p role="alert" className="mb-3 text-xs text-danger">{chat.inputError}</p>}
      {inputHints.length > 0 && <div role="status" className="mb-3 space-y-1 text-xs text-fg-muted">{[...new Set(inputHints)].map(hint => <p key={hint}>{hint}</p>)}</div>}
      {stopping && <p role="status" className="mb-3 text-xs text-fg-muted">正在停止…</p>}
      {chat.uploadingAttachments && <p role="status" className="mb-3 flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />正在处理文件…</p>}
      {readError && <div className="mb-3 flex items-start justify-between gap-3 text-xs text-danger">
        <p role="alert">{readError}</p>
        <RefreshButton label={retryReadLabel} busy={chat.refreshing || status === 'loading'} onPress={retryReads} />
      </div>}
      {modelUnavailable && <div className="mb-3 text-right text-xs text-fg-muted"><Link className="underline underline-offset-4 hover:text-fg" to="/settings?tab=models">前往设置添加模型</Link></div>}

      <ChatPlan key={`${session?.id}:${session?.remote?.runId}`} plan={usageTimeline?.plan ?? (run?.id === session?.remote?.runId ? run?.plan : undefined)}
        status={usageTimeline?.status ?? run?.status ?? 'queued'} stopping={stopping} onProgress={followContent} />
      {run && (run.status === 'waiting-approval' || run.phase === 'preparing-runtime') ? <ChatApprovals key={run.id} api={api.governance} runId={run.id} onChanged={() => void chat.refresh(api)} onCancel={() => void chat.stop(api)} /> : inputRequest ? <ChatUserInput key={`${session?.id}:${inputRequest.id}`} request={inputRequest} answers={inputDraft?.answers ?? {}}
        submitting={chat.sending || stopping} pending={!!inputDraft?.pending}
        onAnswer={(questionId, answer) => chat.setUserInputAnswer(inputRequest, questionId, answer)}
        onSubmit={() => void chat.answerUserInput(api, inputRequest)} onCancel={() => void chat.stop(api)} /> :
      <form className="chat-composer panel-surface" onSubmit={event => { event.preventDefault(); send() }} aria-label="消息输入框" onDragOver={dragFiles} onDrop={event => dropFiles(event)}>
        {!!session?.attachments.length && <ul aria-label="本地附件" className="hover-scrollbar flex max-h-52 flex-wrap gap-2 overflow-y-auto px-4 pt-4">{session.attachments.map(attachment => <ChatAttachment key={attachment.id} attachment={attachment} onRemove={() => chat.removeAttachment(attachment.id)} />)}</ul>}
        <label htmlFor="agent-message" className="sr-only">发送给 Ely 的消息</label>
        <textarea
          id="agent-message" ref={input} value={session?.draft ?? ''} rows={2}
          placeholder={restoring ? '正在读取会话…' : '向 Ely 发送消息…'} className="chat-textarea hover-scrollbar"
          disabled={!session || chat.loading || chat.sending || !!session.pending}
          onChange={event => chat.setDraft(event.target.value)}
          onPaste={event => pasteFiles(event)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); send() } }}
        />
        <input ref={fileInput} type="file" multiple hidden aria-label="选择文件" accept={AGENT_COMPOSER_FILE_ACCEPT} disabled={attachmentsLocked} onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length) addFiles(files)
        }} />
        <div className="chat-composer-tools">
          <IconButton label="添加文件" tooltipSide="top" variant="ghost" onPress={() => fileInput.current?.click()} disabled={attachmentsLocked || !api.available} className="chat-add-file"><Paperclip size={20} aria-hidden /></IconButton>
          <div className="chat-permission" data-mode={permissionMode.value} title={`${permissionMode.label}：${permissionMode.description}`}>
            <SelectDropdown ariaLabel="权限模式" value={permissionMode.value} onSelect={chat.setPermissionMode}
              items={PERMISSION_MODES.map(({ Icon, ...mode }) => ({ ...mode, icon: <Icon size={16} /> }))}
              leadingIcon={<PermissionIcon size={16} aria-hidden />}
              disabled={!session || chat.loading || busy || restoring || !!session.pending}
              triggerClassName="chat-select chat-permission-select" contentClassName="chat-composer-menu chat-permission-menu" />
          </div>
          <div className="chat-model">
            <ChatUsageIndicator key={session?.id} timeline={usageTimeline} />
            <SelectDropdown ariaLabel="选择模型" value={model?.id} onSelect={chat.setModel}
              items={modelOptions}
              fallbackLabel={status === 'loading' ? '加载模型…' : status === 'error' ? '模型不可用' : '选择模型'}
              disabled={status !== 'ready' || !models.length || preferencesLocked || restoring || !!session?.pending} triggerClassName="chat-select chat-model-select" contentClassName="chat-composer-menu"
              mono
              search={models.length > 6 ? { ariaLabel: '搜索模型', placeholder: '搜索模型 ID…' } : undefined} />
          </div>
          {reasoningLevels.length > 0 && <div className="chat-reasoning">
            <SelectDropdown ariaLabel="选择思考等级" value={reasoningLevel}
              items={reasoningLevels.map(level => ({ value: level, label: reasoningLabel(level) }))}
              onSelect={value => chat.setReasoningLevel(value)} fallbackLabel="思考等级"
              leadingIcon={<Brain size={16} aria-hidden />} align="end"
              disabled={status !== 'ready' || !model || preferencesLocked || restoring || !!session?.pending}
              triggerClassName="chat-select chat-reasoning-select" contentClassName="chat-composer-menu" />
          </div>}
          {chat.sending || (finalizing && !stopping)
            ? <IconButton label={chat.sending ? '正在发送消息' : '正在保存回复'} disabled busy className="chat-send chat-pending"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /></IconButton>
            : liveRunId && !chat.remoteSession?.activeWorkflowId
            ? <IconButton label={stopping ? '正在停止' : '停止回复'} onPress={() => void chat.stop(api)} disabled={stopping} className="chat-send chat-stop"><Square size={16} fill="currentColor" aria-hidden /></IconButton>
            : <IconButton label={session?.pending && !session.pending.input.replaceMessageId ? '重试发送' : '发送消息'} onPress={send} disabled={!canSend} className="chat-send"><Send size={20} aria-hidden /></IconButton>}
        </div>
      </form>}
    </div>
    </section>
  </div>
}

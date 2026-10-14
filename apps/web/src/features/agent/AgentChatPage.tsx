import { Fragment, useCallback, useEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useShellLayout } from '../../app/layout/ShellLayoutContext'
import { ChatSessionList } from './ChatSessionList'
import { RUNTIME_RUN_STATUS_LABELS } from '@elysian/contracts'
import { Bot, Brain, Hand, List, Paperclip, Plus, Send, ShieldAlert, ShieldCheck, X, type IconComponent } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { SelectDropdown } from '../../components/SelectDropdown'
import { RefreshButton } from '../../components/RefreshState'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import type { AgentChatPermissionMode } from '../../contracts/agentChat'
import { isChatRunActive, useAgentChatStore } from '../../stores/agentChatStore'
import { ChatAttachment } from './ChatAttachment'
import { ChatResponse } from './ChatResponse'
import { defaultReasoningLevel, reasoningLabel, useChatModels } from './useChatModels'
import './agentChat.css'

const PERMISSION_MODES: readonly { value: AgentChatPermissionMode; label: string; description: string; Icon: IconComponent }[] = [
  { value: 'ask', label: '请求批准', description: '需要批准的操作，按服务端规则请求确认。', Icon: Hand },
  { value: 'assist', label: '帮我批准', description: '自动判断审批暂未接入，目前仅保存选择。', Icon: ShieldCheck },
  { value: 'full', label: '完全开放', description: '免逐项审批暂未接入，目前仅保存选择。', Icon: ShieldAlert },
]

/**
 * 会话列表开关：固定在聊天页头内，不再随侧边栏状态左右移动。
 * 焦点由代码归还时压掉提示：Radix 的提示只在失焦或指针离开触发器时收起，
 * 而程序化聚焦时指针往往不在把手上，提示因此会留在画面上无人关闭。
 */
function SessionToggle({ expanded, controls, onClick, buttonRef, focusReturnsByCode }: {
  expanded: boolean
  controls: string
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
  focusReturnsByCode?: RefObject<boolean>
}) {
  const label = expanded ? '收起会话列表' : '打开会话列表'
  return <Tooltip.Root>
    <Tooltip.Trigger asChild onFocus={event => { if (focusReturnsByCode?.current) event.preventDefault() }}>
      <button ref={buttonRef} type="button" className="chat-session-toggle" aria-label={label}
        aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
        <List size={16} aria-hidden />
      </button>
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content side="bottom" sideOffset={6}
      className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">
      {label}<Tooltip.Arrow className="fill-surface-raised" />
    </Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>
}

/** 基本文本聊天，沿用现有会话、模型目录与任务续轮接口。 */
export function AgentChatPage() {
  const chat = useAgentChatStore()
  const shell = useShellLayout()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [navigationReady, setNavigationReady] = useState<string | null>(null)
  const [listCollapsed, setListCollapsed] = useState(false)
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 1100px)').matches ?? false)
  const [listRefreshing, setListRefreshing] = useState(false)
  const requestedId = params.get('session') || undefined
  const routeState = location.state && typeof location.state === 'object' ? location.state : {}
  const requestedDraft = typeof routeState.agentDraftId === 'string' ? routeState.agentDraftId : undefined
  const listTrigger = useRef<HTMLButtonElement>(null)
  const listDrawer = useRef<HTMLDivElement>(null)
  const restoreListFocus = useRef(false)
  const returnListFocusByCode = useRef(false)
  const { agentConversation: api } = useGateway()
  const { models, status, error, reload } = useChatModels()
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const composing = useRef(false)
  const session = chat.session
  const permissionMode = PERMISSION_MODES.find(mode => mode.value === session?.permissionMode) ?? PERMISSION_MODES[0]!
  const PermissionIcon = permissionMode.Icon
  const model = models.find(item => item.id === session?.modelId)
  /** 模型标识与设置页的「模型 ID」列同一口径；服务名放副行，不占触发器宽度。 */
  const modelOptions = models.map(item => ({
    value: item.id,
    label: models.some(other => other.id !== item.id && other.model === item.model) ? `${item.model} · ${item.serviceName}` : item.model,
    description: item.serviceName,
  }))
  const busy = chat.sending || isChatRunActive(chat.run) || !!chat.remoteSession?.activeRunId || !!chat.remoteSession?.activeWorkflowId
  /** 思考等级只提供模型声明的档位：未选择或与当前模型不符时，取模型声明的默认档（优先「高」）。 */
  const reasoningLevels = model?.reasoningLevels ?? []
  const reasoningLevel = session?.reasoningLevel && reasoningLevels.includes(session.reasoningLevel) ? session.reasoningLevel : defaultReasoningLevel(reasoningLevels) ?? ''
  const restoring = !!session?.remote && !chat.remoteSession
  const attachmentsLocked = !session || chat.loading || busy || restoring || !!session.pending
  const readError = chat.syncError && error && chat.syncError !== error
    ? `会话：${chat.syncError}\n模型：${error}`
    : chat.syncError || error
  const retryReadLabel = chat.syncError && error ? '重新读取会话和模型' : chat.syncError ? '重新读取会话' : '重新读取模型'
  const retryReads = () => {
    if (chat.syncError) void chat.refresh(api)
    if (error) reload()
  }

  const focusListTrigger = () => {
    const trigger = listTrigger.current
    if (!trigger) return
    returnListFocusByCode.current = true
    trigger.focus()
    returnListFocusByCode.current = false
  }

  useEffect(() => {
    let active = true
    setNavigationReady(null)
    const restore = async () => {
      await chat.initialize(api, requestedId ?? requestedDraft)
      if (active) setNavigationReady(location.key)
    }
    void restore()
    return () => { active = false }
  }, [api, location.key, requestedId, requestedDraft, chat.initialize])
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
    const media = window.matchMedia?.('(min-width: 1100px)')
    if (!media) return
    const update = () => setWide(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
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
  useEffect(() => {
    if (!liveRunId || !api.available) return
    return subscribeWhileVisible(() => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const connect = async () => {
        await chat.watchOutput(api, liveRunId, controller.signal)
        if (!controller.signal.aborted) timer = setTimeout(() => { void connect() }, 1000)
      }
      void connect()
      return () => { controller.abort(); clearTimeout(timer) }
    })
  }, [api, liveRunId, chat.watchOutput])
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
  useEffect(() => {
    if (following.current && history.current) history.current.scrollTop = history.current.scrollHeight
  }, [chat.messages.length, chat.reasoning[chat.run?.id ?? ''], session?.id])

  const canSend = Boolean(api.available && session?.draft.trim() && (model || session.pending) && !session.attachments.length && !busy && !chat.loading && !restoring && (status === 'ready' || session.pending))
  const send = () => {
    if (!canSend) return
    following.current = true
    void chat.send(api, model?.profile).then(sent => { if (sent) input.current?.focus() })
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
    })
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
  const refreshList = () => { setListRefreshing(true); void chat.loadSessions(api).finally(() => setListRefreshing(false)) }
  const list = <ChatSessionList onSelect={selectConversation} onNew={newConversation}
    onRefresh={refreshList} onMore={() => { void chat.loadSessions(api, true) }} refreshing={listRefreshing}
    onClose={closeList} />
  const showSidebar = wide && shell.sidebarCollapsed && !listCollapsed
  const expanded = showSidebar || shell.conversationDrawerOpen
  const toggle = <SessionToggle expanded={expanded} buttonRef={listTrigger}
    focusReturnsByCode={returnListFocusByCode}
    controls={wide ? 'chat-session-sidebar' : 'chat-session-drawer'} onClick={() => {
      if (expanded) closeList()
      else if (wide) { shell.setSidebarCollapsed(true); setListCollapsed(false) }
      else shell.openConversationDrawer()
    }} />

  return <div className="agent-workspace" data-navigation-expanded={!shell.sidebarCollapsed || undefined}>
    {wide && <aside id="chat-session-sidebar" aria-label="会话列表"
      className="chat-session-sidebar" data-open={showSidebar || undefined}
      aria-hidden={!showSidebar || undefined}>{list}</aside>}
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
      {!chat.messages.length ? <div className="chat-empty">
        <Bot size={38} className="mb-5 text-fg-muted" aria-hidden />
        <h2 className="text-2xl font-medium tracking-tight sm:text-[28px]">今天想聊什么？</h2>
        <p className="mt-3 text-sm text-fg-muted">选择模型，向 Ely 发送第一条消息。</p>
        {!!session?.messages.length && <p className="mt-3 text-xs text-fg-muted">本地预览消息未发送给模型。</p>}
      </div> : <div className="chat-messages" role="log" aria-label="会话消息">
        {chat.messages.filter(message => message.role === 'user').map(message => {
          const answer = chat.messages.find(item => item.runId === message.runId && item.role === 'assistant')
          const active = liveRunId === message.runId
          const live = active && chat.liveOutput?.runId === message.runId ? chat.liveOutput : null
          return <Fragment key={message.id}>
            <article className="chat-message" aria-label="你的消息">
              <div className="chat-message-body"><p className="chat-message-text">{message.content}</p></div>
            </article>
            <ChatResponse content={answer?.content ?? live?.content ?? ''} reasoning={chat.reasoning[message.runId] ?? ''}
              active={active} quarantined={answer?.quarantined} onProgress={followContent} />
          </Fragment>
        })}
      </div>}
    </div>

    <div className="chat-compose-area">
      {run && !isChatRunActive(run) && run.status !== 'succeeded' && <p role="alert" className="mb-3 text-xs text-danger">{RUNTIME_RUN_STATUS_LABELS[run.status]}{run.error ? `：${run.error.message}` : ''}</p>}
      {chat.notice && <div role="status" className="mb-3 flex items-start gap-2 text-xs text-fg-muted"><span className="min-w-0 flex-1">{chat.notice}</span><button type="button" aria-label="关闭提示" onClick={chat.clearNotice}><X size={14} aria-hidden /></button></div>}
      {chat.error && <p role="alert" className="mb-3 text-xs text-danger">{chat.error}</p>}
      {readError && <div role="alert" className="mb-3 flex items-center gap-2 text-xs text-danger">
        <span className="min-w-0 flex-1 whitespace-pre-line break-words">{readError}</span>
        <RefreshButton label={retryReadLabel} busy={chat.refreshing || status === 'loading'} onPress={retryReads} />
      </div>}
      {!api.available && <p className="mb-3 text-xs text-fg-muted">当前为本地演示，请在已连接后端的面板中使用聊天。</p>}
      {status === 'ready' && (!models.length || (session?.remote && !model)) && <p className="mb-3 text-xs text-fg-muted">请选择支持文本与工具调用的可用模型，或<Link className="underline underline-offset-4 hover:text-fg" to="/settings?tab=models">前往设置添加模型</Link>。</p>}
      {!!session?.attachments.length && <p className="mb-3 text-xs text-fg-muted">附件仅保存在本地，暂未接入模型；请移除附件后发送文本。</p>}

      <form className="chat-composer panel-surface" onSubmit={event => { event.preventDefault(); send() }} aria-label="消息输入框">
        {!!session?.attachments.length && <ul aria-label="本地附件" className="flex flex-wrap gap-2 px-4 pt-4">{session.attachments.map(attachment => <ChatAttachment key={attachment.id} attachment={attachment} onRemove={() => chat.removeAttachment(attachment.id)} />)}</ul>}
        <label htmlFor="agent-message" className="sr-only">发送给 Ely 的消息</label>
        <textarea
          id="agent-message" ref={input} value={session?.draft ?? ''} rows={2}
          placeholder={restoring ? '正在读取会话…' : '向 Ely 发送消息…'} className="chat-textarea hover-scrollbar"
          disabled={!session || chat.loading || chat.sending || !!session.pending}
          onChange={event => chat.setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); send() } }}
        />
        <input ref={fileInput} type="file" multiple hidden aria-label="选择附件" disabled={attachmentsLocked} onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (!attachmentsLocked) void chat.addAttachments(files)
        }} />
        <div className="chat-composer-tools">
          <IconButton label="添加附件" variant="ghost" onPress={() => fileInput.current?.click()} disabled={attachmentsLocked} className="chat-add-file"><Paperclip size={20} aria-hidden /></IconButton>
          <div className="chat-permission" data-mode={permissionMode.value} title={`${permissionMode.label}：${permissionMode.description}`}>
            <SelectDropdown ariaLabel="权限模式" value={permissionMode.value} onSelect={chat.setPermissionMode}
              items={PERMISSION_MODES.map(({ Icon, ...mode }) => ({ ...mode, icon: <Icon size={16} /> }))}
              leadingIcon={<PermissionIcon size={16} aria-hidden />}
              disabled={!session || chat.loading || busy || restoring || !!session.pending}
              triggerClassName="chat-select chat-permission-select" contentClassName="chat-composer-menu chat-permission-menu" />
            {permissionMode.value !== 'ask' && <span className="text-[10px] text-fg-muted">预览</span>}
          </div>
          <div className="chat-model">
            <SelectDropdown ariaLabel="选择模型" value={model?.id} onSelect={chat.setModel}
              items={modelOptions}
              fallbackLabel={status === 'loading' ? '加载模型…' : status === 'error' ? '模型不可用' : '选择模型'}
              disabled={status !== 'ready' || !models.length || busy || restoring || !!session?.pending} triggerClassName="chat-select chat-model-select" contentClassName="chat-composer-menu"
              mono
              search={models.length > 6 ? { ariaLabel: '搜索模型', placeholder: '搜索模型 ID…' } : undefined} />
          </div>
          {reasoningLevels.length > 0 && <div className="chat-reasoning">
            <SelectDropdown ariaLabel="选择思考等级" value={reasoningLevel}
              items={reasoningLevels.map(level => ({ value: level, label: reasoningLabel(level) }))}
              onSelect={value => chat.setReasoningLevel(value)} fallbackLabel="思考等级"
              leadingIcon={<Brain size={16} aria-hidden />} align="end"
              disabled={status !== 'ready' || !model || busy || restoring || !!session?.pending}
              triggerClassName="chat-select chat-reasoning-select" contentClassName="chat-composer-menu" />
          </div>}
          <IconButton label={session?.pending ? '重试发送' : '发送消息'} onPress={send} disabled={!canSend} className="chat-send"><Send size={20} aria-hidden /></IconButton>
        </div>
      </form>
    </div>
    </section>
  </div>
}

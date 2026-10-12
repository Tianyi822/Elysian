import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Bot, Brain, Hand, Paperclip, Plus, Send, ShieldAlert, ShieldCheck, Upload, X, type IconComponent } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { SelectDropdown } from '../../components/SelectDropdown'
import { RefreshButton } from '../../components/RefreshState'
import type { AgentChatPermissionMode } from '../../contracts/agentChat'
import { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatAttachment } from './ChatAttachment'
import { defaultReasoningLevel, reasoningLabel, useChatModels } from './useChatModels'
import './agentChat.css'

const PERMISSION_MODES: readonly { value: AgentChatPermissionMode; label: string; description: string; Icon: IconComponent }[] = [
  { value: 'ask', label: '请求批准', description: '需要批准的操作，先向你确认。', Icon: Hand },
  { value: 'assist', label: '帮我批准', description: '智能体协助判断，必要时向你确认。', Icon: ShieldCheck },
  { value: 'full', label: '完全开放', description: '自主处理任务，不逐项请求批准。', Icon: ShieldAlert },
]

/** 本地会话原型：模型目录沿用真实配置，消息与权限选项不派发执行。 */
export function AgentChatPage() {
  const chat = useAgentChatStore()
  const { models, status, error, reload } = useChatModels()
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const composing = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState(0)
  const [fileError, setFileError] = useState<string | null>(null)
  const session = chat.session
  const permissionMode = PERMISSION_MODES.find(mode => mode.value === session?.permissionMode) ?? PERMISSION_MODES[0]!
  const PermissionIcon = permissionMode.Icon
  const attaching = pendingAttachments > 0
  const model = models.find(item => item.id === session?.modelId)
  const levels = model?.reasoningLevels ?? []

  useEffect(() => { void chat.ensureSession() }, [chat.ensureSession])
  useEffect(() => {
    if (!session || status !== 'ready') return
    if (!model) {
      const nextId = models[0]?.id ?? null
      if (session.modelId !== nextId) chat.setModel(nextId)
      return
    }
    if (!session.reasoningLevel || !levels.includes(session.reasoningLevel)) {
      const next = defaultReasoningLevel(levels) ?? null
      if (next !== session.reasoningLevel) chat.setReasoningLevel(next)
    }
  }, [session?.id, session?.modelId, session?.reasoningLevel, model, models, status, chat.setModel, chat.setReasoningLevel])

  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [session?.draft])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [session?.messages.length])

  const addFiles = async (files: readonly File[]) => {
    if (!files.length) return
    setFileError(null)
    setPendingAttachments(count => count + 1)
    try { await chat.addAttachments(files) }
    catch { setFileError('文件添加失败，请重新选择。') }
    finally { setPendingAttachments(count => count - 1) }
  }
  const send = () => {
    if (attaching || chat.loading) return
    if (chat.send()) input.current?.focus()
  }
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const canSend = Boolean(session && (session.draft.trim() || session.attachments.length) && !attaching && !chat.loading && session.attachments.every(file => file.available))
  const title = session?.messages[0]?.text || (session?.messages.length ? '附件会话' : '新会话')

  return <section
    aria-label="Ely 会话"
    className="agent-chat"
    onDragEnter={event => { if (isFileDrag(event)) { event.preventDefault(); dragDepth.current += 1; setDragging(true) } }}
    onDragOver={event => { if (isFileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
    onDragLeave={event => { if (isFileDrag(event)) { dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false) } }}
    onDrop={event => { if (isFileDrag(event)) { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addFiles(Array.from(event.dataTransfer.files)) } }}
  >
    <header className="chat-header">
      <div className="flex min-w-0 items-center gap-3">
        <span className="max-w-64 truncate text-sm font-medium" title={title}>{title}</span>
        <span className="shrink-0 rounded-md border border-panel-line px-1.5 py-0.5 text-[10px] text-fg-muted">界面预览</span>
      </div>
      <button type="button" className="chat-new" onClick={() => { void chat.newSession(); setFileError(null); input.current?.focus() }}><Plus size={14} aria-hidden /><span>新会话</span></button>
    </header>

    <div className="chat-history hover-scrollbar">
      {!session?.messages.length ? <div className="chat-empty">
        <Bot size={38} className="mb-5 text-fg-muted" aria-hidden />
        <h2 className="text-2xl font-medium tracking-tight sm:text-[28px]">今天想处理什么？</h2>
        <p className="mt-3 text-sm text-fg-muted">告诉 Ely 你的目标，或添加相关文件。</p>
      </div> : <div className="chat-messages" role="log" aria-label="会话消息">
        {session.messages.map(message => <article key={message.id} className="chat-message" aria-label="你的消息">
          <div className="chat-message-body">
            {message.attachments.length > 0 && <ul aria-label="消息附件" className="flex flex-wrap justify-end gap-2">{message.attachments.map(attachment => <ChatAttachment key={attachment.id} attachment={attachment} />)}</ul>}
            {message.text && <p className="chat-message-text">{message.text}</p>}
            <p className="mt-2 text-right text-[11px] text-fg-muted">已保存在本地</p>
          </div>
        </article>)}
        <div className="flex items-start gap-3 py-5 text-sm text-fg-muted" role="status">
          <Bot size={20} className="mt-0.5 shrink-0" aria-hidden />
          <p className="leading-6">消息已留在当前会话。接入智能体后，Ely 将在这里回复。</p>
        </div>
        <div ref={bottom} />
      </div>}
    </div>

    <div className="chat-compose-area">
      {(fileError || chat.notice) && <div role="status" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
        <span>{fileError || chat.notice}</span><IconButton label="关闭提示" variant="ghost" onPress={() => { setFileError(null); chat.clearNotice() }}><X size={13} aria-hidden /></IconButton>
      </div>}
      {error && <div role="alert" className="mb-3 flex items-center gap-2 text-xs text-danger"><span className="min-w-0 flex-1">{error}</span><RefreshButton label="重新读取模型" busy={status === 'loading'} onPress={reload} /></div>}
      {status === 'ready' && !models.length && <p className="mb-3 text-xs text-fg-muted">暂无可用模型，<Link className="underline underline-offset-4 hover:text-fg" to="/settings?tab=models">前往设置添加模型</Link>。你仍可体验本地消息发送。</p>}

      <form className="chat-composer panel-surface" onSubmit={event => { event.preventDefault(); send() }} aria-label="消息输入框">
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="添加会话附件" onChange={event => { void addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
        {session && session.attachments.length > 0 && <ul aria-label="待发送附件" className="flex max-h-44 flex-wrap gap-2 overflow-y-auto px-4 pt-4">{session.attachments.map(attachment => <ChatAttachment key={attachment.id} attachment={attachment} onRemove={() => chat.removeAttachment(attachment.id)} />)}</ul>}
        <label htmlFor="agent-message" className="sr-only">发送给 Ely 的消息</label>
        <textarea
          id="agent-message" ref={input} value={session?.draft ?? ''} rows={2}
          placeholder={chat.loading ? '正在恢复会话…' : '向 Ely 发送消息，描述你想完成的任务…'}
          className="chat-textarea hover-scrollbar" disabled={!session || chat.loading}
          onChange={event => chat.setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); send() } }}
          onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files) } }}
        />
        <div className="chat-composer-tools">
          <IconButton label="添加文件或图片" variant="ghost" onPress={() => fileInput.current?.click()} disabled={attaching || chat.loading} className="chat-add-file"><Paperclip size={20} aria-hidden /></IconButton>
          <div className="chat-permission" title={`${permissionMode.description}（当前仅预览）`}>
            <SelectDropdown ariaLabel="权限模式" items={PERMISSION_MODES.map(({ Icon, ...mode }) => ({ ...mode, icon: <Icon size={16} /> }))} value={permissionMode.value} onSelect={chat.setPermissionMode}
              leadingIcon={<PermissionIcon size={16} className="shrink-0" aria-hidden />} triggerClassName="chat-select chat-permission-select" contentClassName="chat-composer-menu chat-permission-menu" />
          </div>
          <div className="chat-model">
            <SelectDropdown ariaLabel="选择模型" value={model?.id} onSelect={chat.setModel}
              items={models.map(item => ({ value: item.id, label: models.some(other => other.id !== item.id && other.name === item.name) ? `${item.name} · ${item.serviceName} · ${item.model}` : item.name }))}
              fallbackLabel={status === 'loading' ? '加载模型…' : status === 'error' ? '模型不可用' : '选择模型'}
              disabled={status !== 'ready' || !models.length} triggerClassName="chat-select chat-model-select" contentClassName="chat-composer-menu"
              search={models.length > 6 ? { ariaLabel: '搜索模型', placeholder: '搜索模型…' } : undefined} />
          </div>
          <div className="chat-reasoning" title={levels.length ? '模型思考等级' : '此模型未配置可选思考等级'}>
            <SelectDropdown ariaLabel="思考等级" value={session?.reasoningLevel ?? undefined} onSelect={chat.setReasoningLevel}
              leadingIcon={<Brain size={16} className="shrink-0" aria-hidden />}
              items={levels.map(level => ({ value: level, label: reasoningLabel(level) }))} fallbackLabel="默认"
              disabled={!levels.length} triggerClassName="chat-select chat-reasoning-select" contentClassName="chat-composer-menu" />
          </div>
          <IconButton label="发送消息" onPress={send} disabled={!canSend} className="chat-send"><Send size={20} aria-hidden /></IconButton>
        </div>
      </form>
    </div>

    {dragging && <div className="chat-drop-overlay"><Upload size={30} aria-hidden /><p className="mt-4 text-base font-medium">松开以添加附件</p><p className="mt-2 text-xs text-fg-muted">图片、文档、代码、音视频及压缩包</p></div>}
  </section>
}

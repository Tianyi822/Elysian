import { useRef, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { Link } from 'react-router'
import { AGENT_COMPOSER_FILE_ACCEPT } from '../../adapters/local/agentTextFiles'
import { Button } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import { Brain, Hand, Loader2, Paperclip, Send, ShieldAlert, ShieldCheck, Square, type IconComponent } from '../../components/icons'
import { RefreshButton } from '../../components/RefreshState'
import { SelectDropdown } from '../../components/SelectDropdown'
import type { useImeEnterGuard } from '../../components/useImeEnterGuard'
import type { AgentChatPermissionMode, AgentConversationAdapter } from '../../contracts/agentChat'
import type { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatApprovals } from './ChatApprovals'
import { ChatAttachment } from './ChatAttachment'
import { ChatPlan } from './ChatPlan'
import { ChatUserInput } from './ChatUserInput'
import { ChatUsageIndicator } from './ChatUsageIndicator'
import { reasoningLabel, type ChatModelOption, type useChatModels } from './useChatModels'

const PERMISSION_MODES: readonly { value: AgentChatPermissionMode; label: string; description: string; Icon: IconComponent }[] = [
  { value: 'ask', label: '请求批准', description: '需要批准的操作，按服务端规则请求确认。', Icon: Hand },
  { value: 'assist', label: '帮我批准', description: '自动批准可恢复的工作区写入，以及无宿主写权限、无出网的隔离执行。', Icon: ShieldCheck },
  { value: 'full', label: '完全开放', description: '自动批准已启用能力所需的操作与运行时权限，系统禁区与资源限制继续生效。', Icon: ShieldAlert },
]

type Props = {
  api: AgentConversationAdapter
  chat: Pick<ReturnType<typeof useAgentChatStore.getState>,
    'session' | 'timelines' | 'run' | 'inputError' | 'uploadingAttachments' | 'refreshing' | 'sending' | 'restoringAttachments' |
    'remoteSession' | 'continueTask' | 'refresh' | 'stop' | 'setUserInputAnswer' | 'answerUserInput' | 'removeAttachment' |
    'setDraft' | 'setPermissionMode' | 'setModel' | 'setReasoningLevel'>
  input: RefObject<HTMLTextAreaElement | null>
  model?: ChatModelOption
  models: readonly ChatModelOption[]
  status: ReturnType<typeof useChatModels>['status']
  reasoningLevels: ChatModelOption['reasoningLevels']
  reasoningLevel: string
  readError?: string | null
  retryReadLabel: string
  retryReads: () => void
  liveRunId?: string
  waitingInput: boolean
  busy: boolean
  stopping: boolean
  finalizing: boolean
  restoring: boolean
  attachmentsLocked: boolean
  canSubmit: boolean
  controls: ReturnType<typeof useImeEnterGuard> & {
    preferencesLocked: boolean
    canSend: boolean
    send: () => void
    dragFiles: (event: DragEvent<HTMLElement>) => void
    dropFiles: (event: DragEvent<HTMLElement>, editing?: boolean) => void
    pasteFiles: (event: ClipboardEvent<HTMLTextAreaElement>, editing?: boolean) => void
    addFiles: (files: File[]) => void
    followContent: () => void
  }
}

export function ChatComposer({ api, chat, input, model, models, status, reasoningLevels, reasoningLevel, readError, retryReadLabel,
  retryReads, liveRunId, waitingInput, busy, stopping, finalizing, restoring, attachmentsLocked, canSubmit, controls }: Props) {
  const session = chat.session
  const run = chat.run
  const fileInput = useRef<HTMLInputElement>(null)
  const { guardProps, isImeKey, preferencesLocked, canSend, send, dragFiles, dropFiles, pasteFiles, addFiles, followContent } = controls
  const usageTimeline = session?.remote?.runId ? chat.timelines[session.remote.runId] : undefined
  const inputEntry = waitingInput ? chat.timelines[chat.run!.id]?.entries.find(entry => entry.kind === 'user-input' && entry.userInput.status === 'pending') : undefined
  const inputRequest = inputEntry?.kind === 'user-input' ? inputEntry.userInput : undefined
  const inputDraft = session?.userInput?.id === inputRequest?.id ? session?.userInput : undefined
  const permissionMode = PERMISSION_MODES.find(mode => mode.value === session?.permissionMode) ?? PERMISSION_MODES[0]!
  const PermissionIcon = permissionMode.Icon
  /** 模型标识与设置页的「模型 ID」列同一口径；服务名放副行，不占触发器宽度。 */
  const modelOptions = models.map(item => ({
    value: item.id,
    label: models.some(other => other.id !== item.id && other.model === item.model) ? `${item.model} · ${item.serviceName}` : item.model,
    description: item.serviceName,
  }))
  const modelUnavailable = api.available && status === 'ready' && !chat.restoringAttachments && !restoring && (!models.length || (session?.remote && !model))
  const inputHints = [
    modelUnavailable ? '请选择支持文本与工具调用的可用模型，或前往设置添加模型。' : null,
    !api.available ? '当前为本地演示，请在已连接后端的面板中使用聊天。' : null,
    session?.attachments.length && model && !model.supportsImage ? '当前模型不支持图片输入，请移除附件或切换支持图片的模型。' : null,
    session?.attachments.some(attachment => !attachment.serverId) ? '存在旧版本添加、尚未上传的附件，请移除后重新添加。' : null,
  ].filter(Boolean)
  return <div className="chat-compose-area">
    {session?.pending?.input.continueFromRunId && <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-fg-muted">
      <Button variant="outline" type="button" className="chat-new" disabled={!canSubmit || !!session.editing} onClick={() => void chat.continueTask(api, model?.profile)}>重试继续任务</Button>
      <p role="status">继续请求尚未确认，可重试确认原请求。</p>
    </div>}
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
      budgetStopped={!!(usageTimeline?.budgetStop ?? run?.budgetStop)} status={usageTimeline?.status ?? run?.status ?? 'queued'} stopping={stopping} onProgress={followContent} />
    {run && (run.status === 'waiting-approval' || run.phase === 'preparing-runtime') ? <ChatApprovals key={run.id} api={api.governance} runId={run.id} onChanged={() => void chat.refresh(api)} onCancel={() => void chat.stop(api)} /> : inputRequest ? <ChatUserInput key={`${session?.id}:${inputRequest.id}`} request={inputRequest} answers={inputDraft?.answers ?? {}}
      submitting={chat.sending || stopping} pending={!!inputDraft?.pending}
      onAnswer={(questionId, answer) => chat.setUserInputAnswer(inputRequest, questionId, answer)}
      onSubmit={() => void chat.answerUserInput(api, inputRequest)} onCancel={() => void chat.stop(api)} /> :
    <form className="chat-composer panel-surface" {...guardProps} onSubmit={event => { event.preventDefault(); if (!isImeKey()) send() }} aria-label="消息输入框" onDragOver={dragFiles} onDrop={event => dropFiles(event)}>
      {!!session?.attachments.length && <ul aria-label="本地附件" className="hover-scrollbar flex max-h-52 flex-wrap gap-2 overflow-y-auto px-4 pt-4">{session.attachments.map(attachment => <ChatAttachment key={attachment.id} attachment={attachment} onRemove={() => chat.removeAttachment(attachment.id)} />)}</ul>}
      <label htmlFor="agent-message" className="sr-only">发送给 Ely 的消息</label>
      <textarea
        id="agent-message" ref={input} value={session?.draft ?? ''} rows={2}
        placeholder={restoring ? '正在读取会话…' : '向 Ely 发送消息…'} className="chat-textarea hover-scrollbar"
        disabled={!session || chat.restoringAttachments || chat.sending || !!session.pending}
        onChange={event => chat.setDraft(event.target.value)}
        onPaste={event => pasteFiles(event)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !isImeKey(event)) { event.preventDefault(); send() } }}
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
            disabled={!session || chat.restoringAttachments || busy || restoring || !!session.pending}
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
}

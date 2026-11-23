import { Fragment, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { Button, ButtonPressFeedback } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import { Bot, Image as ImageIcon, Pencil, X } from '../../components/icons'
import type { useImeEnterGuard } from '../../components/useImeEnterGuard'
import type { AgentConversationAdapter } from '../../contracts/agentChat'
import type { AgentMemoryAdapter } from '../../contracts/agentMemory'
import type { useAgentChatStore } from '../../stores/agentChatStore'
import { ChatMessageAttachments } from './ChatMessageAttachments'
import { ChatEditorFrame, ChatSendButton } from './ChatEffects'
import { ChatMessageCopy } from './ChatMessageCopy'
import { ChatMemorySources } from './ChatMemory'
import { ChatResponse } from './ChatResponse'
import { ChatRuntimeResult } from './ChatRuntimeResult'
import { ChatSwitchNotice, chatSwitchNotice } from './ChatSwitchNotice'
import { ChatTimeline } from './ChatTimeline'
import type { ChatModelOption } from './useChatModels'

type Props = {
  api: AgentConversationAdapter
  agentMemory: AgentMemoryAdapter
  chat: Pick<ReturnType<typeof useAgentChatStore.getState>,
    'session' | 'messages' | 'outgoingMessage' | 'syncErrorMessage' | 'restoringAttachments' | 'run' | 'timelines' |
    'liveOutput' | 'sending' | 'cancelEdit' | 'setEditText' | 'editMessage' | 'reasoning' | 'continueTask'>
  model?: ChatModelOption
  history: RefObject<HTMLDivElement | null>
  following: RefObject<boolean>
  followContent: () => void
  liveRunId?: string
  waitingForMessage: boolean
  waitingInput: boolean
  busy: boolean
  restoring: boolean
  finalizing: boolean
  stopping: boolean
  canSubmit: boolean
  editor: ReturnType<typeof useImeEnterGuard> & {
    editInput: RefObject<HTMLTextAreaElement | null>
    dragFiles: (event: DragEvent<HTMLElement>) => void
    dropFiles: (event: DragEvent<HTMLElement>, editing?: boolean) => void
    pasteFiles: (event: ClipboardEvent<HTMLTextAreaElement>, editing?: boolean) => void
    canResend: boolean
    resend: () => void
  }
}

export function ChatMessageList({ api, agentMemory, chat, model, history, following, followContent, liveRunId,
  waitingForMessage, waitingInput, busy, restoring, finalizing, stopping, canSubmit, editor }: Props) {
  const { guardProps, isImeKey, editInput, dragFiles, dropFiles, pasteFiles, canResend, resend } = editor
  const session = chat.session
  const lastUserMessage = chat.messages.filter(message => message.role === 'user').at(-1)
  return <ButtonPressFeedback value={false}><div ref={history} className="chat-history hover-scrollbar" onScroll={event => {
    const element = event.currentTarget
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }}>
    {!chat.messages.length && !chat.outgoingMessage && !waitingForMessage ? <div className="chat-empty">
      {session?.remote ? <>
        <h2 className="text-xl font-medium">{chat.syncErrorMessage ? '会话暂时无法读取' : restoring || chat.restoringAttachments ? '正在读取会话…' : '暂无消息'}</h2>
        {!chat.syncErrorMessage && (restoring || chat.restoringAttachments) && <p className="mt-3 text-sm text-fg-muted">正在加载历史消息。</p>}
      </> : <>
      <Bot size={38} className="mb-5 text-fg-muted" aria-hidden />
      <h2 className="text-2xl font-medium tracking-tight sm:text-[28px]">今天想聊什么？</h2>
      <p className="mt-3 text-sm text-fg-muted">选择模型，向 Ely 发送第一条消息。</p>
      {!!session?.messages.length && <p className="mt-3 text-xs text-fg-muted">本地预览消息未发送给模型。</p>}
      </>}
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
            {editing ? <ChatEditorFrame inline><form className="chat-message-editor panel-surface" aria-label="编辑最后一条消息" {...guardProps} onSubmit={event => { event.preventDefault(); if (!isImeKey()) resend() }} onDragOver={dragFiles} onDrop={event => dropFiles(event, true)}
              onKeyDown={event => {
                if (event.key === 'Escape' && !isImeKey(event)) {
                  event.preventDefault()
                  event.stopPropagation()
                  chat.cancelEdit()
                }
              }}>
              <label htmlFor="agent-edit-message" className="sr-only">编辑消息内容</label>
              <textarea id="agent-edit-message" ref={editInput} value={session.editing!.text} rows={4} className="chat-textarea hover-scrollbar"
                disabled={chat.sending || !!session.pending} onChange={event => chat.setEditText(event.target.value)}
                onPaste={event => pasteFiles(event, true)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !isImeKey(event)) { event.preventDefault(); resend() }
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
                <ChatSendButton label={session.pending ? '重试发送' : '发送'} disabled={!canResend} onPress={resend} />
              </div>
            </form></ChatEditorFrame> : <>
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
            : answer?.origin === 'runtime' && !stopped ? <ChatRuntimeResult key={message.runId} content={answer.content} /> : <ChatResponse key={message.runId} content={(chat.timelines[message.runId] || chat.syncErrorMessage ? answer?.content : undefined) ?? live?.content ?? ''} reasoning={chat.reasoning[message.runId] ?? ''}
              active={active && !finalizing} stopped={stopped} stopping={active && stopping} copyable={!!answer} quarantined={answer?.quarantined} onProgress={followContent} />}
          {message.runId === chat.run?.id && message.runId === session?.remote?.runId && chat.run.continuation && !session.pending?.input.continueFromRunId && <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
            <Button variant="outline" type="button" className="chat-new" disabled={!canSubmit || !!session.editing || (!session.pending?.input.continueFromRunId && !chat.run.continuation.allowed) || (!!session.pending && !session.pending.input.continueFromRunId)}
              onClick={() => { following.current = true; void chat.continueTask(api, model?.profile) }}>
              继续任务
            </Button>
            {chat.run.continuation.blockedReason && <p role="status">{chat.run.continuation.blockedReason}</p>}
          </div>}
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
  </div></ButtonPressFeedback>
}

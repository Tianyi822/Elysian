export type MessageTone = 'success' | 'info' | 'warning' | 'danger'

export type FeedbackMessage = {
  id: string
  tone: MessageTone
  message: string
  occurredAt: string
  read: boolean
}

export type MessageCursor = { occurredAt: string; id: string }
export type MessagePage = { messages: FeedbackMessage[]; cursor?: MessageCursor }

/** 浏览器本地消息接缝；记录只由用户清空，不随页面或登录生命周期删除。 */
export interface MessageLocalAdapter {
  put(message: FeedbackMessage): Promise<void>
  list(cursor?: MessageCursor, limit?: number): Promise<MessagePage>
  hasUnread(): Promise<boolean>
  markAllRead(): Promise<void>
  clear(): Promise<void>
  subscribe(listener: () => void): () => void
}

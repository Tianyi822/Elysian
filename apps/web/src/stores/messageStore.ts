import { create } from 'zustand'
import { createMessageLocalAdapter } from '../adapters/local/messageLocalAdapter'
import type { FeedbackMessage, MessageCursor, MessageLocalAdapter, MessageTone } from '../contracts/messages'
import { randomId } from '../utils/randomId'

export type { FeedbackMessage, MessageTone } from '../contracts/messages'
type MessageInput = { tone: MessageTone; message: string }
type ErrorKind = 'read' | 'write' | 'clear' | null

export type MessageState = {
  messages: readonly FeedbackMessage[]
  unsavedIds: readonly string[]
  unread: boolean
  viewing: boolean
  loading: boolean
  hasMore: boolean
  cursor?: MessageCursor
  error: string | null
  errorKind: ErrorKind
  announcement: FeedbackMessage | null
  notify(input: MessageInput): string
  update(id: string, input: MessageInput): void
  refresh(): Promise<void>
  loadMore(): Promise<void>
  setViewing(viewing: boolean): void
  clear(): Promise<boolean>
  retry(): Promise<void>
  subscribe(): () => void
  flush(): Promise<void>
}

/** 内存保留接入顺序，列表使用发生时间与稳定 ID 排序。 */
const merge = (...groups: Iterable<FeedbackMessage>[]) => [...new Map(groups.flatMap(group => [...group]).map(item => [item.id, item])).values()]
let fallbackId = 0
const messageId = () => {
  try { return randomId() }
  // 消息 ID 只用于本地排序与去重；安全随机源不可用时仍能记录业务失败。
  catch { return `local-${Date.now().toString(36)}-${++fallbackId}-${Math.random().toString(36).slice(2)}` }
}

export function createMessageStore(
  adapter: MessageLocalAdapter,
  now = () => new Date().toISOString(),
  id = messageId,
) {
  let tail: Promise<void> = Promise.resolve()
  let loadVersion = 0
  let mutation = 0
  const revisions = new Map<string, number>()
  const pending = new Map<string, FeedbackMessage>()
  const enqueue = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action)
    tail = result.then(() => {}, () => {})
    return result
  }

  return create<MessageState>((set, get) => {
    const persist = (message: FeedbackMessage) => {
      const revision = revisions.get(message.id)
      pending.set(message.id, message)
      void enqueue(async () => {
        try {
          // 已读变更也适用于尚未落盘的记录，重试时不能把它重新变成未读。
          const current = revisions.get(message.id) === revision ? pending.get(message.id) : undefined
          await adapter.put(current ?? message)
          if (revisions.get(message.id) === revision) {
            pending.delete(message.id)
            set(state => ({ unsavedIds: state.unsavedIds.filter(value => value !== message.id) }))
          }
        } catch {
          set(state => ({
            error: '部分消息未能保存，仅在当前页面可用。请重试。', errorKind: 'write',
            unsavedIds: [...new Set([...state.unsavedIds, message.id])],
          }))
        }
      })
    }
    const read = async (more: boolean) => {
      if (more && (get().loading || !get().hasMore)) return
      const version = ++loadVersion
      const cursor = more ? get().cursor : undefined
      const limit = more ? 50 : Math.max(50, get().messages.length)
      set({ loading: true })
      await enqueue(async () => {
        try {
          if (get().viewing) await adapter.markAllRead()
          const page = await adapter.list(cursor, limit)
          const unread = await adapter.hasUnread()
          if (version !== loadVersion) return
          const messages = merge(more ? [...page.messages].reverse() : [], more ? get().messages : [...page.messages].reverse(), pending.values())
          set(state => ({
            messages: state.viewing ? messages.map(message => ({ ...message, read: true })) : messages,
            cursor: page.cursor, hasMore: Boolean(page.cursor), loading: false,
            unread: !state.viewing && (unread || [...pending.values()].some(message => !message.read)),
            ...(state.errorKind === 'read' ? { error: null, errorKind: null } : {}),
          }))
        } catch {
          if (version === loadVersion) set({ loading: false, error: '无法读取本地消息，请重试。', errorKind: 'read' })
        }
      })
    }
    return {
      messages: [], unsavedIds: [], unread: false, viewing: false, loading: false, hasMore: false,
      error: null, errorKind: null, announcement: null,
      notify(input) {
        const message: FeedbackMessage = { ...input, id: id(), occurredAt: now(), read: get().viewing }
        revisions.set(message.id, ++mutation)
        set(state => ({ messages: merge(state.messages, [message]), unread: state.unread || !message.read, announcement: message }))
        persist(message)
        return message.id
      },
      update(messageId, input) {
        if (!get().messages.some(message => message.id === messageId)) return
        const message: FeedbackMessage = { ...input, id: messageId, occurredAt: now(), read: get().viewing }
        revisions.set(message.id, ++mutation)
        set(state => ({ messages: merge(state.messages, [message]), unread: state.unread || !message.read, announcement: message }))
        persist(message)
      },
      refresh: () => read(false),
      loadMore: () => read(true),
      setViewing(viewing) {
        set(state => ({ viewing, ...(viewing ? { unread: false, messages: state.messages.map(message => ({ ...message, read: true })) } : {}) }))
        if (viewing) for (const [id, message] of pending) pending.set(id, { ...message, read: true })
        if (viewing) void enqueue(async () => {
          try { await adapter.markAllRead() }
          catch { set({ error: '无法保存消息已读状态，请重试。', errorKind: 'read' }) }
        })
      },
      async clear() {
        ++loadVersion
        const snapshot = new Map(get().messages.map(message => [message.id, revisions.get(message.id) ?? 0]))
        const pendingSnapshot = new Map([...pending.keys()].map(id => [id, revisions.get(id)]))
        set({ viewing: false, loading: false })
        return enqueue(async () => {
          try {
            await adapter.clear()
            set(state => {
              const messages = state.messages.filter(message => !snapshot.has(message.id) || snapshot.get(message.id) !== (revisions.get(message.id) ?? 0))
              return { messages, unread: messages.some(message => !message.read), cursor: undefined, hasMore: false,
                unsavedIds: state.unsavedIds.filter(value => messages.some(message => message.id === value)), error: null, errorKind: null,
                announcement: messages.length ? state.announcement : null }
            })
            for (const [messageId, revision] of pendingSnapshot) if (revisions.get(messageId) === revision) pending.delete(messageId)
            return true
          } catch {
            set({ error: '清空消息失败，本地记录仍然保留。请重试。', errorKind: 'clear' })
            return false
          }
        })
      },
      async retry() {
        const messages = [...pending.values()]
        set({ error: null, errorKind: null })
        for (const message of messages) persist(message)
        await read(false)
      },
      subscribe() {
        const refresh = () => { if (document.visibilityState !== 'hidden') void get().refresh() }
        const unsubscribe = adapter.subscribe(refresh)
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        void get().refresh()
        return () => { unsubscribe(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
      },
      flush: () => tail,
    }
  })
}

export const useMessageStore = createMessageStore(createMessageLocalAdapter())

import type { FeedbackMessage, MessageCursor, MessageLocalAdapter, MessagePage } from '../../contracts/messages'

const DATABASE_NAME = 'elysian-messages'
const STORE = 'messages'
const CHANNEL = 'elysian.messages.v1'
type StoredMessage = FeedbackMessage & { unread: 0 | 1 }

const record = (value: StoredMessage): FeedbackMessage => ({
  id: value.id, tone: value.tone, message: value.message, occurredAt: value.occurredAt, read: value.read,
})

/** 索引游标分页，清空与已读更新使用读写事务；不把全部历史读入内存。 */
export function createMessageLocalAdapter(databaseName = DATABASE_NAME): MessageLocalAdapter {
  let database: Promise<IDBDatabase> | undefined
  let channel: BroadcastChannel | undefined
  const listeners = new Set<() => void>()
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持本地消息存储')); return }
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('chronology', ['occurredAt', 'id'])
        store.createIndex('unread', 'unread')
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined }
        resolve(request.result)
      }
      request.onerror = () => reject(new Error('无法打开浏览器消息存储'))
      request.onblocked = () => reject(new Error('消息存储正在升级，请关闭其他面板标签页后重试'))
    }).catch(error => { database = undefined; throw error })
    return database
  }
  const broadcast = () => { try { channel?.postMessage('changed') } catch { /* 后台标签页恢复时会回读。 */ } }
  const write = async (action: (store: IDBObjectStore) => void, changed = () => true) => {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = transaction.onabort = () => reject(new Error('浏览器未能保存消息变更'))
      action(transaction.objectStore(STORE))
    })
    if (changed()) broadcast()
  }
  return {
    put: message => write(store => store.put({ ...message, unread: message.read ? 0 : 1 } satisfies StoredMessage)),
    async list(cursor?: MessageCursor, limit = 50): Promise<MessagePage> {
      const db = await open()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly')
        const messages: FeedbackMessage[] = []
        let hasMore = false
        const range = cursor ? IDBKeyRange.upperBound([cursor.occurredAt, cursor.id], true) : undefined
        const request = transaction.objectStore(STORE).index('chronology').openCursor(range, 'prev')
        request.onsuccess = () => {
          const next = request.result
          if (!next) return
          if (messages.length >= limit) { hasMore = true; return }
          messages.push(record(next.value as StoredMessage))
          next.continue()
        }
        transaction.oncomplete = () => {
          const last = messages.at(-1)
          resolve({ messages, ...(hasMore && last ? { cursor: { occurredAt: last.occurredAt, id: last.id } } : {}) })
        }
        transaction.onerror = transaction.onabort = () => reject(new Error('无法读取本地消息'))
      })
    },
    async hasUnread() {
      const db = await open()
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).index('unread').count(1)
        request.onsuccess = () => resolve(request.result > 0)
        request.onerror = () => reject(new Error('无法读取消息未读状态'))
      })
    },
    markAllRead() {
      let changed = false
      return write(store => {
      const request = store.index('unread').openCursor(IDBKeyRange.only(1))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        changed = true
        cursor.update({ ...cursor.value, read: true, unread: 0 })
        cursor.continue()
      }
      }, () => changed)
    },
    clear: () => write(store => { store.clear() }),
    subscribe(listener) {
      listeners.add(listener)
      if (!channel && typeof BroadcastChannel !== 'undefined') {
        try {
          channel = new BroadcastChannel(`${CHANNEL}:${databaseName}`)
          channel.onmessage = () => { for (const notify of listeners) notify() }
        } catch { /* 无通道时在 focus、visibilitychange 时重新读取。 */ }
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { channel?.close(); channel = undefined }
      }
    },
  }
}

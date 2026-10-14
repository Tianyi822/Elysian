import { agentChatAllAttachments, agentChatSessionKey } from '../../contracts/agentChat'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatMessage, AgentChatSession } from '../../contracts/agentChat'

export const AGENT_CHAT_LEGACY_KEY = 'elysian.agent-chat.v1'
export const AGENT_CHAT_STORAGE_KEY = 'elysian.agent-chat.v2.selected'
export const AGENT_CHAT_RECORD_PREFIX = 'elysian.agent-chat.v2.session.'
const DATABASE_NAME = 'elysian-agent-chat'
const FILE_STORE = 'attachments'

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNullableString = (value: unknown) => value === null || typeof value === 'string'
const isPermissionMode = (value: unknown) => value === 'ask' || value === 'assist' || value === 'full'
const isAttachment = (value: unknown): value is AgentChatAttachment => isRecord(value)
  && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.type === 'string'
  && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
  && typeof value.lastModified === 'number' && Number.isFinite(value.lastModified)
const isMessage = (value: unknown): value is AgentChatMessage => isRecord(value)
  && typeof value.id === 'string' && value.role === 'user' && typeof value.text === 'string'
  && typeof value.createdAt === 'string' && isPermissionMode(value.permissionMode)
  && isNullableString(value.modelId) && isNullableString(value.reasoningLevel)
  && Array.isArray(value.attachments) && value.attachments.every(isAttachment)

const isSession = (value: unknown): value is AgentChatSession => isRecord(value)
  && typeof value.id === 'string' && typeof value.createdAt === 'string' && typeof value.draft === 'string'
  && isPermissionMode(value.permissionMode) && isNullableString(value.modelId) && isNullableString(value.reasoningLevel)
  && Array.isArray(value.messages) && value.messages.every(isMessage)
  && Array.isArray(value.attachments) && value.attachments.every(isAttachment)
  && (value.remote === undefined || (isRecord(value.remote) && typeof value.remote.sessionId === 'string'
    && (value.remote.taskId === undefined || typeof value.remote.taskId === 'string')
    && (value.remote.runId === undefined || typeof value.remote.runId === 'string')))
  && (value.pending === undefined || (isRecord(value.pending) && isRecord(value.pending.input)
    && typeof value.pending.input.requestId === 'string' && typeof value.pending.input.content === 'string'
    && (value.pending.input.reasoningLevel === undefined || typeof value.pending.input.reasoningLevel === 'string')
    && (value.pending.taskId === undefined || typeof value.pending.taskId === 'string')))

/** 不把 blob URL 或“可用”状态当成持久事实，刷新后必须重新核对文件字节。 */
const storedAttachment = ({ id, name, size, type, lastModified }: AgentChatAttachment): AgentChatAttachment => ({ id, name, size, type, lastModified, available: false })
const storedSession = (session: AgentChatSession): AgentChatSession => ({
  ...session,
  attachments: session.attachments.map(storedAttachment),
  messages: session.messages.map(message => ({ ...message, attachments: message.attachments.map(storedAttachment) })),
})

export function createAgentChatLocalAdapter(): AgentChatAdapter {
  const memoryFiles = new Map<string, Blob>()
  const previews = new Map<string, string>()
  const fallback = new Map<string, AgentChatSession>()
  const memoryOnly = new Set<string>()
  let selected: string | null = null
  let migrated = false
  const storageKey = (key: string) => AGENT_CHAT_RECORD_PREFIX + encodeURIComponent(key)
  const parse = (raw: string | null): AgentChatSession | null => {
    if (!raw) return null
    try { const value: unknown = JSON.parse(raw); return isSession(value) ? storedSession(value) : null }
    catch { return null }
  }
  const migrate = () => {
    if (migrated) return
    try {
      const legacy = parse(localStorage.getItem(AGENT_CHAT_LEGACY_KEY))
      if (legacy) {
        const key = agentChatSessionKey(legacy)
        // 分步失败时保留旧记录；重试不覆盖已经迁移后编辑过的内容。
        if (!localStorage.getItem(storageKey(key))) localStorage.setItem(storageKey(key), JSON.stringify(legacy))
        if (!localStorage.getItem(AGENT_CHAT_STORAGE_KEY)) localStorage.setItem(AGENT_CHAT_STORAGE_KEY, key)
        localStorage.removeItem(AGENT_CHAT_LEGACY_KEY)
      }
      migrated = true
    } catch { /* 存储恢复后再迁移，旧草稿和 requestId 不丢失。 */ }
  }
  const read = (key?: string): AgentChatSession | null => {
    migrate()
    try {
      key ??= selected ?? localStorage.getItem(AGENT_CHAT_STORAGE_KEY) ?? undefined
      if (!key) return parse(localStorage.getItem(AGENT_CHAT_LEGACY_KEY))
      if (memoryOnly.has(key)) return fallback.get(key) ?? null
      return parse(localStorage.getItem(storageKey(key))) ?? fallback.get(key) ?? null
    } catch { return key ? fallback.get(key) ?? null : selected ? fallback.get(selected) ?? null : null }
  }
  let database: Promise<IDBDatabase> | undefined

  const open = (): Promise<IDBDatabase> => {
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持本地附件存储')); return }
        const request = indexedDB.open(DATABASE_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('无法打开本地附件存储'))
        request.onblocked = () => reject(new Error('本地附件存储暂不可用'))
      }).catch(error => { database = undefined; throw error })
    }
    return database
  }

  const readFile = async (id: string): Promise<Blob | undefined> => {
    const memoryFile = memoryFiles.get(id)
    if (memoryFile) return memoryFile
    const db = await open()
    return new Promise((resolve, reject) => {
      const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(id)
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined)
      request.onerror = () => reject(new Error('读取本地附件失败'))
    })
  }

  const updateFiles = async (write: (store: IDBObjectStore) => void): Promise<void> => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_STORE, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('保存本地附件失败'))
      transaction.onabort = () => reject(new Error('保存本地附件已中断'))
      write(transaction.objectStore(FILE_STORE))
    })
  }

  const withFile = (attachment: AgentChatAttachment, file: Blob | undefined): AgentChatAttachment => {
    if (!file) return storedAttachment(attachment)
    let previewUrl = previews.get(attachment.id)
    if (!previewUrl && /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(file.type) && typeof URL.createObjectURL === 'function') {
      previewUrl = URL.createObjectURL(file)
      previews.set(attachment.id, previewUrl)
    }
    return { ...storedAttachment(attachment), available: true, ...(previewUrl ? { previewUrl } : {}) }
  }

  /** 附件字节的唯一释放路径：内存、预览与持久存储一起清。 */
  const releaseAttachments = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) {
      memoryFiles.delete(id)
      const preview = previews.get(id)
      if (preview) URL.revokeObjectURL(preview)
      previews.delete(id)
    }
    if (ids.length) {
      try { await updateFiles(store => ids.forEach(id => store.delete(id))) }
      catch { /* 无可用持久存储时，内存与预览也已经释放。 */ }
    }
  }

  return {
    read,
    list() {
      migrate()
      const records = new Map(fallback)
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (!key?.startsWith(AGENT_CHAT_RECORD_PREFIX)) continue
          const value = parse(localStorage.getItem(key))
          if (value && !memoryOnly.has(agentChatSessionKey(value))) records.set(agentChatSessionKey(value), value)
        }
      } catch { /* 保留当前页内存草稿。 */ }
      return [...records.values()]
    },
    select(key) {
      selected = key
      try { localStorage.setItem(AGENT_CHAT_STORAGE_KEY, key); return true }
      catch { return false }
    },
    write(session, select = true) {
      const value = storedSession(session)
      const key = agentChatSessionKey(value)
      fallback.set(key, value)
      if (select) selected = key
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(value))
        if (select) localStorage.setItem(AGENT_CHAT_STORAGE_KEY, key)
        memoryOnly.delete(key)
        // 首次创建服务器会话后，草稿记录搬到服务器 ID；只有写成功才清旧键。
        if (value.remote && value.id !== key) {
          localStorage.removeItem(storageKey(value.id))
          fallback.delete(value.id)
          memoryOnly.delete(value.id)
        }
        return true
      } catch { memoryOnly.add(key); return false }
    },
    remove(key) {
      // 服务端会话已删除后的本地清理：记录键、内存与附件字节尽力释放；
      // 跨标签的内存驱逐由既有 storage 监听完成，这里不触碰 v1 迁移键。
      const record = read(key)
      try { localStorage.removeItem(storageKey(key)) } catch { /* 清理失败不回滚已删除的服务端事实。 */ }
      fallback.delete(key)
      memoryOnly.delete(key)
      if (record) void releaseAttachments(agentChatAllAttachments(record).map(attachment => attachment.id))
      if (selected === key) {
        selected = null
        try { localStorage.removeItem(AGENT_CHAT_STORAGE_KEY) } catch { /* 同上。 */ }
      }
    },
    subscribe(listener) {
      const onStorage = (event: StorageEvent) => {
        // 选中指针属于各标签的导航；其他标签切换时不强制跟随。
        if (event.key === null || event.key.startsWith(AGENT_CHAT_RECORD_PREFIX)) {
          if (event.key === null) {
            for (const key of fallback.keys()) if (!memoryOnly.has(key)) fallback.delete(key)
          } else {
            try { const key = decodeURIComponent(event.key.slice(AGENT_CHAT_RECORD_PREFIX.length)); if (!memoryOnly.has(key)) fallback.delete(key) } catch { /* 非本适配器的键不参与同步。 */ }
          }
          listener()
        }
      }
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    },
    async attach(files) {
      const attachments = files.map(file => {
        const id = crypto.randomUUID()
        memoryFiles.set(id, file)
        return withFile({ id, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, available: true }, file)
      })
      try {
        await updateFiles(store => attachments.forEach((attachment, index) => store.put(files[index], attachment.id)))
        return { attachments, persisted: true }
      } catch { return { attachments, persisted: false } }
    },
    async restore(attachments) {
      return Promise.all(attachments.map(async attachment => {
        try { return withFile(attachment, await readFile(attachment.id)) }
        catch { return storedAttachment(attachment) }
      }))
    },
    discard: releaseAttachments,
  }
}

export const agentChatLocalAdapter = createAgentChatLocalAdapter()

import type { AgentChatAdapter, AgentChatAttachment, AgentChatMessage, AgentChatSession } from '../../contracts/agentChat'

export const AGENT_CHAT_STORAGE_KEY = 'elysian.agent-chat.v1'
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
  let fallback: AgentChatSession | null = null
  let memoryOnly = false
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

  return {
    read() {
      if (memoryOnly) return fallback
      try {
        const raw = localStorage.getItem(AGENT_CHAT_STORAGE_KEY)
        if (!raw) return fallback
        const parsed: unknown = JSON.parse(raw)
        return isSession(parsed) ? storedSession(parsed) : null
      } catch { return fallback }
    },
    write(session) {
      fallback = storedSession(session)
      try { localStorage.setItem(AGENT_CHAT_STORAGE_KEY, JSON.stringify(fallback)); memoryOnly = false; return true }
      catch { memoryOnly = true; return false }
    },
    subscribe(listener) {
      const onStorage = (event: StorageEvent) => {
        if (event.key === AGENT_CHAT_STORAGE_KEY) { fallback = null; memoryOnly = false; listener() }
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
    async discard(ids) {
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
    },
  }
}

export const agentChatLocalAdapter = createAgentChatLocalAdapter()

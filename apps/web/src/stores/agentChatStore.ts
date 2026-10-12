import { create } from 'zustand'
import { agentChatLocalAdapter } from '../adapters/local/agentChatLocalAdapter'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatPermissionMode, AgentChatSession } from '../contracts/agentChat'

type AgentChatState = {
  session: AgentChatSession | null
  loading: boolean
  notice: string | null
  ensureSession(): Promise<void>
  newSession(): Promise<void>
  setDraft(draft: string): void
  setPermissionMode(permissionMode: AgentChatPermissionMode): void
  setModel(modelId: string | null): void
  setReasoningLevel(reasoningLevel: string | null): void
  addAttachments(files: readonly File[]): Promise<void>
  removeAttachment(id: string): void
  /** 只记录本地用户消息；不会创建 Run、模型请求或任何审批授权。 */
  send(): boolean
  clearNotice(): void
}

const allAttachments = (session: AgentChatSession) => [...session.attachments, ...session.messages.flatMap(message => message.attachments)]
const persistenceNotice = '浏览器暂时无法保存会话，刷新后可能丢失本页内容。'

export function createAgentChatStore(adapter: AgentChatAdapter, now: () => string = () => new Date().toISOString(), id: () => string = () => crypto.randomUUID()) {
  return create<AgentChatState>((set, get) => {
    let restoring: Promise<void> | undefined
    let generation = 0
    const blankSession = (): AgentChatSession => ({
      id: id(), createdAt: now(), draft: '', messages: [], attachments: [],
      permissionMode: 'ask', modelId: null, reasoningLevel: null,
    })
    const persist = (session: AgentChatSession) => {
      set({ session })
      if (!adapter.write(session)) set({ notice: persistenceNotice })
    }
    const restore = async (session: AgentChatSession) => {
      const currentGeneration = ++generation
      set({ session, loading: true, notice: null })
      const attachments = await adapter.restore(allAttachments(session))
      if (currentGeneration !== generation || get().session?.id !== session.id) return
      const restored = new Map(attachments.map(attachment => [attachment.id, attachment]))
      const match = (attachment: AgentChatAttachment) => restored.get(attachment.id) ?? attachment
      const current = get().session!
      set({
        session: { ...current, attachments: current.attachments.map(match), messages: current.messages.map(message => ({ ...message, attachments: message.attachments.map(match) })) },
        loading: false,
        notice: attachments.some(attachment => !attachment.available) ? '部分附件已无法从浏览器恢复，请重新选择需要发送的文件。' : get().notice,
      })
    }
    // localStorage 的跨标签事件使同浏览器的新登录与会话编辑及时生效。
    adapter.subscribe(() => {
      const session = adapter.read()
      if (session) void restore(session)
    })
    const current = (): AgentChatSession => {
      const stored = adapter.read()
      // 新登录已由另一标签写入、storage 事件尚未分派时，也不能把旧会话写回。
      if (stored && get().session?.id !== stored.id) {
        void restore(stored)
        return stored
      }
      return get().session ?? stored ?? blankSession()
    }
    const update = (patch: Partial<AgentChatSession>) => persist({ ...current(), ...patch })
    return {
      session: null,
      loading: false,
      notice: null,
      async ensureSession() {
        if (get().session) { await restoring; return }
        if (restoring) { await restoring; return }
        const session = adapter.read()
        if (session) {
          restoring = restore(session)
          try { await restoring } finally { restoring = undefined }
        } else persist(blankSession())
      },
      async newSession() {
        const previous = get().session ?? adapter.read()
        generation += 1
        restoring = undefined
        set({ loading: false, notice: null })
        persist(blankSession())
        if (previous) await adapter.discard(allAttachments(previous).map(attachment => attachment.id))
      },
      setDraft: draft => update({ draft }),
      setPermissionMode: permissionMode => update({ permissionMode }),
      setModel: modelId => update({ modelId, reasoningLevel: null }),
      setReasoningLevel: reasoningLevel => update({ reasoningLevel }),
      async addAttachments(files) {
        if (!files.length) return
        const ready = get().ensureSession()
        const sessionId = current().id
        await ready
        if (current().id !== sessionId) return
        const result = await adapter.attach(files)
        const session = current()
        if (session.id !== sessionId) { await adapter.discard(result.attachments.map(attachment => attachment.id)); return }
        persist({ ...session, attachments: [...session.attachments, ...result.attachments] })
        if (!result.persisted) set({ notice: '附件仅在当前页面可用，浏览器暂时无法保存文件；刷新后请重新选择。' })
      },
      removeAttachment(attachmentId) {
        const session = current()
        persist({ ...session, attachments: session.attachments.filter(attachment => attachment.id !== attachmentId) })
        void adapter.discard([attachmentId])
      },
      send() {
        const session = current()
        const text = session.draft.trim()
        if (!text && !session.attachments.length) return false
        if (session.attachments.some(attachment => !attachment.available)) {
          set({ notice: '请移除不可用的附件或重新选择文件后发送。' })
          return false
        }
        persist({
          ...session, draft: '', attachments: [],
          messages: [...session.messages, {
            id: id(), role: 'user', text, createdAt: now(), attachments: session.attachments,
            permissionMode: session.permissionMode, modelId: session.modelId, reasoningLevel: session.reasoningLevel,
          }],
        })
        return true
      },
      clearNotice: () => set({ notice: null }),
    }
  })
}

export const useAgentChatStore = createAgentChatStore(agentChatLocalAdapter)

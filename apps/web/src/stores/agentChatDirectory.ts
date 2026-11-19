import type { AgentSession } from '@elysian/contracts'
import { agentChatSessionKey } from '../contracts/agentChat'
import type { AgentChatAdapter, AgentChatSession, AgentConversationAdapter } from '../contracts/agentChat'
import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf } from '../utils/errorMessage'
import type { MessageTone } from './messageStore'

type DirectoryDisplay = {
  sessions: readonly AgentSession[]
  localSessions: readonly AgentChatSession[]
  listStatus: 'idle' | 'loading' | 'ready' | 'error'
  listErrorMessage?: string
  listHasMore: boolean
  listCursor: string
}

type DirectoryActions = {
  loadSessions(api: AgentConversationAdapter, options?: { more?: boolean; silent?: boolean; userInitiated?: boolean }): Promise<void>
  renameSession(api: AgentConversationAdapter, id: string, title: string): Promise<void>
  deleteSession(api: AgentConversationAdapter, id: string): Promise<void>
}

export type AgentChatDirectoryState = DirectoryDisplay & DirectoryActions

type DirectoryContext = {
  adapter: Pick<AgentChatAdapter, 'list' | 'remove'>
  get: () => DirectoryDisplay & { sending: boolean; session: AgentChatSession | null; remoteSession: AgentSession | null }
  set: (state: Partial<DirectoryDisplay & { remoteSession: AgentSession | null }>) => void
  notify: (message: string, tone?: MessageTone) => void
  captureLifetime: () => () => boolean
  onSelectedSessionDeleted: (api: AgentConversationAdapter, fallback: AgentSession | undefined, current: () => boolean) => Promise<void>
}

const initialDisplay = (): DirectoryDisplay => ({ sessions: [], localSessions: [], listStatus: 'idle', listErrorMessage: undefined, listHasMore: false, listCursor: '' })

export function createAgentChatDirectory({ adapter, get, set, notify, captureLifetime, onSelectedSessionDeleted }: DirectoryContext) {
  let listVersion = 0
  let listInitialized = false
  let listFeedback: string | null = null
  // 删除已确认后，即使曾退出登录，后到的提交回执也不能恢复该本地记录。
  const deletionVersions = new Map<string, number>()
  const listStatusAfterMutation = () => get().listStatus === 'loading' ? (listInitialized ? 'ready' : 'idle') : get().listStatus

  const actions: DirectoryActions = {
    async loadSessions(api, { more, silent, userInitiated } = {}) {
      if (!api.available || (more && (!get().listHasMore || get().listStatus === 'loading'))) return
      const version = ++listVersion
      const cursor = more ? get().listCursor : ''
      set({ listStatus: 'loading', listErrorMessage: undefined, localSessions: adapter.list() })
      try {
        const page = await api.listSessions(cursor)
        if (version !== listVersion) return
        if (page.hasMore && page.nextCursor === cursor) throw new Error('会话列表分页未前进，请重新读取')
        listFeedback = null
        if (silent && listInitialized) {
          // 静默回读只更新列表内容，保留最后已加载页的游标和结束标记。
          // 显式刷新才重置分页；活动时间变化带来的重复由后续加载按 ID 去重。
          const records = new Map(page.items.map(row => [row.id, row]))
          for (const row of get().sessions) if (!records.has(row.id)) records.set(row.id, row)
          set({ listStatus: 'ready', sessions: [...records.values()] })
          return
        }
        const records = new Map((more ? get().sessions : []).map(row => [row.id, row]))
        for (const row of page.items) records.set(row.id, row)
        listInitialized = true
        set({ listStatus: 'ready', sessions: [...records.values()], listCursor: page.nextCursor, listHasMore: page.hasMore })
      } catch (error) {
        if (version === listVersion) {
          const message = messageOf(error, '会话请求失败')
          if (userInitiated || listFeedback !== message) notify(message)
          listFeedback = message
          set({ listStatus: 'error', listErrorMessage: message })
        }
      }
    },
    async renameSession(api, id, title) {
      if (get().sending) return
      const current = captureLifetime()
      let remote: AgentSession
      try {
        remote = await api.renameSession(id, { title: title.trim() })
      } catch (error) {
        if (!current()) return
        if (error instanceof AgentHttpError && error.status === 404) {
          // 会话已被别处删除：按会话消失处理，过滤行并说明，弹窗正常关闭。
          listVersion += 1
          set({ sessions: get().sessions.filter(row => row.id !== id), listStatus: listStatusAfterMutation() })
          notify('原会话已不存在，列表已更新。', 'info')
          return
        }
        throw error
      }
      if (!current()) return
      // 作废在途的列表读取，列表行与页头都采用已落库的标题。
      listVersion += 1
      set({
        listStatus: listStatusAfterMutation(),
        sessions: get().sessions.map(row => row.id === id ? remote : row),
        ...(get().remoteSession?.id === id ? { remoteSession: { ...get().remoteSession!, title: remote.title } } : {}),
      })
      notify('会话已重命名。', 'success')
    },
    async deleteSession(api, id) {
      const current = captureLifetime()
      try {
        await api.deleteSession(id)
      } catch (error) {
        // 404 视为已删；存储等真实失败保留本地记录并交给弹窗反馈。
        if (!(error instanceof AgentHttpError && error.status === 404)) throw error
      }
      deletionVersions.set(id, (deletionVersions.get(id) ?? 0) + 1)
      adapter.remove(id)
      if (!current()) return
      listVersion += 1
      const fallback = get().sessions.find(row => row.id !== id)
      set({ sessions: get().sessions.filter(row => row.id !== id), listStatus: listStatusAfterMutation() })
      set({ localSessions: adapter.list() })
      if (get().session && agentChatSessionKey(get().session!) === id) await onSelectedSessionDeleted(api, fallback, current)
      else notify('会话已删除。', 'success')
    },
  }
  return {
    state: { ...initialDisplay(), ...actions },
    deletionVersion: (id: string) => deletionVersions.get(id),
    resetDisplay() {
      listFeedback = null
      listVersion += 1
      listInitialized = false
      return initialDisplay()
    },
  }
}

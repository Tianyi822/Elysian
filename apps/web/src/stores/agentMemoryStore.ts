import { create } from 'zustand'
import type { AgentMemorySpace, AgentMemoryPage, AgentMemoryPageInput } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useSessionStore } from './sessionStore'
import { messageOf } from '../utils/errorMessage'

const message = (error: unknown) => messageOf(error, '读取知识 Wiki 失败')
type MemoryDisplay = {
  spaces: readonly AgentMemorySpace[]
  pages: readonly AgentMemoryPage[]
  spaceId: string
  page?: AgentMemoryPage
  current?: AgentMemoryPage
  status: 'idle' | 'loading' | 'ready' | 'error'
  reading: boolean
  saving: boolean
  errorMessage?: string
}
const initial: MemoryDisplay = {
  spaces: [], pages: [], spaceId: '', page: undefined, current: undefined,
  status: 'idle', reading: false, saving: false, errorMessage: undefined,
}
type MemoryState = MemoryDisplay & {
  load(gateway: ElysianGateway): Promise<void>
  selectSpace(gateway: ElysianGateway, spaceId: string): Promise<void>
  openPage(gateway: ElysianGateway, pageId: string): Promise<void>
  savePage(gateway: ElysianGateway, input: AgentMemoryPageInput, id: string): Promise<boolean>
  clearError(): void
  reset(): void
}
export const useAgentMemoryStore = create<MemoryState>((set, get) => {
  let generation = 0, selection = 0, reading = 0
  const valid = (epoch: number) => epoch === generation && useSessionStore.getState().phase === 'authed'
  const loadSpace = async (gateway: ElysianGateway, id: string, reset: boolean) => {
    const epoch = generation, request = ++selection
    if (reset) { reading++; set({ spaceId: id, pages: [], page: undefined, current: undefined, errorMessage: undefined, status: 'loading', reading: false }) }
    try {
      const pages = await gateway.agentMemory.listPages(id)
      if (valid(epoch) && request === selection && get().spaceId === id) set({ pages, status: 'ready', errorMessage: undefined })
    } catch (error) { if (valid(epoch) && request === selection) set({ status: 'error', errorMessage: message(error) }) }
  }
  return {
    ...initial,
    async load(gateway) {
      const currentSpaceId = get().spaceId
      if (currentSpaceId) return loadSpace(gateway, currentSpaceId, false)
      const epoch = ++generation
      set({ ...initial, status: 'loading' })
      try {
        const spaces = await gateway.agentMemory.listSpaces()
        if (!valid(epoch)) return
        const id = spaces[0]?.id ?? ''
        set({ spaces, status: id ? 'loading' : 'ready' })
        if (id) await loadSpace(gateway, id, true)
      } catch (error) { if (valid(epoch)) set({ status: 'error', errorMessage: message(error) }) }
    },
    selectSpace: (gateway, id) => loadSpace(gateway, id, true),
    async openPage(gateway, id) {
      const epoch = generation, request = ++reading, sid = get().spaceId
      set({ reading: true, page: undefined, current: undefined, errorMessage: undefined })
      try {
        const page = await gateway.agentMemory.getPage(sid, id)
        if (valid(epoch) && request === reading && get().spaceId === sid) set({ reading: false, current: page, page })
      } catch (error) { if (valid(epoch) && request === reading) set({ reading: false, errorMessage: message(error) }) }
    },
    async savePage(gateway, input, id) {
      if (get().saving) return false
      const epoch = generation, sid = get().spaceId
      set({ saving: true, errorMessage: undefined })
      try {
        await gateway.agentMemory.updatePage(sid, id, input)
        if (!valid(epoch)) return false
        if (get().spaceId === sid) { await loadSpace(gateway, sid, false); if (valid(epoch) && get().spaceId === sid) await get().openPage(gateway, id) }
        return true
      } catch (error) { if (valid(epoch)) set({ errorMessage: message(error) }); return false }
      finally { if (valid(epoch)) set({ saving: false }) }
    },
    clearError: () => set({ errorMessage: undefined }),
    reset() { generation++; selection++; reading++; set(initial) },
  }
})
useSessionStore.subscribe((state, previous) => { if (state.phase !== 'authed' && previous.phase === 'authed') useAgentMemoryStore.getState().reset() })

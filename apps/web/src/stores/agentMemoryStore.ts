import { create } from 'zustand'
import type { AgentMemorySpace, AgentMemoryPage, AgentMemoryPageInput } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useSessionStore } from './sessionStore'

const message = (error: unknown) => error instanceof Error ? error.message : '读取知识 Wiki 失败'
const initial = { spaces: [] as readonly AgentMemorySpace[], pages: [] as readonly AgentMemoryPage[], spaceId: '', page: undefined as AgentMemoryPage | undefined, current: undefined as AgentMemoryPage | undefined, loading: false, reading: false, saving: false, error: undefined as string | undefined }
type MemoryState = typeof initial & {
  initialize(gateway: ElysianGateway): Promise<void>
  selectSpace(gateway: ElysianGateway, spaceId: string): Promise<void>
  refresh(gateway: ElysianGateway): Promise<void>
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
    if (reset) { reading++; set({ spaceId: id, pages: [], page: undefined, current: undefined, error: undefined, loading: true, reading: false }) }
    try {
      const pages = await gateway.agentMemory.listPages(id)
      if (valid(epoch) && request === selection && get().spaceId === id) set({ pages, loading: false, error: undefined })
    } catch (error) { if (valid(epoch) && request === selection) set({ loading: false, error: message(error) }) }
  }
  return {
    ...initial,
    async initialize(gateway) {
      const epoch = ++generation
      set({ ...initial, loading: true })
      try {
        const spaces = await gateway.agentMemory.listSpaces()
        if (!valid(epoch)) return
        const id = spaces[0]?.id ?? ''
        set({ spaces, spaceId: id, loading: false })
        if (id) await loadSpace(gateway, id, true)
      } catch (error) { if (valid(epoch)) set({ loading: false, error: message(error) }) }
    },
    selectSpace: (gateway, id) => loadSpace(gateway, id, true),
    async refresh(gateway) { const id = get().spaceId; if (id) await loadSpace(gateway, id, false); else await get().initialize(gateway) },
    async openPage(gateway, id) {
      const epoch = generation, request = ++reading, sid = get().spaceId
      set({ reading: true, page: undefined, current: undefined, error: undefined })
      try {
        const page = await gateway.agentMemory.getPage(sid, id)
        if (valid(epoch) && request === reading && get().spaceId === sid) set({ reading: false, current: page, page })
      } catch (error) { if (valid(epoch) && request === reading) set({ reading: false, error: message(error) }) }
    },
    async savePage(gateway, input, id) {
      if (get().saving) return false
      const epoch = generation, sid = get().spaceId
      set({ saving: true, error: undefined })
      try {
        await gateway.agentMemory.updatePage(sid, id, input)
        if (!valid(epoch)) return false
        if (get().spaceId === sid) { await loadSpace(gateway, sid, false); if (valid(epoch) && get().spaceId === sid) await get().openPage(gateway, id) }
        return true
      } catch (error) { if (valid(epoch)) set({ error: message(error) }); return false }
      finally { if (valid(epoch)) set({ saving: false }) }
    },
    clearError: () => set({ error: undefined }),
    reset() { generation++; selection++; reading++; set(initial) },
  }
})
useSessionStore.subscribe((state, previous) => { if (state.phase !== 'authed' && previous.phase === 'authed') useAgentMemoryStore.getState().reset() })

import { create } from 'zustand'
import type { AgentMemorySpace, AgentMemoryPage, AgentMemoryPageInput, AgentMemoryProposal, AgentMemoryExtraction, AgentMemorySourceInput } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useSessionStore } from './sessionStore'

const message = (error: unknown) => error instanceof Error ? error.message : '读取知识 Wiki 失败'
const initial = { spaces: [] as readonly AgentMemorySpace[], pages: [] as readonly AgentMemoryPage[], proposals: [] as readonly AgentMemoryProposal[], jobs: [] as readonly AgentMemoryExtraction[], spaceId: '', page: undefined as AgentMemoryPage | undefined, current: undefined as AgentMemoryPage | undefined, revisions: [] as readonly AgentMemoryPage[], loading: false, reading: false, saving: false, searching: false, searchResults: undefined as readonly AgentMemoryPage[] | undefined, error: undefined as string | undefined, jobsCursor: '', jobsHasMore: false }
type MemoryState = typeof initial & {
  initialize(gateway: ElysianGateway, preferredSpace?: string): Promise<void>
  selectSpace(gateway: ElysianGateway, spaceId: string): Promise<void>
  refresh(gateway: ElysianGateway): Promise<void>
  openPage(gateway: ElysianGateway, pageId: string, revision?: number): Promise<void>
  search(gateway: ElysianGateway, query: string): Promise<void>
  moreJobs(gateway: ElysianGateway): Promise<void>
  createSpace(gateway: ElysianGateway, name: string): Promise<boolean>
  savePage(gateway: ElysianGateway, input: AgentMemoryPageInput, id?: string): Promise<boolean>
  importSource(gateway: ElysianGateway, input: AgentMemorySourceInput): Promise<boolean>
  decide(gateway: ElysianGateway, id: string, decision: 'approved' | 'rejected', expectedRevision?: number): Promise<boolean>
  withdraw(gateway: ElysianGateway): Promise<boolean>
  clearError(): void
  reset(): void
}
export const useAgentMemoryStore = create<MemoryState>((set, get) => {
  let generation = 0, selection = 0, reading = 0, searching = 0
  const valid = (epoch: number) => epoch === generation && useSessionStore.getState().phase === 'authed'
  const loadSpace = async (gateway: ElysianGateway, id: string, reset: boolean) => {
    const epoch = generation, request = ++selection
    if (reset) { reading++; searching++; set({ spaceId: id, pages: [], page: undefined, current: undefined, revisions: [], proposals: [], jobs: [], jobsCursor: '', jobsHasMore: false, searchResults: undefined, error: undefined, loading: true, reading: false, searching: false }) }
    try {
      const results = await Promise.allSettled([gateway.agentMemory.listPages(id), gateway.agentMemory.listProposals(id), gateway.agentMemory.listExtractions()])
      if (!valid(epoch) || request !== selection || get().spaceId !== id) return
      const [pages, proposals, jobs] = results
      set({ loading: false, ...(pages.status === 'fulfilled' ? { pages: pages.value } : {}), ...(proposals.status === 'fulfilled' ? { proposals: proposals.value } : {}), ...(jobs.status === 'fulfilled' ? { jobs: jobs.value.items, jobsCursor: jobs.value.nextCursor, jobsHasMore: jobs.value.hasMore } : {}), error: results.flatMap(result => result.status === 'rejected' ? [message(result.reason)] : []).join('；') || undefined })
    } catch (error) { if (valid(epoch) && request === selection) set({ loading: false, error: message(error) }) }
  }
  const perform = async (gateway: ElysianGateway, action: () => Promise<unknown>, pageId?: () => string | undefined) => {
    if (get().saving) return false
    const epoch = generation, spaceId = get().spaceId
    set({ saving: true, error: undefined })
    try {
      await action()
      if (!valid(epoch)) return false
      if (get().spaceId === spaceId) { await loadSpace(gateway, spaceId, false); const id = pageId?.(); if (id && valid(epoch) && get().spaceId === spaceId) await get().openPage(gateway, id) }
      return true
    } catch (error) { if (valid(epoch)) set({ error: message(error) }); return false }
    finally { if (valid(epoch)) set({ saving: false }) }
  }
  return {
    ...initial,
    async initialize(gateway, preferredSpace) {
      const epoch = ++generation
      set({ ...initial, loading: true })
      try { const spaces = await gateway.agentMemory.listSpaces(); if (!valid(epoch)) return; const id = spaces.find(space => space.id === preferredSpace)?.id ?? spaces[0]?.id ?? ''; set({ spaces, spaceId: id, loading: false }); if (id) await loadSpace(gateway, id, true) }
      catch (error) { if (valid(epoch)) set({ loading: false, error: message(error) }) }
    },
    selectSpace: (gateway, id) => loadSpace(gateway, id, true),
    async refresh(gateway) { const id = get().spaceId; if (id) await loadSpace(gateway, id, false); else await get().initialize(gateway) },
    async openPage(gateway, id, revision) {
      const epoch = generation, request = ++reading, sid = get().spaceId
      set({ reading: true, page: undefined, current: undefined, revisions: [], error: undefined })
      try { const [current, revisions, viewed] = await Promise.all([gateway.agentMemory.getPage(sid, id), gateway.agentMemory.listRevisions(sid, id), revision ? gateway.agentMemory.getRevision(sid, id, revision) : Promise.resolve(undefined)]); if (valid(epoch) && request === reading && get().spaceId === sid) set({ reading: false, current, page: viewed ?? current, revisions }) }
      catch (error) { if (valid(epoch) && request === reading) set({ reading: false, error: message(error) }) }
    },
    async search(gateway, query) { const epoch = generation, request = ++searching, sid = get().spaceId; if (!query.trim() || !sid) { set({ searchResults: undefined, searching: false }); return }; set({ searching: true }); try { const result = await gateway.agentMemory.search(sid, query); if (valid(epoch) && request === searching && get().spaceId === sid) set({ searching: false, searchResults: result.items.map(hit => hit.page), error: result.degraded ? result.reason : undefined }) } catch (error) { if (valid(epoch) && request === searching) set({ searching: false, error: message(error) }) } },
    async moreJobs(gateway) { const epoch = generation, request = selection, spaceId = get().spaceId, cursor = get().jobsCursor; const current = () => valid(epoch) && selection === request && get().spaceId === spaceId; try { const result = await gateway.agentMemory.listExtractions(cursor); if (current()) set(state => ({ jobs: [...state.jobs, ...result.items.filter(job => !state.jobs.some(existing => existing.id === job.id))], jobsCursor: result.nextCursor, jobsHasMore: result.hasMore })) } catch (error) { if (current()) set({ error: message(error) }) } },
    async createSpace(gateway, name) { if (get().saving) return false; const epoch = generation; set({ saving: true, error: undefined }); try { const space = await gateway.agentMemory.createSpace({ name, kind: 'business' }); if (!valid(epoch)) return false; set(state => ({ spaces: [...state.spaces, space] })); await loadSpace(gateway, space.id, true); return true } catch (error) { if (valid(epoch)) set({ error: message(error) }); return false } finally { if (valid(epoch)) set({ saving: false }) } },
    savePage(gateway, input, id) { let pageId = id; const sid = get().spaceId; return perform(gateway, async () => { const page = id ? await gateway.agentMemory.updatePage(sid, id, input) : await gateway.agentMemory.createPage(sid, input); pageId = page.id }, () => pageId) },
    importSource(gateway, input) { let pageId: string | undefined; const sid = get().spaceId; return perform(gateway, async () => { const result = await gateway.agentMemory.importSource(sid, input); pageId = result.source.id }, () => pageId) },
    decide: (gateway, id, decision, expectedRevision) => perform(gateway, () => gateway.agentMemory.decideProposal(id, decision, expectedRevision)),
    withdraw(gateway) { const page = get().current; if (!page) return Promise.resolve(false); return perform(gateway, () => gateway.agentMemory.withdrawPage(page.spaceId, page.id, page.revision), () => page.id) },
    clearError: () => set({ error: undefined }),
    reset() { generation++; selection++; reading++; searching++; set(initial) },
  }
})
// 清除公开内容并使全部旧请求失效，重新登录后必须重新鉴权读取。
useSessionStore.subscribe((state, previous) => { if (state.phase !== 'authed' && previous.phase === 'authed') useAgentMemoryStore.getState().reset() })

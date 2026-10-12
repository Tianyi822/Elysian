import { create } from 'zustand'
import type {
  AgentCreateMemoryExtractionInput,
  AgentEmbeddingProfile,
  AgentEmbeddingProfileInput,
  AgentEmbeddingRequest,
  AgentMemoryChecks,
  AgentMemoryExport,
  AgentMemoryExtraction,
  AgentMemoryIndexInput,
  AgentMemoryIndexStatus,
  AgentMemoryPage,
  AgentMemoryPageInput,
  AgentMemoryProposal,
  AgentMemoryProposalDecisionInput,
  AgentMemoryProposalStatus,
  AgentMemorySearchResult,
  AgentMemorySpace,
  AgentMemorySpaceInput,
  AgentUpdateEmbeddingProfileInput,
  RuntimePage,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useNotificationStore } from './notificationStore'

/*
 * 长期记忆域唯一 store。页面六态的读侧按「首次加载整块切换、就绪后静默刷新只盖
 * BusyVeil」的口径组织：每个切片带 loadStatus/reloading/errorMessage。写动作成功经
 * 通知中心留下可见反馈，失败原样抛出（对话框行内展示，不打进通知）；演示模式的
 * 动作提示按 MOCK_SUFFIX 口径标注。游标（nextCursor）一律字符串。
 */

const MOCK_NOTE = isDockerRuntime() ? '' : '（演示数据）'
const readSequence: Record<string, number> = {}
function nextRead(key: string): number {
  readSequence[key] = (readSequence[key] ?? 0) + 1
  return readSequence[key]
}
function currentRead(key: string, sequence: number): boolean {
  return readSequence[key] === sequence
}

export type MemoryLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function notify(tone: 'success' | 'info' | 'danger', message: string): void {
  useNotificationStore.getState().notify({ tone, message })
}

export type AgentMemoryState = {
  /* 空间 */
  spacesStatus: MemoryLoadStatus
  spacesReloading: boolean
  spaces: readonly AgentMemorySpace[]
  spacesErrorMessage?: string
  loadSpaces(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  createSpace(gateway: ElysianGateway, input: AgentMemorySpaceInput): Promise<AgentMemorySpace>
  renameSpace(gateway: ElysianGateway, spaceId: string, expectedRevision: number, name: string): Promise<AgentMemorySpace>

  /* 页面（按空间） */
  pagesSpaceId?: string
  pagesStatus: MemoryLoadStatus
  pagesReloading: boolean
  includeWithdrawn: boolean
  pages: readonly AgentMemoryPage[]
  pagesErrorMessage?: string
  loadPages(gateway: ElysianGateway, spaceId: string, options?: { silent?: boolean }): Promise<void>
  setIncludeWithdrawn(gateway: ElysianGateway, value: boolean): Promise<void>
  createPage(gateway: ElysianGateway, spaceId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage>
  updatePage(gateway: ElysianGateway, spaceId: string, pageId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage>
  withdrawPage(gateway: ElysianGateway, spaceId: string, pageId: string, expectedRevision: number): Promise<AgentMemoryPage>

  /* 历史修订（只读查看器） */
  revisionStatus: MemoryLoadStatus
  revisionPage?: AgentMemoryPage
  revisionErrorMessage?: string
  loadPageRevision(gateway: ElysianGateway, spaceId: string, pageId: string, revision: number): Promise<void>
  clearPageRevision(): void

  /* 搜索 */
  searchStatus: MemoryLoadStatus
  searchResult?: AgentMemorySearchResult
  searchErrorMessage?: string
  searchSpaceId?: string
  searchQuery?: string
  runSearch(gateway: ElysianGateway, spaceId: string, query: string, limit?: number): Promise<void>
  clearSearch(): void

  /* 提炼候选 */
  proposalsFilter: { spaceId?: string; status?: AgentMemoryProposalStatus }
  proposalsStatus: MemoryLoadStatus
  proposalsReloading: boolean
  proposals: readonly AgentMemoryProposal[]
  proposalsErrorMessage?: string
  loadProposals(gateway: ElysianGateway, filter?: { spaceId?: string; status?: AgentMemoryProposalStatus }, options?: { silent?: boolean }): Promise<void>
  decideProposal(gateway: ElysianGateway, proposalId: string, input: AgentMemoryProposalDecisionInput): Promise<AgentMemoryProposal>

  /* 提炼任务（分页列表 + 详情轮询） */
  extractionsStatus: MemoryLoadStatus
  extractionsReloading: boolean
  extractions: readonly AgentMemoryExtraction[]
  extractionsCursor: string
  extractionsHasMore: boolean
  extractionsErrorMessage?: string
  loadExtractions(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  loadMoreExtractions(gateway: ElysianGateway): Promise<void>
  createExtraction(gateway: ElysianGateway, input: AgentCreateMemoryExtractionInput): Promise<AgentMemoryExtraction>
  detailId?: string
  detailStatus: MemoryLoadStatus
  detailJob?: AgentMemoryExtraction
  detailErrorMessage?: string
  loadExtractionDetail(gateway: ElysianGateway, extractionId: string, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  clearExtractionDetail(): void

  /* 索引（每条 Embedding 配置一行） */
  indexSpaceId?: string
  indexStatusState: MemoryLoadStatus
  indexReloading: boolean
  indexStatuses: readonly AgentMemoryIndexStatus[]
  indexErrorMessage?: string
  loadIndexStatus(gateway: ElysianGateway, spaceId: string, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  rebuildIndex(gateway: ElysianGateway, spaceId: string, input: AgentMemoryIndexInput): Promise<AgentMemoryExtraction>

  /* 检查 */
  checksSpaceId?: string
  checksStatus: MemoryLoadStatus
  checksReloading: boolean
  checks?: AgentMemoryChecks
  checksErrorMessage?: string
  loadChecks(gateway: ElysianGateway, spaceId: string, options?: { silent?: boolean }): Promise<void>

  /* 导出预览 */
  exportSpaceId?: string
  exportStatus: MemoryLoadStatus
  exportData?: AgentMemoryExport
  exportErrorMessage?: string
  loadExport(gateway: ElysianGateway, spaceId: string): Promise<void>

  /* Embedding 配置与用量 */
  profilesStatus: MemoryLoadStatus
  profilesReloading: boolean
  profiles: readonly AgentEmbeddingProfile[]
  profilesErrorMessage?: string
  loadProfiles(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  createEmbeddingProfile(gateway: ElysianGateway, input: AgentEmbeddingProfileInput): Promise<AgentEmbeddingProfile>
  updateEmbeddingProfile(gateway: ElysianGateway, profileId: string, input: AgentUpdateEmbeddingProfileInput): Promise<AgentEmbeddingProfile>
  requestsStatus: MemoryLoadStatus
  requestsReloading: boolean
  requests: readonly AgentEmbeddingRequest[]
  requestsCursor: string
  requestsHasMore: boolean
  requestsErrorMessage?: string
  loadEmbeddingRequests(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadMoreEmbeddingRequests(gateway: ElysianGateway): Promise<void>

  /** 测试复位：回到未加载状态。 */
  reset(): void
}

function freshPage<T>(items: readonly T[]): RuntimePage<T> {
  return { items, nextCursor: '', hasMore: false }
}

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  spacesStatus: 'idle',
  spacesReloading: false,
  spaces: [],
  async loadSpaces(gateway, options) {
    const sequence = nextRead('spaces')
    const inPlace = get().spacesStatus === 'ready'
    if (!options?.silent) set(inPlace ? { spacesReloading: true, spacesErrorMessage: undefined } : { spacesStatus: 'loading', spacesErrorMessage: undefined })
    try {
      const spaces = await gateway.agentMemory.listSpaces()
      if (!currentRead('spaces', sequence)) return
      set({ spacesStatus: 'ready', spacesReloading: false, spaces, spacesErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('spaces', sequence)) return
      set({ spacesStatus: 'error', spacesReloading: false, spacesErrorMessage: messageOf(error, '读取记忆空间失败') })
    }
  },
  async createSpace(gateway, input) {
    const space = await gateway.agentMemory.createSpace(input)
    notify('success', `记忆空间「${space.name}」已创建${MOCK_NOTE}`)
    await get().loadSpaces(gateway, { silent: true })
    return space
  },
  async renameSpace(gateway, spaceId, expectedRevision, name) {
    const space = await gateway.agentMemory.renameSpace(spaceId, expectedRevision, name)
    notify('success', `记忆空间已更名为「${space.name}」${MOCK_NOTE}`)
    await get().loadSpaces(gateway, { silent: true })
    return space
  },

  pagesStatus: 'idle',
  pagesReloading: false,
  includeWithdrawn: false,
  pages: [],
  async loadPages(gateway, spaceId, options) {
    const sequence = nextRead('pages')
    const state = get()
    const sameSpace = state.pagesSpaceId === spaceId
    const inPlace = sameSpace && state.pagesStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { pagesReloading: true, pagesErrorMessage: undefined }
        : { pagesStatus: 'loading', pagesSpaceId: spaceId, pages: [], pagesErrorMessage: undefined })
    }
    try {
      const pages = await gateway.agentMemory.listPages(spaceId, state.includeWithdrawn)
      if (!currentRead('pages', sequence)) return
      set({ pagesStatus: 'ready', pagesReloading: false, pagesSpaceId: spaceId, pages, pagesErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('pages', sequence)) return
      set({ pagesStatus: 'error', pagesReloading: false, pagesSpaceId: spaceId, pagesErrorMessage: messageOf(error, '读取 Wiki 页面失败') })
    }
  },
  async setIncludeWithdrawn(gateway, value) {
    const spaceId = get().pagesSpaceId
    if (spaceId === undefined) return
    set({ includeWithdrawn: value })
    await get().loadPages(gateway, spaceId)
  },
  async createPage(gateway, spaceId, input) {
    const page = await gateway.agentMemory.createPage(spaceId, input)
    notify('success', `Wiki 页面「${page.title}」已创建（修订 ${page.revision}）${MOCK_NOTE}`)
    await get().loadPages(gateway, spaceId, { silent: true })
    return page
  },
  async updatePage(gateway, spaceId, pageId, input) {
    const page = await gateway.agentMemory.updatePage(spaceId, pageId, input)
    notify('success', `Wiki 页面「${page.title}」已保存为修订 ${page.revision}${MOCK_NOTE}`)
    await get().loadPages(gateway, spaceId, { silent: true })
    return page
  },
  async withdrawPage(gateway, spaceId, pageId, expectedRevision) {
    const page = await gateway.agentMemory.withdrawPage(spaceId, pageId, expectedRevision)
    notify('info', `Wiki 页面「${page.title}」已撤回（修订 ${page.revision}），依赖它的候选与派生上下文已在同一事务标记失效${MOCK_NOTE}`)
    await get().loadPages(gateway, spaceId, { silent: true })
    return page
  },

  revisionStatus: 'idle',
  async loadPageRevision(gateway, spaceId, pageId, revision) {
    const sequence = nextRead('revision')
    set({ revisionStatus: 'loading', revisionErrorMessage: undefined })
    try {
      const page = await gateway.agentMemory.getPageRevision(spaceId, pageId, revision)
      if (!currentRead('revision', sequence)) return
      set({ revisionStatus: 'ready', revisionPage: page, revisionErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('revision', sequence)) return
      set({ revisionStatus: 'error', revisionErrorMessage: messageOf(error, '读取历史修订失败') })
    }
  },
  clearPageRevision() {
    nextRead('revision')
    set({ revisionStatus: 'idle', revisionPage: undefined, revisionErrorMessage: undefined })
  },

  searchStatus: 'idle',
  async runSearch(gateway, spaceId, query, limit) {
    const sequence = nextRead('search')
    set({ searchStatus: 'loading', searchSpaceId: spaceId, searchQuery: query, searchErrorMessage: undefined })
    try {
      const result = await gateway.agentMemory.search(spaceId, query, limit)
      if (!currentRead('search', sequence)) return
      set({ searchStatus: 'ready', searchResult: result, searchErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('search', sequence)) return
      set({ searchStatus: 'error', searchErrorMessage: messageOf(error, 'Wiki 搜索失败') })
    }
  },
  clearSearch() {
    nextRead('search')
    set({ searchStatus: 'idle', searchResult: undefined, searchErrorMessage: undefined, searchSpaceId: undefined, searchQuery: undefined })
  },

  proposalsFilter: {},
  proposalsStatus: 'idle',
  proposalsReloading: false,
  proposals: [],
  async loadProposals(gateway, filter, options) {
    const sequence = nextRead('proposals')
    const nextFilter = filter ?? get().proposalsFilter
    const sameFilter = Object.keys(nextFilter).length === Object.keys(get().proposalsFilter).length &&
      nextFilter.spaceId === get().proposalsFilter.spaceId && nextFilter.status === get().proposalsFilter.status
    const inPlace = sameFilter && get().proposalsStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { proposalsReloading: true, proposalsErrorMessage: undefined }
        : { proposalsStatus: 'loading', proposalsFilter: nextFilter, proposals: [], proposalsErrorMessage: undefined })
    }
    try {
      const proposals = await gateway.agentMemory.listProposals(nextFilter)
      if (!currentRead('proposals', sequence)) return
      set({ proposalsStatus: 'ready', proposalsReloading: false, proposalsFilter: nextFilter, proposals, proposalsErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('proposals', sequence)) return
      set({ proposalsStatus: 'error', proposalsReloading: false, proposalsFilter: nextFilter, proposalsErrorMessage: messageOf(error, '读取提炼候选失败') })
    }
  },
  async decideProposal(gateway, proposalId, input) {
    const proposal = await gateway.agentMemory.decideProposal(proposalId, input)
    notify(input.decision === 'approved' ? 'success' : 'info',
      input.decision === 'approved'
        ? `候选已采纳并发布为页面修订${proposal.pageId !== undefined ? `（页面 ${proposal.pageId}）` : ''}${MOCK_NOTE}`
        : `候选已拒绝，不再进入长期记忆${MOCK_NOTE}`)
    await get().loadProposals(gateway, undefined, { silent: true })
    return proposal
  },

  extractionsStatus: 'idle',
  extractionsReloading: false,
  extractions: [],
  extractionsCursor: '',
  extractionsHasMore: false,
  async loadExtractions(gateway, options) {
    const sequence = nextRead('extractions')
    const inPlace = get().extractionsStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { extractionsReloading: true, extractionsErrorMessage: undefined }
        : { extractionsStatus: 'loading', extractions: [], extractionsErrorMessage: undefined })
    }
    try {
      const page = await gateway.agentMemory.listExtractions(undefined, options?.signal)
      if (!currentRead('extractions', sequence) || options?.signal?.aborted) return
      set({
        extractionsStatus: 'ready',
        extractionsReloading: false,
        extractions: page.items,
        extractionsCursor: page.nextCursor,
        extractionsHasMore: page.hasMore,
        extractionsErrorMessage: undefined,
      })
    } catch (error) {
      if (!currentRead('extractions', sequence) || options?.signal?.aborted) return
      if (options?.silent) throw error
      set({ extractionsStatus: 'error', extractionsReloading: false, extractionsErrorMessage: messageOf(error, '读取提炼任务失败') })
    }
  },
  async loadMoreExtractions(gateway) {
    const { extractionsCursor, extractionsHasMore } = get()
    if (!extractionsHasMore) return
    const sequence = nextRead('extractions')
    try {
      const page = await gateway.agentMemory.listExtractions({ cursor: extractionsCursor })
      if (!currentRead('extractions', sequence)) return
      const known = new Set(get().extractions.map((job) => job.id))
      const merged = [...get().extractions, ...page.items.filter((job) => !known.has(job.id))]
      set({ extractions: merged, extractionsCursor: page.nextCursor, extractionsHasMore: page.hasMore })
    } catch (error) {
      if (!currentRead('extractions', sequence)) return
      set({ extractionsErrorMessage: messageOf(error, '读取更多提炼任务失败') })
    }
  },
  async createExtraction(gateway, input) {
    const job = await gateway.agentMemory.createExtraction(input)
    notify('info', `提炼任务 ${job.id} 已提交（${job.status === 'queued' ? '排队中' : '回读既有任务'}），完成后产出待确认候选${MOCK_NOTE}`)
    await get().loadExtractions(gateway, { silent: true })
    return job
  },
  detailStatus: 'idle',
  async loadExtractionDetail(gateway, extractionId, options) {
    const sequence = nextRead('detail')
    if (get().detailId !== extractionId) {
      set({ detailStatus: 'loading', detailId: extractionId, detailJob: undefined, detailErrorMessage: undefined })
    } else if (!options?.silent && get().detailStatus !== 'ready') {
      set({ detailStatus: 'loading', detailErrorMessage: undefined })
    }
    try {
      const job = await gateway.agentMemory.getExtraction(extractionId, options?.signal)
      if (!currentRead('detail', sequence) || options?.signal?.aborted) return
      set({ detailStatus: 'ready', detailId: extractionId, detailJob: job, detailErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('detail', sequence) || options?.signal?.aborted) return
      if (options?.silent && get().detailJob !== undefined) throw error
      set({ detailStatus: 'error', detailId: extractionId, detailErrorMessage: messageOf(error, '读取提炼任务详情失败') })
      if (options?.silent) throw error
    }
  },
  clearExtractionDetail() {
    nextRead('detail')
    set({ detailStatus: 'idle', detailId: undefined, detailJob: undefined, detailErrorMessage: undefined })
  },

  indexStatusState: 'idle',
  indexReloading: false,
  indexStatuses: [],
  async loadIndexStatus(gateway, spaceId, options) {
    const sequence = nextRead('index')
    const inPlace = get().indexSpaceId === spaceId && get().indexStatusState === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { indexReloading: true, indexErrorMessage: undefined }
        : { indexStatusState: 'loading', indexSpaceId: spaceId, indexStatuses: [], indexReloading: false, indexErrorMessage: undefined })
    }
    try {
      const statuses = await gateway.agentMemory.indexStatus(spaceId, options?.signal)
      if (!currentRead('index', sequence) || options?.signal?.aborted) return
      set({ indexStatusState: 'ready', indexSpaceId: spaceId, indexStatuses: statuses, indexReloading: false, indexErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('index', sequence) || options?.signal?.aborted) return
      if (options?.silent) throw error
      set({ indexStatusState: 'error', indexSpaceId: spaceId, indexReloading: false, indexErrorMessage: messageOf(error, '读取索引状态失败') })
    }
  },
  async rebuildIndex(gateway, spaceId, input) {
    const job = await gateway.agentMemory.rebuildIndex(spaceId, input)
    notify('info', `索引重建任务 ${job.id} 已提交（${job.status === 'queued' ? '排队中' : job.status === 'running' ? '进行中' : '回读既有任务'}），完成后索引回到 ready${MOCK_NOTE}`)
    return job
  },

  checksStatus: 'idle',
  checksReloading: false,
  async loadChecks(gateway, spaceId, options) {
    const sequence = nextRead('checks')
    const inPlace = get().checksSpaceId === spaceId && get().checksStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { checksReloading: true, checksErrorMessage: undefined }
        : { checksStatus: 'loading', checksSpaceId: spaceId, checks: undefined, checksReloading: false, checksErrorMessage: undefined })
    }
    try {
      const report = await gateway.agentMemory.checkSpace(spaceId)
      if (!currentRead('checks', sequence)) return
      set({ checksStatus: 'ready', checksSpaceId: spaceId, checks: report, checksReloading: false, checksErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('checks', sequence)) return
      set({ checksStatus: 'error', checksSpaceId: spaceId, checksReloading: false, checksErrorMessage: messageOf(error, '读取一致性检查失败') })
    }
  },

  exportStatus: 'idle',
  async loadExport(gateway, spaceId) {
    const sequence = nextRead('export')
    set({ exportStatus: 'loading', exportSpaceId: spaceId, exportErrorMessage: undefined })
    try {
      const data = await gateway.agentMemory.exportSpace(spaceId)
      if (!currentRead('export', sequence)) return
      set({ exportStatus: 'ready', exportSpaceId: spaceId, exportData: data, exportErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('export', sequence)) return
      set({ exportStatus: 'error', exportSpaceId: spaceId, exportErrorMessage: messageOf(error, '读取导出内容失败') })
    }
  },

  profilesStatus: 'idle',
  profilesReloading: false,
  profiles: [],
  async loadProfiles(gateway, options) {
    const sequence = nextRead('profiles')
    const inPlace = get().profilesStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { profilesReloading: true, profilesErrorMessage: undefined }
        : { profilesStatus: 'loading', profiles: [], profilesReloading: false, profilesErrorMessage: undefined })
    }
    try {
      const profiles = await gateway.agentMemory.listEmbeddingProfiles()
      if (!currentRead('profiles', sequence)) return
      set({ profilesStatus: 'ready', profiles, profilesReloading: false, profilesErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('profiles', sequence)) return
      set({ profilesStatus: 'error', profilesReloading: false, profilesErrorMessage: messageOf(error, '读取 Embedding 配置失败') })
    }
  },
  async createEmbeddingProfile(gateway, input) {
    const profile = await gateway.agentMemory.createEmbeddingProfile(input)
    notify('success', `Embedding 配置「${profile.name}」已创建（修订 ${profile.revision}）${MOCK_NOTE}`)
    await get().loadProfiles(gateway, { silent: true })
    return profile
  },
  async updateEmbeddingProfile(gateway, profileId, input) {
    const profile = await gateway.agentMemory.updateEmbeddingProfile(profileId, input)
    notify('success', `Embedding 配置「${profile.name}」已保存为修订 ${profile.revision}${MOCK_NOTE}`)
    await get().loadProfiles(gateway, { silent: true })
    return profile
  },
  requestsStatus: 'idle',
  requestsReloading: false,
  requests: [],
  requestsCursor: '',
  requestsHasMore: false,
  async loadEmbeddingRequests(gateway, options) {
    const sequence = nextRead('requests')
    const inPlace = get().requestsStatus === 'ready'
    if (!options?.silent) {
      set(inPlace
        ? { requestsReloading: true, requestsErrorMessage: undefined }
        : { requestsStatus: 'loading', requests: [], requestsReloading: false, requestsErrorMessage: undefined })
    }
    try {
      const page = await gateway.agentMemory.listEmbeddingRequests()
      if (!currentRead('requests', sequence)) return
      set({ requestsStatus: 'ready', requests: page.items, requestsCursor: page.nextCursor, requestsHasMore: page.hasMore, requestsReloading: false, requestsErrorMessage: undefined })
    } catch (error) {
      if (!currentRead('requests', sequence)) return
      set({ requestsStatus: 'error', requestsReloading: false, requestsErrorMessage: messageOf(error, '读取 Embedding 用量失败') })
    }
  },
  async loadMoreEmbeddingRequests(gateway) {
    const { requestsCursor, requestsHasMore } = get()
    if (!requestsHasMore) return
    const sequence = nextRead('requests')
    try {
      const page = await gateway.agentMemory.listEmbeddingRequests({ cursor: requestsCursor })
      if (!currentRead('requests', sequence)) return
      const known = new Set(get().requests.map((item) => item.id))
      set({
        requests: [...get().requests, ...page.items.filter((item) => !known.has(item.id))],
        requestsCursor: page.nextCursor,
        requestsHasMore: page.hasMore,
      })
    } catch (error) {
      if (!currentRead('requests', sequence)) return
      set({ requestsErrorMessage: messageOf(error, '读取更多 Embedding 用量失败') })
    }
  },

  reset() {
    for (const key of Object.keys(readSequence)) nextRead(key)
    set({
      spacesStatus: 'idle', spacesReloading: false, spaces: [], spacesErrorMessage: undefined,
      pagesSpaceId: undefined, pagesStatus: 'idle', pagesReloading: false, includeWithdrawn: false, pages: [], pagesErrorMessage: undefined,
      revisionStatus: 'idle', revisionPage: undefined, revisionErrorMessage: undefined,
      searchStatus: 'idle', searchResult: undefined, searchErrorMessage: undefined, searchSpaceId: undefined, searchQuery: undefined,
      proposalsFilter: {}, proposalsStatus: 'idle', proposalsReloading: false, proposals: [], proposalsErrorMessage: undefined,
      extractionsStatus: 'idle', extractionsReloading: false, extractions: [], extractionsCursor: '', extractionsHasMore: false, extractionsErrorMessage: undefined,
      detailId: undefined, detailStatus: 'idle', detailJob: undefined, detailErrorMessage: undefined,
      indexSpaceId: undefined, indexStatusState: 'idle', indexReloading: false, indexStatuses: [], indexErrorMessage: undefined,
      checksSpaceId: undefined, checksStatus: 'idle', checksReloading: false, checks: undefined, checksErrorMessage: undefined,
      exportSpaceId: undefined, exportStatus: 'idle', exportData: undefined, exportErrorMessage: undefined,
      profilesStatus: 'idle', profilesReloading: false, profiles: [], profilesErrorMessage: undefined,
      requestsStatus: 'idle', requestsReloading: false, requests: [], requestsCursor: '', requestsHasMore: false, requestsErrorMessage: undefined,
    })
  },
}))

/** 供类型引用的空分页（避免各处手写字面量漂移）。 */
export function emptyMemoryPage<T>(): RuntimePage<T> {
  return freshPage<T>([])
}

/** 提炼任务是否处于非终态（详情轮询的 enabled 判据）。 */
export function extractionIsActive(job: AgentMemoryExtraction | undefined): boolean {
  return job !== undefined && ['queued', 'running'].includes(job.status)
}

/** 适配器可用位（演示模式为 false，仅用于页面标注，不判不可用态）。 */
export function selectMemoryAvailable(adapter: { available: boolean }): boolean {
  return adapter.available
}

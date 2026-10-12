import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMemoryAdapter } from '../contracts/adapters'
import type { ElysianGateway } from '../contracts/adapters'
import type { AgentMemoryExtraction, AgentMemoryPage, RuntimePage } from '@elysian/contracts'
import { useAgentMemoryStore } from './agentMemoryStore'
import { useNotificationStore } from './notificationStore'
import { AgentMemoryMockAdapter, resetAgentMemoryData } from '../adapters/mock/agent/agentMemoryMockAdapter'

/*
 * 长期记忆 store 的动作流转：六态读侧（loading/ready/error + reloading）、
 * 写侧成功通知与失败上抛、分页去重、单飞锁由组件层 hook 承担（此处不重复）。
 * 演示实现提供真实语义状态机，错误分支用临时替换 adapter 方法模拟。
 */

function makeGateway(adapter: AgentMemoryAdapter): ElysianGateway {
  return { agentMemory: adapter } as unknown as ElysianGateway
}

beforeEach(() => {
  resetAgentMemoryData()
  useAgentMemoryStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('空间与页面切片', () => {
  it('loadSpaces：成功进 ready；失败进 error 并保留中文错误', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadSpaces(gateway)
    expect(useAgentMemoryStore.getState().spacesStatus).toBe('ready')
    expect(useAgentMemoryStore.getState().spaces.length).toBe(2)

    const failing = new AgentMemoryMockAdapter()
    vi.spyOn(failing, 'listSpaces').mockRejectedValue(new Error('读取被拒绝'))
    await useAgentMemoryStore.getState().loadSpaces(makeGateway(failing))
    expect(useAgentMemoryStore.getState().spacesStatus).toBe('error')
    expect(useAgentMemoryStore.getState().spacesErrorMessage).toBe('读取被拒绝')
  })

  it('createPage：通知成功并静默回读页面列表；CAS 失败原样上抛', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadPages(gateway, 'space-1')
    const created = await useAgentMemoryStore.getState().createPage(gateway, 'space-1', {
      slug: 'store/create', title: 'store 建页', markdown: '# store', kind: 'reference',
    })
    expect(created.revision).toBe(1)
    expect(useAgentMemoryStore.getState().pages.some((page) => page.id === created.id)).toBe(true)
    expect(useNotificationStore.getState().notifications.at(-1)?.message).toContain('已创建')

    await expect(useAgentMemoryStore.getState().updatePage(gateway, 'space-1', created.id, {
      slug: 'store/create', title: 'store 建页', markdown: '# store', kind: 'reference', expectedRevision: 99,
    })).rejects.toThrow('Wiki 页面版本已变化')
  })

  it('withdrawPage：成功通知说明派生物同事务失效', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadPages(gateway, 'space-1')
    await useAgentMemoryStore.getState().withdrawPage(gateway, 'space-1', 'page-b', 1)
    const message = useNotificationStore.getState().notifications.at(-1)?.message ?? ''
    expect(message).toContain('已撤回')
    expect(message).toContain('失效')
    // 默认列表不含撤回页：静默回读后 page-b 从当前列表消失，权威状态回读适配器确认。
    expect(useAgentMemoryStore.getState().pages.some((page) => page.id === 'page-b')).toBe(false)
    expect((await adapter.getPage('space-1', 'page-b')).status).toBe('withdrawn')
  })

  it('切换空间时丢弃旧页面响应，复位后也不回填在途详情', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const oldPages = await adapter.listPages('space-1')
    const oldJob = (await adapter.listExtractions()).items[0]
    if (oldJob === undefined) throw new Error('缺少演示提炼任务')
    let resolvePages: (value: readonly AgentMemoryPage[]) => void = () => {}
    let resolveJob: (value: AgentMemoryExtraction) => void = () => {}
    vi.spyOn(adapter, 'listPages').mockImplementation((spaceId) => spaceId === 'space-1'
      ? new Promise((resolve) => { resolvePages = resolve })
      : Promise.resolve([]))
    vi.spyOn(adapter, 'getExtraction').mockImplementation(() => new Promise((resolve) => { resolveJob = resolve }))
    const gateway = makeGateway(adapter)
    const stalePages = useAgentMemoryStore.getState().loadPages(gateway, 'space-1')
    await useAgentMemoryStore.getState().loadPages(gateway, 'space-2')
    const staleJob = useAgentMemoryStore.getState().loadExtractionDetail(gateway, oldJob.id)
    useAgentMemoryStore.getState().clearExtractionDetail()
    resolvePages(oldPages)
    resolveJob(oldJob)
    await Promise.all([stalePages, staleJob])
    const state = useAgentMemoryStore.getState()
    expect(state.pagesSpaceId).toBe('space-2')
    expect(state.pages).toEqual([])
    expect(state.detailId).toBeUndefined()
    expect(state.detailJob).toBeUndefined()
  })
})

describe('候选与任务切片', () => {
  it('decideProposal：批准后候选终态并静默回读列表', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadProposals(gateway, { status: 'pending' })
    const decided = await useAgentMemoryStore.getState().decideProposal(gateway, 'prop-1', { decision: 'approved' })
    expect(decided.status).toBe('approved')
    const pending = useAgentMemoryStore.getState().proposals.filter((proposal) => proposal.status === 'pending')
    expect(pending.some((proposal) => proposal.id === 'prop-1')).toBe(false)
  })

  it('loadMoreExtractions：按游标去重追加，hasMore 收敛', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const jobs = await adapter.listExtractions()
    let call = 0
    vi.spyOn(adapter, 'listExtractions').mockImplementation(async (query) => {
      call += 1
      if (call === 1) return { items: jobs.items.slice(0, 2), nextCursor: '2', hasMore: true }
      if (query?.cursor === '2') return { items: jobs.items, nextCursor: '', hasMore: false }
      return { items: [], nextCursor: '', hasMore: false }
    })
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadExtractions(gateway)
    expect(useAgentMemoryStore.getState().extractions.length).toBe(2)
    expect(useAgentMemoryStore.getState().extractionsHasMore).toBe(true)
    await useAgentMemoryStore.getState().loadMoreExtractions(gateway)
    const ids = useAgentMemoryStore.getState().extractions.map((job) => job.id)
    expect(ids).toHaveLength(jobs.items.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(useAgentMemoryStore.getState().extractionsHasMore).toBe(false)
  })

  it('刷新列表后丢弃旧的后续页响应', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const jobs = await adapter.listExtractions()
    let resolveMore: (value: RuntimePage<AgentMemoryExtraction>) => void = () => {}
    const list = vi.spyOn(adapter, 'listExtractions')
      .mockResolvedValueOnce({ items: jobs.items.slice(0, 1), nextCursor: '1', hasMore: true })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMore = resolve }))
      .mockResolvedValueOnce({ items: [], nextCursor: '', hasMore: false })
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadExtractions(gateway)
    const stalePage = useAgentMemoryStore.getState().loadMoreExtractions(gateway)
    await useAgentMemoryStore.getState().loadExtractions(gateway)
    resolveMore(jobs)
    await stalePage
    expect(list).toHaveBeenCalledTimes(3)
    expect(useAgentMemoryStore.getState().extractions).toEqual([])
    expect(useAgentMemoryStore.getState().extractionsHasMore).toBe(false)
  })

  it('静默提炼轮询透传 signal，失败保留列表与详情并交给轮询退避', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadExtractions(gateway)
    const job = useAgentMemoryStore.getState().extractions[0]
    if (job === undefined) throw new Error('缺少演示提炼任务')
    await useAgentMemoryStore.getState().loadExtractionDetail(gateway, job.id)
    const previous = useAgentMemoryStore.getState()
    const list = vi.spyOn(adapter, 'listExtractions').mockRejectedValue(new Error('连接中断'))
    const detail = vi.spyOn(adapter, 'getExtraction').mockRejectedValue(new Error('连接中断'))
    const signal = new AbortController().signal
    await expect(useAgentMemoryStore.getState().loadExtractions(gateway, { silent: true, signal })).rejects.toThrow('连接中断')
    await expect(useAgentMemoryStore.getState().loadExtractionDetail(gateway, job.id, { silent: true, signal })).rejects.toThrow('连接中断')
    expect(list).toHaveBeenLastCalledWith(undefined, signal)
    expect(detail).toHaveBeenLastCalledWith(job.id, signal)
    const state = useAgentMemoryStore.getState()
    expect(state.extractionsStatus).toBe('ready')
    expect(state.detailStatus).toBe('ready')
    expect(state.extractions).toEqual(previous.extractions)
    expect(state.detailJob).toEqual(previous.detailJob)
  })

  it('runSearch：降级结果保留 reason；空关键词错误进入 errorMessage', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().runSearch(gateway, 'space-1', '端口 映射')
    const state = useAgentMemoryStore.getState()
    expect(state.searchStatus).toBe('ready')
    expect(state.searchResult?.degraded).toBe(true)
    expect(typeof state.searchResult?.reason).toBe('string')

    await useAgentMemoryStore.getState().runSearch(gateway, 'space-1', '   ')
    expect(useAgentMemoryStore.getState().searchStatus).toBe('error')
    expect(useAgentMemoryStore.getState().searchErrorMessage).toContain('Wiki 搜索内容不能为空')
  })
})

describe('索引与配置切片', () => {
  it('loadIndexStatus：每条配置一行；loadEmbeddingRequests 用量未知保持未知', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    await useAgentMemoryStore.getState().loadIndexStatus(gateway, 'space-1')
    expect(useAgentMemoryStore.getState().indexStatuses.length).toBe(2)
    await useAgentMemoryStore.getState().loadEmbeddingRequests(gateway)
    const unknown = useAgentMemoryStore.getState().requests.find((item) => item.usage.promptTokens === undefined)
    expect(unknown?.usage.promptTokens).toBeUndefined()
  })

  it('createEmbeddingProfile：成功通知；维度越界错误上抛不通知成功', async () => {
    const adapter = new AgentMemoryMockAdapter()
    const gateway = makeGateway(adapter)
    const created = await useAgentMemoryStore.getState().createEmbeddingProfile(gateway, {
      name: 'store 向量', baseUrl: 'https://embedding.example.test/v1', model: 'm', dimensions: 64, active: false,
    })
    expect(created.revision).toBe(1)
    expect(Object.hasOwn(created, 'credential')).toBe(false)
    await expect(useAgentMemoryStore.getState().createEmbeddingProfile(gateway, {
      name: '越界', baseUrl: 'https://embedding.example.test/v1', model: 'm', dimensions: 9999, active: false,
    })).rejects.toThrow('Embedding 配置名称、模型或维度无效')
    expect(useNotificationStore.getState().notifications.filter((item) => item.tone === 'success')).toHaveLength(1)
  })
})

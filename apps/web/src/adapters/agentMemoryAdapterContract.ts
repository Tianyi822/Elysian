import { describe, expect, it } from 'vitest'
import type {
  AgentCreateMemoryExtractionInput,
  AgentMemoryPage,
  AgentMemoryProposal,
  AgentMemorySpace,
} from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../contracts/adapters'

/*
 * 长期记忆域 adapter 的可复用契约断言（照 agentWorkflowsAdapterContract 先例）。
 * 断言只依赖 AgentMemoryAdapter 接口与服务端语义（memory_routes.go / wiki_store.go），
 * 不依赖 mock 细节：mock 实现与 HTTP 实现（预置响应桩）对同一套线性场景各跑一遍，
 * 即「mock 可替换」的验证方式。场景顺序是脚本化的——写操作会改状态，
 * 两个实现必须按同一次序执行才能对齐。
 */

/** 契约场景用页面样例（HTTP 桩的响应体；mock 种子含同形事实）。 */
export const MEMORY_CONTRACT_PAGE: AgentMemoryPage = {
  id: 'page-b',
  spaceId: 'space-1',
  slug: 'reference/port-map',
  revision: 1,
  title: '端口映射约定',
  markdown: '# 端口映射约定\n\n面板前端固定 48100，后端固定 48101。',
  kind: 'reference',
  status: 'active',
  digest: 'a'.repeat(64),
  createdAt: '2026-10-10T00:00:49Z',
  updatedAt: '2026-10-10T00:00:49Z',
  evidence: [],
  sources: [],
  links: [],
  tags: ['网络'],
}

export const MEMORY_CONTRACT_SPACES: readonly AgentMemorySpace[] = [
  { id: 'space-global', revision: 1, name: '全局运维常识', kind: 'global', createdAt: '2026-10-10T00:00:07Z' },
  { id: 'space-1', revision: 1, name: '容器运维', kind: 'business', createdAt: '2026-10-10T00:00:14Z' },
]

/** 契约场景的页面输入：正文、slug、类型都合法，16 KiB 以内。 */
export const MEMORY_CONTRACT_PAGE_INPUT = {
  slug: 'contract/new-page',
  title: '契约新建页面',
  markdown: '# 契约新建页面\n\n由契约场景创建。',
  kind: 'reference' as const,
}

const OVERSIZE_MARKDOWN = `# 超限\n\n${'x'.repeat(16 * 1024)}`

/** 同时携带 runId 与 workflowId 的非法输入：联合类型不含此形状，用双重断言模拟手误。 */
const BOTH_SOURCES_INPUT: AgentCreateMemoryExtractionInput = {
  requestId: 'contract-ext-2',
  runId: 'run-seed-1',
  workflowId: 'wf-seed-1',
} as unknown as AgentCreateMemoryExtractionInput

export function runAgentMemoryAdapterContract(name: string, make: () => AgentMemoryAdapter): void {
  describe(`${name} 长期记忆 adapter 契约`, () => {
    it('listSpaces：全局空间唯一，业务空间在列', async () => {
      const spaces = await make().listSpaces()
      expect(spaces.filter((space) => space.kind === 'global')).toHaveLength(1)
      expect(spaces.some((space) => space.id === 'space-1' && space.kind === 'business')).toBe(true)
      for (const space of spaces) {
        expect(space.revision).toBeGreaterThanOrEqual(1)
        expect(typeof space.createdAt).toBe('string')
      }
    })

    it('createSpace：业务空间可建（修订 1）；重复建全局透传「全局 Wiki 空间已存在」', async () => {
      const adapter = make()
      const created = await adapter.createSpace({ name: '契约业务空间', kind: 'business' })
      expect(created.kind).toBe('business')
      expect(created.revision).toBe(1)
      await expect(adapter.createSpace({ name: '再来一个全局', kind: 'global' }))
        .rejects.toThrow('全局 Wiki 空间已存在')
    })

    it('renameSpace：expectedRevision CAS 冲突透传中文错误，成功后修订 +1', async () => {
      const adapter = make()
      await expect(adapter.renameSpace('space-1', 99, '新名字')).rejects.toThrow('记忆空间版本已变化')
      const renamed = await adapter.renameSpace('space-1', 1, '容器运维（更名）')
      expect(renamed.revision).toBe(2)
      expect(renamed.name).toBe('容器运维（更名）')
    })

    it('listPages：默认不含撤回页；includeWithdrawn 含 withdrawn 标记（withdrawnAt）', async () => {
      const adapter = make()
      const active = await adapter.listPages('space-1')
      expect(active.length).toBeGreaterThanOrEqual(3)
      expect(active.every((page) => page.status === 'active')).toBe(true)
      const all = await adapter.listPages('space-1', true)
      const withdrawn = all.filter((page) => page.status === 'withdrawn')
      expect(withdrawn.length).toBeGreaterThanOrEqual(1)
      for (const page of withdrawn) expect(typeof page.withdrawnAt).toBe('string')
    })

    it('getPageRevision：按精确修订号读取历史（只读）', async () => {
      const page = await make().getPageRevision('space-1', 'page-a', 1)
      expect(page.id).toBe('page-a')
      expect(page.revision).toBe(1)
      expect(page.markdown).not.toContain('观察五分钟')
      await expect(make().getPageRevision('space-1', 'page-a', 99)).rejects.toThrow('Wiki 页面修订不存在')
    })

    it('createPage：合法输入落修订 1；正文超过 16 KiB 在发出前拦截', async () => {
      const adapter = make()
      const created = await adapter.createPage('space-1', MEMORY_CONTRACT_PAGE_INPUT)
      expect(created.revision).toBe(1)
      expect(created.status).toBe('active')
      expect(created.slug).toBe('contract/new-page')
      await expect(adapter.createPage('space-1', { ...MEMORY_CONTRACT_PAGE_INPUT, slug: 'contract/oversize', markdown: OVERSIZE_MARKDOWN }))
        .rejects.toThrow('Wiki 页面 slug、标题或正文无效')
    })

    it('updatePage：expectedRevision 随 Input 体提交；冲突与成功路径的修订语义', async () => {
      const adapter = make()
      await expect(adapter.updatePage('space-1', 'page-a', {
        ...MEMORY_CONTRACT_PAGE_INPUT,
        slug: 'runbook/container-restart',
        expectedRevision: 99,
      })).rejects.toThrow('Wiki 页面版本已变化')
      const current = await adapter.getPage('space-1', 'page-a')
      const updated = await adapter.updatePage('space-1', 'page-a', {
        slug: 'runbook/container-restart',
        title: current.title,
        markdown: `${current.markdown}\n\n契约场景追加一段。`,
        kind: current.kind,
        expectedRevision: current.revision,
      })
      expect(updated.revision).toBe(current.revision + 1)
      expect(updated.status).toBe('active')
    })

    it('withdrawPage：返回 withdrawn 与 withdrawnAt，列表随后可见', async () => {
      const adapter = make()
      const created = await adapter.createPage('space-1', { ...MEMORY_CONTRACT_PAGE_INPUT, slug: 'contract/withdraw-me' })
      const withdrawn = await adapter.withdrawPage('space-1', created.id, created.revision)
      expect(withdrawn.status).toBe('withdrawn')
      expect(typeof withdrawn.withdrawnAt).toBe('string')
      expect(withdrawn.revision).toBe(created.revision + 1)
      const all = await adapter.listPages('space-1', true)
      const row = all.find((page) => page.id === created.id)
      expect(row?.status).toBe('withdrawn')
      await expect(adapter.withdrawPage('space-1', created.id, created.revision))
        .rejects.toThrow('Wiki 页面版本已变化')
    })

    it('search：命中携带 page/score/method；降级时给出 reason', async () => {
      const result = await make().search('space-1', '端口 映射')
      expect(result.items.length).toBeGreaterThanOrEqual(1)
      for (const hit of result.items) {
        expect(typeof hit.score).toBe('number')
        expect(['sqlite-text', 'hybrid-rrf']).toContain(hit.method)
        expect(typeof hit.page.id).toBe('string')
      }
      if (result.degraded) expect(typeof result.reason).toBe('string')
      await expect(make().search('space-1', '   ')).rejects.toThrow('Wiki 搜索内容不能为空')
    })

    it('importPages：markdown 文件产出 pending 候选（markdown-import 来源）', async () => {
      const adapter = make()
      const proposals = await adapter.importPages('space-1', { 'notes/imported.md': '# 导入笔记\n\n契约场景导入的内容。' })
      expect(proposals).toHaveLength(1)
      expect(proposals[0]?.status).toBe('pending')
      expect(proposals[0]?.originKind).toBe('markdown-import')
      expect(proposals[0]?.page.slug).toBe('notes/imported')
    })

    it('decideProposal：批准即发布为页面修订（列表出现该页）；同决定重复幂等；改决定被拒', async () => {
      const adapter = make()
      const proposals = await adapter.importPages('space-1', { 'notes/decide.md': '# 决策笔记\n\n待批准。' })
      const target = proposals[0]
      if (target === undefined) throw new Error('导入未产出候选')
      const approved = await adapter.decideProposal(target.id, { decision: 'approved' })
      expect(approved.status).toBe('approved')
      expect(typeof approved.pageId).toBe('string')
      const pages = await adapter.listPages('space-1')
      expect(pages.some((page) => page.slug === 'notes/decide' && page.status === 'active')).toBe(true)
      const replay = await adapter.decideProposal(target.id, { decision: 'approved' })
      expect(replay.status).toBe('approved')
      await expect(adapter.decideProposal(target.id, { decision: 'rejected' })).rejects.toThrow('Wiki 候选已处理')
    })

    it('listProposals：按状态过滤生效', async () => {
      const adapter = make()
      const pending = await adapter.listProposals({ status: 'pending' })
      const rejected = await adapter.listProposals({ status: 'rejected' })
      expect(pending.every((proposal: AgentMemoryProposal) => proposal.status === 'pending')).toBe(true)
      expect(rejected.every((proposal: AgentMemoryProposal) => proposal.status === 'rejected')).toBe(true)
      expect(rejected.length).toBeGreaterThanOrEqual(1)
    })

    it('提炼任务：分页信封齐全，详情按 id 读取', async () => {
      const adapter = make()
      const list = await adapter.listExtractions({ limit: 2 })
      expect(typeof list.nextCursor).toBe('string')
      expect(typeof list.hasMore).toBe('boolean')
      expect(list.items.length).toBeGreaterThanOrEqual(1)
      for (const job of list.items) {
        expect(['extraction', 'embedding']).toContain(job.kind)
        expect(typeof job.spaceId).toBe('string')
        expect(Array.isArray(job.candidateIds)).toBe(true)
      }
      const detail = await adapter.getExtraction('ext-1')
      expect(detail.status).toBe('succeeded')
      expect(detail.candidateIds).toContain('prop-1')
      await expect(adapter.getExtraction('ext-missing')).rejects.toThrow('长期记忆提炼任务不存在')
    })

    it('手工提炼：requestId 幂等回读同一任务；runId/workflowId 互斥校验；无快照来源拒绝', async () => {
      const adapter = make()
      const first = await adapter.createExtraction({ requestId: 'contract-ext-1', runId: 'run-seed-1' })
      expect(first.originKind).toBe('manual')
      expect(['queued', 'running']).toContain(first.status)
      const replay = await adapter.createExtraction({ requestId: 'contract-ext-1', runId: 'run-seed-1' })
      expect(replay.id).toBe(first.id)
      await expect(adapter.createExtraction(BOTH_SOURCES_INPUT))
        .rejects.toThrow('手动提炼必须提供请求标识及唯一的成功运行或工作流编号')
      await expect(adapter.createExtraction({ requestId: 'contract-ext-3', runId: 'run-unknown' }))
        .rejects.toThrow('成功来源没有固定的长期记忆提炼快照，无法提炼')
    })

    it('索引状态：每条 Embedding 配置一行（数组）；stale 行给出未建满计数', async () => {
      const statuses = await make().indexStatus('space-1')
      expect(Array.isArray(statuses)).toBe(true)
      expect(statuses.length).toBeGreaterThanOrEqual(2)
      for (const status of statuses) {
        expect(['ready', 'stale']).toContain(status.status)
        expect(status.pages).toBeGreaterThanOrEqual(status.indexedPages)
        if (status.status === 'stale') expect(status.indexedPages).toBeLessThan(status.pages)
      }
      expect(statuses.some((status) => status.status === 'stale')).toBe(true)
    })

    it('重建索引：requestId 幂等返回同一 embedding 任务', async () => {
      const adapter = make()
      const first = await adapter.rebuildIndex('space-1', { requestId: 'contract-index-1', profileId: 'emb-1', profileRevision: 2 })
      expect(first.kind).toBe('embedding')
      expect(['queued', 'running', 'succeeded']).toContain(first.status)
      expect(first.embeddingProfile?.id).toBe('emb-1')
      const replay = await adapter.rebuildIndex('space-1', { requestId: 'contract-index-1', profileId: 'emb-1', profileRevision: 2 })
      expect(replay.id).toBe(first.id)
      await expect(adapter.rebuildIndex('space-1', { requestId: 'contract-index-1', profileId: 'emb-2', profileRevision: 1 }))
        .rejects.toThrow('索引重建请求标识已用于其他参数')
    })

    it('checkSpace：四组报告键齐全，种子里的过期页与失效来源可见', async () => {
      const report = await make().checkSpace('space-1')
      expect(Array.isArray(report.orphanPages)).toBe(true)
      expect(report.expiredPages).toContain('observation/backup-window')
      expect(report.invalidSources.some((entry) => entry.includes('page-gone'))).toBe(true)
    })

    it('exportSpace：files 含 index/changelog/sources 与逐页 Markdown', async () => {
      const exported = await make().exportSpace('space-1')
      expect(Object.keys(exported.files)).toContain('index.md')
      expect(Object.keys(exported.files)).toContain('changelog.md')
      expect(Object.keys(exported.files)).toContain('sources.json')
      expect(Object.keys(exported.files)).toContain('pages/page-a.md')
      expect(exported.files['pages/page-a.md']).toContain('# 容器重启手册')
    })

    it('Embedding 配置：列表不回显凭据；创建与 CAS 更新语义', async () => {
      const adapter = make()
      const profiles = await adapter.listEmbeddingProfiles()
      expect(profiles.length).toBeGreaterThanOrEqual(2)
      for (const profile of profiles) {
        expect(Object.hasOwn(profile, 'hasCredential')).toBe(true)
        expect(Object.hasOwn(profile, 'credential')).toBe(false)
      }
      const created = await adapter.createEmbeddingProfile({
        name: '契约向量配置',
        baseUrl: 'https://embedding.contract.test/v1',
        model: 'contract-embed',
        dimensions: 256,
        active: false,
      })
      expect(created.revision).toBe(1)
      expect(created.hasCredential).toBe(false)
      expect(Object.hasOwn(created, 'credential')).toBe(false)
      await expect(adapter.updateEmbeddingProfile(created.id, {
        name: '契约向量配置',
        baseUrl: 'https://embedding.contract.test/v1',
        model: 'contract-embed',
        dimensions: 256,
        active: false,
        expectedRevision: 99,
      })).rejects.toThrow('Embedding 配置已变化，请重新读取')
      const updated = await adapter.updateEmbeddingProfile(created.id, {
        name: '契约向量配置（启用）',
        baseUrl: 'https://embedding.contract.test/v1',
        model: 'contract-embed',
        dimensions: 256,
        active: true,
        expectedRevision: 1,
      })
      expect(updated.revision).toBe(2)
      expect(updated.active).toBe(true)
    })

    it('Embedding 配置校验：维度越界与非法地址透传中文错误', async () => {
      const adapter = make()
      await expect(adapter.createEmbeddingProfile({
        name: '越界维度', baseUrl: 'https://embedding.contract.test/v1', model: 'm', dimensions: 8193, active: false,
      })).rejects.toThrow('Embedding 配置名称、模型或维度无效')
      await expect(adapter.createEmbeddingProfile({
        name: '非法地址', baseUrl: 'not-a-url', model: 'm', dimensions: 8, active: false,
      })).rejects.toThrow('Embedding 服务地址必须是无凭据、查询参数或片段的 HTTP 地址')
    })

    it('Embedding 用量：分页信封齐全；未报告用量保持未知（不补零）', async () => {
      const result = await make().listEmbeddingRequests({ limit: 10 })
      expect(typeof result.nextCursor).toBe('string')
      expect(result.items.length).toBeGreaterThanOrEqual(1)
      const unknown = result.items.find((item) => item.usage.promptTokens === undefined)
      expect(unknown).toBeDefined()
      if (unknown !== undefined) expect(unknown.usage.promptTokens).toBeUndefined()
    })
  })
}

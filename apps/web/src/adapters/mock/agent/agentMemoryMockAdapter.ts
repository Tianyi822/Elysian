import type { AgentMemoryPage, AgentMemoryPageInput, AgentMemorySpace, AgentMemorySpaceSelection, AgentMemoryProposal, AgentMemoryExtraction, AgentMemorySourceInput, AgentMemorySourceResult, AgentWikiRef } from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../../contracts/agentMemory'
import type { ModelSettingsAdapter } from '../../../contracts/adapters'

const clone = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
const conflict = () => { throw new Error('页面修订已更新，请重新读取后确认；当前草稿已保留') }
/** 本地仅演示文档读写与历史，整理不调用模型、不伪造生成结果。 */
export class AgentMemoryMockAdapter implements AgentMemoryAdapter {
  private spaces: AgentMemorySpace[] = [{ id: 'wiki-global', revision: 1, name: '共享知识', kind: 'global', createdAt: '2026-10-20T00:00:00Z' }]
  private pages = new Map<string, AgentMemoryPage[]>()
  private selections = new Map<string, AgentMemorySpaceSelection>()
  private jobs: AgentMemoryExtraction[] = []
  private proposals: AgentMemoryProposal[] = []
  private sequence = 0
  constructor(private models: ModelSettingsAdapter) {}
  async listSpaces() { return clone(this.spaces) }
  async createSpace(input: { name: string; kind: 'business' | 'global' }) {
    if (!input.name.trim()) throw new Error('空间名称不能为空')
    if (input.kind === 'global' && this.spaces.some(s => s.kind === 'global')) throw new Error('共享空间已存在')
    const value: AgentMemorySpace = { ...input, name: input.name.trim(), id: `wiki-space-${++this.sequence}`, revision: 1, createdAt: now() }
    this.spaces.push(value); return clone(value)
  }
  async listPages(spaceId: string) { return clone([...this.pages.values()].flatMap(rows => rows.at(-1)?.spaceId === spaceId ? [rows.at(-1)!] : [])) }
  async getPage(spaceId: string, id: string) { const page = this.pages.get(id)?.at(-1); if (!page || page.spaceId !== spaceId) throw new Error('Wiki 页面不存在'); return clone(page) }
  private validate(input: AgentMemoryPageInput) {
    if (!input.slug.trim() || !input.title.trim()) throw new Error('页面标识与标题不能为空')
    if (new TextEncoder().encode(input.markdown).length > 16384) throw new Error('页面正文不能超过 16 KiB')
  }
  async createPage(spaceId: string, input: AgentMemoryPageInput) {
    this.validate(input)
    if (!this.spaces.some(space => space.id === spaceId)) throw new Error('Wiki 空间不存在')
    if ((await this.listPages(spaceId)).some(page => page.slug === input.slug)) throw new Error('页面标识已存在')
    const id = `wiki-page-${++this.sequence}`, timestamp = now()
    const page: AgentMemoryPage = { id, spaceId, slug: input.slug, title: input.title, markdown: input.markdown, kind: input.kind ?? 'reference', maintenance: input.maintenance ?? 'manual', revision: 1, status: 'active', digest: `demo-${id}-1`, createdAt: timestamp, updatedAt: timestamp, evidence: input.evidence ?? [], sources: input.sources ?? [], links: [...input.markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1]!), tags: input.tags, aliases: input.aliases }
    this.pages.set(id, [page]); return clone(page)
  }
  async updatePage(spaceId: string, id: string, input: AgentMemoryPageInput) {
    this.validate(input)
    const current = await this.getPage(spaceId, id)
    if (current.kind === 'sources') throw new Error('导入原文不可改写；请导入新的来源')
    if (current.revision !== input.expectedRevision) conflict()
    if (current.status === 'withdrawn') throw new Error('已撤回页面不能修改')
    const { expectedRevision: _expectedRevision, ...content } = input
    const next: AgentMemoryPage = { ...current, ...content, maintenance: input.maintenance ?? 'manual', revision: current.revision + 1, digest: `demo-${id}-${current.revision + 1}`, updatedAt: now(), links: [...input.markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1]!) }
    this.pages.get(id)!.push(next); return clone(next)
  }
  async withdrawPage(spaceId: string, id: string, expectedRevision: number) { const page = await this.getPage(spaceId, id); if (page.revision !== expectedRevision) conflict(); const next: AgentMemoryPage = { ...page, status: 'withdrawn', withdrawnAt: now(), updatedAt: now(), revision: page.revision + 1, digest: `demo-${id}-${page.revision + 1}` }; this.pages.get(id)!.push(next); return clone(next) }
  async listRevisions(spaceId: string, id: string) { await this.getPage(spaceId, id); return clone([...(this.pages.get(id) ?? [])].reverse()) }
  async getReference(ref: AgentWikiRef) { const current = this.pages.get(ref.pageId)?.at(-1); if (!current) throw new Error('Wiki 页面不存在'); const page = await this.getRevision(current.spaceId, ref.pageId, ref.revision); if (page.digest !== ref.digest) throw new Error('Wiki 来源摘要不匹配'); return page }
  async getRevision(spaceId: string, id: string, revision: number) { await this.getPage(spaceId, id); const page = this.pages.get(id)!.find(page => page.revision === revision); if (!page) throw new Error('Wiki 修订不存在'); return clone(page) }
  async search(spaceId: string, query: string) { const pages = await this.listPages(spaceId); return { items: pages.filter(page => page.status === 'active' && `${page.title}\n${page.markdown}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(page => ({ page, score: 1, method: 'sqlite-text' as const })), degraded: false } }
  async listProposals(spaceId: string) { return Promise.all(this.proposals.filter(item => item.spaceId === spaceId && item.status === 'pending').map(async item => ({ ...clone(item), ...(item.pageId ? { currentPage: await this.getPage(spaceId, item.pageId) } : {}) }))) }
  async decideProposal(id: string, decision: 'approved' | 'rejected', expectedRevision?: number) { const proposal = this.proposals.find(item => item.id === id); if (!proposal) throw new Error('待确认记录不存在'); if (proposal.status !== 'pending') { if (proposal.status === decision) return clone(proposal); throw new Error('待确认记录已处理，请重新读取') }; if (decision === 'approved') { if (proposal.pageId) await this.updatePage(proposal.spaceId, proposal.pageId, { ...proposal.page, expectedRevision: expectedRevision ?? proposal.page.expectedRevision }); else { if (expectedRevision !== undefined && expectedRevision !== 0) conflict(); await this.createPage(proposal.spaceId, proposal.page) } }; proposal.status = decision; return clone(proposal) }
  async listExtractions(cursor = '') { const offset = Number(cursor) || 0; const items = clone(this.jobs.slice(offset, offset + 50)); return { items, hasMore: offset + 50 < this.jobs.length, nextCursor: String(offset + items.length) } }
  async getExtraction(id: string) { const job = this.jobs.find(item => item.id === id); if (!job) throw new Error('整理记录不存在'); return clone(job) }
  async importSource(spaceId: string, input: AgentMemorySourceInput): Promise<AgentMemorySourceResult> {
    const existing = this.jobs.find(job => job.originId === input.requestId)
    if (existing) return { source: await this.getPage(spaceId, existing.sources[0]!.pageId), job: clone(existing) }
    if (new TextEncoder().encode(input.text).length > 16384 || !input.text.trim()) throw new Error('资料正文不能为空且不能超过 16 KiB')
    const model = (await this.models.listModelProfiles()).find(model => model.id === input.modelProfileId && model.revision === input.modelProfileRevision && model.active && model.hasCredential && model.capabilities.text && model.capabilities.tools)
    if (!model) throw new Error('请选择当前可用且支持文本与工具调用的模型')
    const source = await this.createPage(spaceId, { slug: `source-${++this.sequence}`, title: input.title, markdown: input.text, kind: 'sources', maintenance: 'manual' })
    const job: AgentMemoryExtraction = { id: `wiki-job-${++this.sequence}`, kind: 'extraction', strategy: 'navigation/v1', originKind: 'source', originId: input.requestId, spaceId, status: 'interrupted', generation: 0, model, createdAt: now(), endedAt: now(), usage: {}, estimatedTokens: 0, candidateIds: [], sources: [{ pageId: source.id, revision: source.revision, digest: source.digest }], publishedRefs: [], error: { code: 'demo-no-generation', message: '本地演示已保存原文；自动整理需要真实后端与模型，未生成页面。' } }
    this.jobs.unshift(job); return { source, job: clone(job) }
  }
  async getSelection(id: string) { return clone(this.selections.get(id) ?? { spaceId: '', includeGlobal: true }) }
  async setSelection(id: string, selection: AgentMemorySpaceSelection) { if (selection.spaceId && !this.spaces.some(space => space.id === selection.spaceId)) throw new Error('Wiki 空间不存在'); this.selections.set(id, clone(selection)); return clone(selection) }
}

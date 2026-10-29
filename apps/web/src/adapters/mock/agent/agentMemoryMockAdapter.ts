import type { AgentMemoryPage, AgentMemoryPageInput, AgentMemorySpace, AgentWikiRef } from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../../contracts/agentMemory'

const clone = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
const conflict = () => { throw new Error('页面修订已更新，请重新读取后确认；当前草稿已保留') }
/** 本地仅演示文档读写与历史，不提供新建、导入或整理入口。 */
export class AgentMemoryMockAdapter implements AgentMemoryAdapter {
  private spaces: AgentMemorySpace[] = [{ id: 'wiki-global', revision: 1, name: '共享知识', kind: 'global', createdAt: '2026-10-20T00:00:00Z' }]
  private pages = new Map<string, AgentMemoryPage[]>()
  private sequence = 0
  async listSpaces() { return clone(this.spaces) }
  /** 仅供测试准备既有数据，不属于页面 adapter 接口。 */
  async seedSpace(input: { name: string; kind: 'business' | 'global' }) {
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
  async seedPage(spaceId: string, input: AgentMemoryPageInput) {
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
  async seedWithdrawal(spaceId: string, id: string, expectedRevision: number) { const page = await this.getPage(spaceId, id); if (page.revision !== expectedRevision) conflict(); const next: AgentMemoryPage = { ...page, status: 'withdrawn', withdrawnAt: now(), updatedAt: now(), revision: page.revision + 1, digest: `demo-${id}-${page.revision + 1}` }; this.pages.get(id)!.push(next); return clone(next) }
  async listRevisions(spaceId: string, id: string) { await this.getPage(spaceId, id); return clone([...(this.pages.get(id) ?? [])].reverse()) }
  async getReference(ref: AgentWikiRef) { const current = this.pages.get(ref.pageId)?.at(-1); if (!current) throw new Error('Wiki 页面不存在'); const page = await this.getRevision(current.spaceId, ref.pageId, ref.revision); if (page.digest !== ref.digest) throw new Error('Wiki 来源摘要不匹配'); return page }
  async getRevision(spaceId: string, id: string, revision: number) { await this.getPage(spaceId, id); const page = this.pages.get(id)!.find(page => page.revision === revision); if (!page) throw new Error('Wiki 修订不存在'); return clone(page) }
}

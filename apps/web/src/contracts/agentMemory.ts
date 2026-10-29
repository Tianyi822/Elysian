import type { AgentMemorySpace, AgentMemoryPage, AgentMemoryPageInput, AgentWikiRef } from '@elysian/contracts'

/** Wiki 浏览、人工编辑与历史引用共用的同源接口。 */
export interface AgentMemoryAdapter {
  listSpaces(signal?: AbortSignal): Promise<readonly AgentMemorySpace[]>
  listPages(spaceId: string, signal?: AbortSignal): Promise<readonly AgentMemoryPage[]>
  getPage(spaceId: string, pageId: string, signal?: AbortSignal): Promise<AgentMemoryPage>
  updatePage(spaceId: string, pageId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage>
  getReference(ref: AgentWikiRef, signal?: AbortSignal): Promise<AgentMemoryPage>
  getRevision(spaceId: string, pageId: string, revision: number, signal?: AbortSignal): Promise<AgentMemoryPage>
}

import type {
  AgentMemorySpace, AgentMemorySpaceInput, AgentMemorySpaceSelection, AgentMemoryPage,
  AgentMemoryPageInput, AgentMemoryProposal, AgentMemorySearchResult, AgentMemoryExtraction,
  AgentMemorySourceInput, AgentMemorySourceResult, AgentWikiRef, RuntimePage,
} from '@elysian/contracts'

/** Wiki 文档工作台与聊天共用的同源记忆接缝。 */
export interface AgentMemoryAdapter {
  listSpaces(signal?: AbortSignal): Promise<readonly AgentMemorySpace[]>
  createSpace(input: AgentMemorySpaceInput): Promise<AgentMemorySpace>
  listPages(spaceId: string, signal?: AbortSignal): Promise<readonly AgentMemoryPage[]>
  getPage(spaceId: string, pageId: string, signal?: AbortSignal): Promise<AgentMemoryPage>
  createPage(spaceId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage>
  updatePage(spaceId: string, pageId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage>
  withdrawPage(spaceId: string, pageId: string, expectedRevision: number): Promise<AgentMemoryPage>
  listRevisions(spaceId: string, pageId: string, signal?: AbortSignal): Promise<readonly AgentMemoryPage[]>
  getReference(ref: AgentWikiRef, signal?: AbortSignal): Promise<AgentMemoryPage>
  getRevision(spaceId: string, pageId: string, revision: number, signal?: AbortSignal): Promise<AgentMemoryPage>
  search(spaceId: string, query: string, signal?: AbortSignal): Promise<AgentMemorySearchResult>
  listProposals(spaceId: string, signal?: AbortSignal): Promise<readonly AgentMemoryProposal[]>
  decideProposal(id: string, decision: 'approved' | 'rejected', expectedRevision?: number): Promise<AgentMemoryProposal>
  listExtractions(cursor?: string, signal?: AbortSignal): Promise<RuntimePage<AgentMemoryExtraction>>
  getExtraction(id: string, signal?: AbortSignal): Promise<AgentMemoryExtraction>
  importSource(spaceId: string, input: AgentMemorySourceInput): Promise<AgentMemorySourceResult>
  getSelection(sessionId: string, signal?: AbortSignal): Promise<AgentMemorySpaceSelection>
  setSelection(sessionId: string, selection: AgentMemorySpaceSelection): Promise<AgentMemorySpaceSelection>
}

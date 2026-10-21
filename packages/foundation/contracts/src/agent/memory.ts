import type { RuntimeFailure, RuntimeMemoryStatus, RuntimeRunStatus } from './runtime.ts'
import type { AgentModelProfile, AgentModelUsage } from './sessions.ts'

export const AGENT_MEMORY_PAGE_KINDS = ['reference', 'preference', 'convention', 'experience', 'decision', 'runbook', 'observation', 'index', 'changelog', 'sources'] as const
export type AgentMemoryPageKind = (typeof AGENT_MEMORY_PAGE_KINDS)[number]
export const AGENT_MEMORY_PAGE_KIND_LABELS: Record<AgentMemoryPageKind, string> = {
  reference: '参考资料', preference: '用户偏好', convention: '项目约定', experience: '操作经验', decision: '决策', runbook: '操作手册', observation: '观测事实', index: '索引', changelog: '变更记录', sources: '来源',
}
export type AgentMemorySpace = { id: string; revision: number; name: string; kind: 'business' | 'global'; createdAt: string }
export type AgentMemorySpaceInput = Pick<AgentMemorySpace, 'name' | 'kind'>
export type AgentMemorySpaceSelection = { spaceId: string; includeGlobal: boolean }
/** 引用整页不可变修订；digest 与 revision 由父进程核验。 */
export type AgentWikiRef = { pageId: string; revision: number; digest: string }
export type AgentMemoryEvidence = {
  id: string
  kind: string
  runId?: string
  eventSeq?: string
  uri?: string
  text: string
  createdAt: string
  digest: string
  originalCleared: boolean
}
export type AgentMemoryMaintenance = 'automatic' | 'manual'
export type AgentMemoryPage = {
  maintenance?: AgentMemoryMaintenance
  id: string
  spaceId: string
  slug: string
  revision: number
  title: string
  markdown: string
  kind: AgentMemoryPageKind
  status: 'active' | 'withdrawn'
  digest: string
  createdAt: string
  updatedAt: string
  expiresAt?: string
  withdrawnAt?: string
  evidence: readonly AgentMemoryEvidence[]
  sources: readonly AgentWikiRef[]
  links: readonly string[]
  tags?: readonly string[]
  aliases?: readonly string[]
}
export type AgentMemoryPageInput = {
  maintenance?: AgentMemoryMaintenance
  expectedRevision?: number
  slug: string
  title: string
  markdown: string
  kind?: AgentMemoryPageKind
  expiresAt?: string
  evidence?: readonly AgentMemoryEvidence[]
  sources?: readonly AgentWikiRef[]
  tags?: readonly string[]
  aliases?: readonly string[]
}
export const AGENT_MEMORY_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'invalidated'] as const
export type AgentMemoryProposalStatus = (typeof AGENT_MEMORY_PROPOSAL_STATUSES)[number]
export const AGENT_MEMORY_PROPOSAL_STATUS_LABELS: Record<AgentMemoryProposalStatus, string> = {
  pending: '待确认', approved: '已采纳', rejected: '已拒绝', invalidated: '来源失效',
}
export type AgentMemoryProposal = {
  currentPage?: AgentMemoryPage
  reason?: string
  id: string
  spaceId: string
  pageId?: string
  status: AgentMemoryProposalStatus
  originKind: string
  originId: string
  createdAt: string
  decidedAt?: string
  page: AgentMemoryPageInput
}
export type AgentMemoryProposalDecisionInput = { decision: 'approved' | 'rejected'; expectedRevision?: number }
export type AgentMemorySearchHit = { page: AgentMemoryPage; score: number; method: 'sqlite-text' | 'hybrid-rrf' }
export type AgentMemorySearchResult = { items: readonly AgentMemorySearchHit[]; degraded: boolean; reason?: string }
export type AgentMemoryChecks = { orphanPages: readonly string[]; brokenLinks: readonly string[]; expiredPages: readonly string[]; invalidSources: readonly string[] }
export type AgentMemoryExport = { files: Readonly<Record<string, string>> }
/** Embedding 与对话模型分开配置；公开修订不包含凭据。 */
export type AgentEmbeddingProfile = {
  id: string
  revision: number
  name: string
  baseUrl: string
  model: string
  dimensions: number
  active: boolean
  hasCredential: boolean
}
export type AgentEmbeddingProfileInput = Omit<AgentEmbeddingProfile, 'id' | 'revision' | 'hasCredential'> & { credential?: string }
export type AgentUpdateEmbeddingProfileInput = AgentEmbeddingProfileInput & { expectedRevision: number }
export type AgentMemoryIndexInput = { requestId: string; profileId: string; profileRevision: number }
export type AgentCreateMemoryExtractionInput = { requestId: string } & ({ runId: string; workflowId?: never } | { runId?: never; workflowId: string })
export type AgentMemoryIndexStatus = { profile: AgentEmbeddingProfile; pages: number; indexedPages: number; status: 'ready' | 'stale' }
/** 索引和查询的独立账本；不返回正文、查询原文、向量或凭据。未报告的用量保持未知。 */
export type AgentEmbeddingRequest = {
  id: string
  profileId: string
  profileRevision: number
  purpose: 'index' | 'query'
  jobId?: string
  page?: AgentWikiRef
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  inputBytes: number
  inputDigest: string
  estimatedTokens: number
  usage: AgentModelUsage
  startedAt: string
  endedAt?: string
  error?: RuntimeFailure
}
/** 输入原文与原始模型响应只在父端保存，公开任务不携带这两个字段。 */
export type AgentMemoryExtraction = {
  id: string
  kind: 'extraction' | 'embedding'
  strategy?: 'navigation/v1'
  publishedRefs?: readonly AgentWikiRef[]
  originKind: string
  originId: string
  spaceId: string
  status: RuntimeRunStatus
  memoryStatus?: RuntimeMemoryStatus
  taskId?: string
  runId?: string
  workflowId?: string
  generation: number
  embeddingProfile?: AgentEmbeddingProfile
  model: AgentModelProfile
  createdAt: string
  startedAt?: string
  endedAt?: string
  usage: AgentModelUsage
  estimatedTokens: number
  error?: RuntimeFailure
  candidateIds: readonly string[]
  sources: readonly AgentWikiRef[]
}

export type AgentMemoryPageSummary = Omit<AgentMemoryPage, 'markdown' | 'evidence'> & { summary: string }
export type AgentMemoryDirectory = { items: readonly AgentMemoryPageSummary[]; nextCursor?: string }
export type AgentMemoryPageRead = { page: AgentMemoryPageSummary; markdown: string; offset: number; nextOffset?: number; totalBytes: number }
export type AgentMemorySourceInput = { requestId: string; title: string; filename?: string; text: string; modelProfileId: string; modelProfileRevision: number }
export type AgentMemorySourceResult = { source: AgentMemoryPage; job: AgentMemoryExtraction }

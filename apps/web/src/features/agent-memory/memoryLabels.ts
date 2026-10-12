import type { AgentMemoryExtraction, AgentMemoryPage, AgentMemoryProposal } from '@elysian/contracts'

/*
 * 长期记忆页的本地标签与格式工具。取值在契约里的（页面类型、候选状态）用契约
 * 标签表；契约未提供中文标签的（页面状态、任务种类、来源种类、memoryStatus、
 * 检索方法）在本模块登记，一处维护。
 */

export type AgentMemoryTab = 'pages' | 'search' | 'proposals' | 'extractions' | 'embeddings' | 'checks'

export const AGENT_MEMORY_TABS: readonly { value: AgentMemoryTab; label: string }[] = [
  { value: 'pages', label: '页面' },
  { value: 'search', label: '搜索' },
  { value: 'proposals', label: '提炼候选' },
  { value: 'extractions', label: '提炼任务' },
  { value: 'embeddings', label: 'Embedding 与索引' },
  { value: 'checks', label: '检查' },
]

export const MEMORY_PAGE_STATUS_LABELS: Record<AgentMemoryPage['status'], string> = {
  active: '生效中',
  withdrawn: '已撤回',
}

export const MEMORY_PAGE_STATUS_TONES: Record<AgentMemoryPage['status'], 'success' | 'neutral'> = {
  active: 'success',
  withdrawn: 'neutral',
}

export const MEMORY_JOB_KIND_LABELS: Record<AgentMemoryExtraction['kind'], string> = {
  extraction: '记忆提炼',
  embedding: '索引重建',
}

export const MEMORY_ORIGIN_KIND_LABELS: Record<string, string> = {
  run: 'Agent 运行',
  workflow: '工作流',
  manual: '手工提交',
  space: '空间索引',
  'markdown-import': 'Markdown 导入',
  extraction: '记忆提炼',
}

export const MEMORY_STATUS_LABELS: Record<NonNullable<AgentMemoryExtraction['memoryStatus']>, string> = {
  unchanged: '记忆未变',
  updated: '记忆已更新',
  stale: '记忆过期',
  invalidated: '记忆失效',
}

export const MEMORY_SEARCH_METHOD_LABELS: Record<'sqlite-text' | 'hybrid-rrf', string> = {
  'sqlite-text': 'SQLite 全文',
  'hybrid-rrf': '混合检索（RRF）',
}

export const MEMORY_EMBEDDING_PURPOSE_LABELS: Record<'index' | 'query', string> = {
  index: '建索引',
  query: '查询',
}

/** 候选无效化提示：来源撤回后的关联文案（与撤回确认同口径）。 */
export const MEMORY_PROPOSAL_INVALIDATED_NOTE = '来源页面已撤回，候选被同事务标记为失效，不能发布。'

/** Markdown 正文的字节计数（16 KiB 上限的计数器口径）。 */
export function formatMarkdownBytes(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown).length
  const limit = 16 * 1024
  return `${(bytes / 1024).toFixed(1)} / ${(limit / 1024).toFixed(0)} KiB`
}

export function markdownExceedsLimit(markdown: string): boolean {
  return new TextEncoder().encode(markdown).length > 16 * 1024
}

/** 用量渲染：缺失保持「未知」，不补零。 */
export function formatUsageTokens(value: number | undefined): string {
  return value === undefined ? '未知' : value.toLocaleString('zh-Hans-CN')
}

export function proposalTargetLabel(proposal: AgentMemoryProposal): string {
  return proposal.pageId === undefined
    ? `新页 · ${proposal.page.slug}`
    : `修订 ${proposal.page.expectedRevision ?? 0} → ${(proposal.page.expectedRevision ?? 0) + 1} · ${proposal.page.slug}`
}

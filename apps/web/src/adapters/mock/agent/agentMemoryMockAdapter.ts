import type {
  AgentCreateMemoryExtractionInput,
  AgentEmbeddingProfile,
  AgentEmbeddingRequest,
  AgentEmbeddingProfileInput,
  AgentMemoryChecks,
  AgentMemoryExtraction,
  AgentMemoryExport,
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
  AgentModelUsage,
  AgentUpdateEmbeddingProfileInput,
  RuntimePage,
} from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../../contracts/adapters'
import { AGENT_MEMORY_PAGE_KINDS } from '@elysian/contracts'
import {
  MEMORY_DEMO_MODEL,
  MEMORY_JOB_STEP_MS,
  MEMORY_SEED_BASE_MS,
  manualExtractionCandidate,
  memoryDigest,
  nextMemoryId,
  nextMemoryStamp,
  observationExpiry,
  readAgentMemoryDataset,
  resetAgentMemoryData,
  scheduleMemoryTimer,
  sourceReferencesPage,
} from './agentMemoryData'

/*
 * 长期记忆域 mock：确定性状态机，镜像服务端语义（wiki_store.go / wiki_jobs.go /
 * wiki_indexes.go / embedding.go 的校验、错误文案与状态迁移）。与 HTTP 实现对同一套
 * 契约断言复跑（agentMemoryAdapterContract）。写操作只改内存数据集，刷新回种子。
 * available:false 表示未接真实读取接口（演示语义，不代表服务端健康）。
 */

/** 与服务端 requestPattern 同口径（manager.go）；仅校验白名单提交的幂等键。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const WIKI_PAGE_BYTES = 16 * 1024
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const LINK_PATTERN = /\[\[([^\]]+)\]\]/g

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

function validText(value: string, limit: number): boolean {
  return value.trim() !== '' && value.length <= limit && !value.includes('\x00')
}

function spaceNotFound(): Error {
  return new Error('Wiki 空间不存在')
}

function findSpace(spaceId: string): AgentMemorySpace | undefined {
  return readAgentMemoryDataset().spaces.find((space) => space.id === spaceId)
}

function findPage(pageId: string): AgentMemoryPage | undefined {
  return readAgentMemoryDataset().pages.find((page) => page.id === pageId)
}

function activePages(spaceId: string): readonly AgentMemoryPage[] {
  return readAgentMemoryDataset().pages.filter((page) => page.spaceId === spaceId && page.status === 'active')
}

/** 演示时钟：由数据集序号推导的确定性“当前时间”（不读系统时钟）。 */
function virtualNowMs(): number {
  const dataset = readAgentMemoryDataset()
  return MEMORY_SEED_BASE_MS + (dataset.sequence + 40) * 7_000
}

function extractLinks(markdown: string): readonly string[] {
  const seen = new Set<string>()
  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const value = match[1]?.trim() ?? ''
    if (value !== '') seen.add(value)
  }
  return [...seen].sort()
}

/** 镜像 validateWikiInput（wiki_store.go:30-67）的前端侧校验，错误文案与服务端一致。 */
function validatePageInput(input: AgentMemoryPageInput): void {
  const slug = input.slug ?? ''
  if (!SLUG_PATTERN.test(slug) || slug.includes('..') || slug.includes('//') ||
    !validText(input.title ?? '', 512) ||
    byteLength(input.markdown ?? '') > WIKI_PAGE_BYTES || (input.markdown ?? '').includes('\x00')) {
    throw new Error('Wiki 页面 slug、标题或正文无效')
  }
  const kind = (input.kind ?? 'reference') as AgentMemoryPage['kind']
  if (!AGENT_MEMORY_PAGE_KINDS.includes(kind)) throw new Error('Wiki 页面类型无效')
  const evidence = input.evidence ?? []
  const sources = input.sources ?? []
  if (evidence.length > 32 || sources.length > 64) {
    throw new Error('Wiki 证据或来源数量超过限额')
  }
  for (const item of evidence) {
    if (!validText(item.text, 2048) || (item.uri?.length ?? 0) > 2048 || item.id.length > 128 || item.kind.length > 64) {
      throw new Error('Wiki 证据摘录无效或超过限额')
    }
  }
  for (const values of [input.tags ?? [], input.aliases ?? []]) {
    if (values.length > 32) throw new Error('Wiki 标签和别名各最多 32 项')
    for (const value of values) {
      if (!validText(value, 128)) throw new Error('Wiki 标签或别名无效')
    }
  }
  if (input.expiresAt !== undefined && input.expiresAt !== '' && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new Error('Wiki 有效期必须为 RFC3339 时间')
  }
}

/** 页面落版：写当前版与不可变修订（publishWikiPage 的内存等价）。 */
function commitPage(page: AgentMemoryPage, expectedRevision: number): void {
  const dataset = readAgentMemoryDataset()
  if (page.revision !== expectedRevision + 1) {
    throw new Error('Wiki 页面版本已变化，请重新读取')
  }
  dataset.pageRevisions.set(`${page.id}:${page.revision}`, page)
  const index = dataset.pages.findIndex((row) => row.id === page.id)
  if (index === -1) dataset.pages.unshift(page)
  else dataset.pages[index] = page
}

function pageFromInput(old: AgentMemoryPage | undefined, spaceId: string, input: AgentMemoryPageInput, pageId: string): AgentMemoryPage {
  const kind = (input.kind ?? 'reference') as AgentMemoryPage['kind']
  const now = nextMemoryStamp()
  const markdown = input.markdown ?? ''
  const title = input.title ?? ''
  let expiresAt = input.expiresAt === '' ? undefined : input.expiresAt
  if (kind === 'observation' && expiresAt === undefined) expiresAt = observationExpiry(now)
  return {
    id: pageId,
    spaceId,
    slug: old?.slug ?? input.slug,
    revision: (old?.revision ?? 0) + 1,
    title,
    markdown,
    kind,
    status: 'active',
    digest: memoryDigest(title, markdown),
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    evidence: [...(input.evidence ?? [])],
    sources: [...(input.sources ?? [])],
    links: extractLinks(markdown),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.aliases === undefined ? {} : { aliases: [...input.aliases] }),
  }
}

/** 撤回传播：来源依赖该页的 pending 候选同事务标 invalidated（wiki_context.go:458）。 */
function invalidateDependentProposals(pageId: string): number {
  const dataset = readAgentMemoryDataset()
  let count = 0
  for (const proposal of dataset.proposals) {
    if (proposal.status === 'pending' && sourceReferencesPage(proposal.page.sources ?? [], pageId)) {
      proposal.status = 'invalidated'
      count += 1
    }
  }
  return count
}

function tokenize(text: string): readonly string[] {
  const tokens: string[] = []
  let word = ''
  let han = ''
  const flushWord = () => {
    if (word !== '') {
      tokens.push(word)
      word = ''
    }
  }
  const flushHan = () => {
    if (han.length === 1) tokens.push(han)
    for (let index = 0; index + 1 < han.length; index += 1) tokens.push(han.slice(index, index + 2))
    han = ''
  }
  for (const char of text.toLowerCase()) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      flushWord()
      han += char
    } else if (/[a-z0-9]/.test(char)) {
      flushHan()
      word += char
    } else {
      flushWord()
      flushHan()
    }
  }
  flushWord()
  flushHan()
  return tokens
}

/** 文本得分：查询 token 在可检索文本中的命中率（wikiTextScore 的内存等价）。 */
function textScore(query: string, text: string): number {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0
  const docTokens = new Set(tokenize(text))
  let hits = 0
  for (const token of new Set(queryTokens)) {
    if (docTokens.has(token)) hits += 1
  }
  return hits / new Set(queryTokens).size
}

function searchableText(page: AgentMemoryPage): string {
  return [page.title, page.slug, ...(page.tags ?? []), ...(page.aliases ?? []), page.markdown].join('\n')
}

/** 来源是否仍然有效：目标修订存在、摘要一致且页面未撤回（validateWikiSources 口径）。 */
function sourceValid(source: { pageId: string; revision: number; digest: string }): boolean {
  const dataset = readAgentMemoryDataset()
  const revision = dataset.pageRevisions.get(`${source.pageId}:${source.revision}`)
  if (revision === undefined || revision.digest !== source.digest) return false
  const current = findPage(source.pageId)
  return current !== undefined && current.status === 'active'
}

type EmbeddingRecord = AgentEmbeddingProfile & { credential?: string }

function publicProfile(record: EmbeddingRecord): AgentEmbeddingProfile {
  const { credential: _credential, ...rest } = record
  return { ...rest, hasCredential: record.hasCredential || (record.credential ?? '') !== '' }
}

/** 镜像 validateEmbeddingProfile（embedding.go:61-77）。 */
function validateEmbeddingInput(input: { name: string; baseUrl: string; model: string; dimensions: number; active: boolean; credential?: string }): void {
  if (input.name === '' || input.name.length > 120 || input.model === '' || input.model.length > 200 ||
    !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 8192) {
    throw new Error('Embedding 配置名称、模型或维度无效')
  }
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new Error('Embedding 服务地址必须是无凭据、查询参数或片段的 HTTP 地址')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Embedding 服务地址必须是无凭据、查询参数或片段的 HTTP 地址')
  }
  if (byteLength(input.credential ?? '') > 8192) throw new Error('Embedding 凭据格式无效')
  if (url.protocol === 'http:' && (input.credential ?? '') !== '' && !['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase())) {
    throw new Error('HTTP Embedding 服务地址携带凭据时仅允许本机回环地址，请改用 HTTPS 或清除凭据')
  }
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number | undefined): RuntimePage<T> {
  const size = limit !== undefined && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50
  const offset = cursor !== undefined && cursor !== '' && /^(0|[1-9][0-9]*)$/.test(cursor) ? Number(cursor) : 0
  const slice = items.slice(offset, offset + size)
  const hasMore = offset + size < items.length
  return { items: slice, nextCursor: hasMore ? String(offset + size) : '', hasMore }
}

/** 提炼任务后台推进：queued→running→succeeded，成功后产出确定性候选。 */
function advanceExtractionJob(job: AgentMemoryExtraction): void {
  scheduleMemoryTimer(() => {
    job.status = 'running'
    job.startedAt = nextMemoryStamp()
  }, MEMORY_JOB_STEP_MS)
  scheduleMemoryTimer(() => {
    const dataset = readAgentMemoryDataset()
    const usage: AgentModelUsage = { promptTokens: 650, totalTokens: 650 }
    job.status = 'succeeded'
    job.memoryStatus = 'updated'
    job.endedAt = nextMemoryStamp()
    job.usage = usage
    job.estimatedTokens = 610
    const proposal = manualExtractionCandidate(job, ++dataset.sequence)
    dataset.proposals.unshift(proposal)
    job.candidateIds = [...job.candidateIds, proposal.id]
  }, MEMORY_JOB_STEP_MS * 2)
}

/** 索引任务后台推进：queued→running→succeeded，成功后该空间按配置记满索引。 */
function advanceIndexJob(job: AgentMemoryExtraction, profileId: string, spaceId: string): void {
  scheduleMemoryTimer(() => {
    job.status = 'running'
    job.startedAt = nextMemoryStamp()
  }, MEMORY_JOB_STEP_MS)
  scheduleMemoryTimer(() => {
    const dataset = readAgentMemoryDataset()
    job.status = 'succeeded'
    job.endedAt = nextMemoryStamp()
    dataset.indexedPages.set(`${spaceId}:${profileId}`, activePages(spaceId).length)
  }, MEMORY_JOB_STEP_MS * 2)
}

export class AgentMemoryMockAdapter implements AgentMemoryAdapter {
  readonly available = false

  async listSpaces(): Promise<readonly AgentMemorySpace[]> {
    const spaces = [...readAgentMemoryDataset().spaces]
    spaces.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'global' ? -1 : 1))
    return spaces
  }

  async createSpace(input: AgentMemorySpaceInput): Promise<AgentMemorySpace> {
    const dataset = readAgentMemoryDataset()
    if (!validText(input.name, 120)) throw new Error('Wiki 空间名称无效')
    if (input.kind !== 'business' && input.kind !== 'global') throw new Error('Wiki 空间类型无效')
    if (input.kind === 'global' && dataset.spaces.some((space) => space.kind === 'global')) {
      throw new Error('全局 Wiki 空间已存在')
    }
    const space: AgentMemorySpace = {
      id: nextMemoryId(dataset, 'space'),
      revision: 1,
      name: input.name.trim(),
      kind: input.kind,
      createdAt: nextMemoryStamp(),
    }
    dataset.spaces.push(space)
    return space
  }

  async renameSpace(spaceId: string, expectedRevision: number, name: string): Promise<AgentMemorySpace> {
    const space = findSpace(spaceId)
    if (space === undefined) throw spaceNotFound()
    if (space.revision !== expectedRevision) throw new Error('记忆空间版本已变化')
    if (!validText(name, 120)) throw new Error('记忆空间名称无效')
    space.revision += 1
    space.name = name.trim()
    return { ...space }
  }

  async listPages(spaceId: string, includeWithdrawn = false): Promise<readonly AgentMemoryPage[]> {
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    return readAgentMemoryDataset().pages
      .filter((page) => page.spaceId === spaceId && (includeWithdrawn || page.status !== 'withdrawn'))
      .map((page) => ({ ...page }))
  }

  async createPage(spaceId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage> {
    const dataset = readAgentMemoryDataset()
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      throw new Error('新增页面基准 revision 必须为零')
    }
    validatePageInput(input)
    const page = pageFromInput(undefined, spaceId, input, nextMemoryId(dataset, 'page'))
    commitPage(page, 0)
    return { ...page }
  }

  async getPage(spaceId: string, pageId: string): Promise<AgentMemoryPage> {
    const page = findPage(pageId)
    if (page === undefined) throw new Error('Wiki 页面不存在')
    if (page.spaceId !== spaceId) throw new Error('Wiki 页面不属于当前空间')
    return { ...page }
  }

  async updatePage(spaceId: string, pageId: string, input: AgentMemoryPageInput): Promise<AgentMemoryPage> {
    const old = findPage(pageId)
    if (old === undefined) throw new Error('Wiki 页面不存在')
    if (old.spaceId !== spaceId) throw new Error('Wiki 页面不属于当前空间')
    if ((input.expectedRevision ?? 0) !== old.revision) throw new Error('Wiki 页面版本已变化，请重新读取')
    validatePageInput(input)
    const page = pageFromInput(old, spaceId, { ...input, slug: old.slug }, pageId)
    commitPage(page, old.revision)
    return { ...page }
  }

  async withdrawPage(spaceId: string, pageId: string, expectedRevision: number): Promise<AgentMemoryPage> {
    const old = findPage(pageId)
    if (old === undefined) throw new Error('Wiki 页面不存在')
    if (old.spaceId !== spaceId) throw new Error('Wiki 页面不属于当前空间')
    if (expectedRevision !== old.revision) throw new Error('Wiki 页面版本已变化，请重新读取')
    const dataset = readAgentMemoryDataset()
    const now = nextMemoryStamp()
    const page: AgentMemoryPage = {
      ...old,
      revision: old.revision + 1,
      status: 'withdrawn',
      withdrawnAt: now,
      updatedAt: now,
    }
    dataset.pageRevisions.set(`${page.id}:${page.revision}`, page)
    const index = dataset.pages.findIndex((row) => row.id === pageId)
    dataset.pages[index] = page
    invalidateDependentProposals(pageId)
    return { ...page }
  }

  async getPageRevision(spaceId: string, pageId: string, revision: number): Promise<AgentMemoryPage> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Wiki 修订必须是正整数')
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const page = readAgentMemoryDataset().pageRevisions.get(`${pageId}:${revision}`)
    if (page === undefined || page.spaceId !== spaceId) throw new Error('Wiki 页面修订不存在')
    return { ...page }
  }

  async search(spaceId: string, query: string, limit = 8): Promise<AgentMemorySearchResult> {
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const q = query.trim()
    if (q === '' || byteLength(query) > 32 * 1024) throw new Error('Wiki 搜索内容不能为空或超过容量限制')
    const size = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 8
    const now = virtualNowMs()
    const pages = activePages(spaceId).filter((page) => {
      if (page.expiresAt !== undefined && Date.parse(page.expiresAt) <= now) return false
      const self: AgentMemoryPage['sources'][number] = { pageId: page.id, revision: page.revision, digest: page.digest }
      return [...page.sources, self].every(sourceValid)
    })
    const dataset = readAgentMemoryDataset()
    const activeProfile = [...dataset.embeddingProfiles]
      .filter((record) => record.active)
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    const indexReady = activeProfile !== undefined &&
      (dataset.indexedPages.get(`${spaceId}:${activeProfile.id}`) ?? 0) >= pages.length && pages.length > 0
    const items = pages
      .map((page) => ({ page, score: textScore(q, searchableText(page)) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => (a.score !== b.score ? b.score - a.score : Date.parse(b.page.updatedAt) - Date.parse(a.page.updatedAt)))
      .slice(0, size)
      .map((hit) => ({ page: { ...hit.page }, score: hit.score, method: indexReady ? ('hybrid-rrf' as const) : ('sqlite-text' as const) }))
    if (indexReady) return { items, degraded: false }
    return {
      items,
      degraded: true,
      reason: activeProfile === undefined ? '使用 SQLite 中文双字全文回落' : 'Embedding 索引尚未就绪，使用 SQLite 中文双字全文回落',
    }
  }

  async importPages(spaceId: string, files: Readonly<Record<string, string>>): Promise<readonly AgentMemoryProposal[]> {
    const dataset = readAgentMemoryDataset()
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const names = Object.keys(files)
    if (names.length === 0 || names.length > 64) throw new Error('一次导入必须包含 1 至 64 个文件')
    const created: AgentMemoryProposal[] = []
    for (const name of [...names].sort()) {
      if (!name.endsWith('.md')) continue
      let markdown = files[name] ?? ''
      let title = name.slice(0, -3)
      if (markdown.startsWith('# ')) {
        const [first, ...rest] = markdown.split('\n')
        title = (first ?? '#').slice(2).trim()
        markdown = rest.join('\n')
      }
      const input: AgentMemoryPageInput = { slug: name.slice(0, -3), title, markdown: markdown.trim(), kind: 'reference' }
      validatePageInput(input)
      created.push({
        id: nextMemoryId(dataset, 'prop'),
        spaceId,
        status: 'pending',
        originKind: 'markdown-import',
        originId: name,
        createdAt: nextMemoryStamp(),
        page: input,
      })
    }
    dataset.proposals = [...created, ...dataset.proposals]
    return created.map((proposal) => ({ ...proposal }))
  }

  async exportSpace(spaceId: string): Promise<AgentMemoryExport> {
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const dataset = readAgentMemoryDataset()
    const pages = dataset.pages.filter((page) => page.spaceId === spaceId)
    const files: Record<string, string> = {}
    const indexLines: string[] = ['# Wiki 索引', '']
    const changeLines: string[] = ['# 修订记录', '']
    const sources: Record<string, readonly unknown[]> = {}
    for (const page of pages) {
      files[`pages/${page.id}.md`] = `# ${page.title}\n\n${page.markdown}\n`
      indexLines.push(`- [[${page.id}]] ${page.title} (revision ${page.revision}, ${page.status})`)
      sources[page.id] = page.evidence
      for (let revision = 1; revision <= page.revision; revision += 1) {
        const record = dataset.pageRevisions.get(`${page.id}:${revision}`)
        if (record !== undefined) changeLines.push(`- ${page.id} revision ${record.revision} ${record.updatedAt} ${record.digest}`)
      }
    }
    files['index.md'] = `${indexLines.join('\n')}\n`
    files['changelog.md'] = `${changeLines.join('\n')}\n`
    files['sources.json'] = JSON.stringify(sources, null, 2)
    return { files }
  }

  async checkSpace(spaceId: string): Promise<AgentMemoryChecks> {
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const dataset = readAgentMemoryDataset()
    const pages = dataset.pages.filter((page) => page.spaceId === spaceId)
    const activeIds = new Set(pages.filter((page) => page.status === 'active').map((page) => page.id))
    const linked = new Set(pages.flatMap((page) => [...page.links]))
    const now = virtualNowMs()
    const orphanPages: string[] = []
    const brokenLinks: string[] = []
    const expiredPages: string[] = []
    const invalidSources: string[] = []
    for (const page of pages) {
      if (!linked.has(page.id) && page.links.length === 0) orphanPages.push(page.id)
      for (const link of page.links) {
        if (!activeIds.has(link)) brokenLinks.push(`${page.slug} -> ${link}`)
      }
      if (page.expiresAt !== undefined && Date.parse(page.expiresAt) <= now) expiredPages.push(page.slug)
      for (const source of page.sources) {
        if (!sourceValid(source)) invalidSources.push(`${page.slug} -> ${source.pageId}:${source.revision}`)
      }
    }
    return { orphanPages, brokenLinks, expiredPages, invalidSources }
  }

  async indexStatus(spaceId: string): Promise<readonly AgentMemoryIndexStatus[]> {
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const dataset = readAgentMemoryDataset()
    const pages = activePages(spaceId).length
    return [...dataset.embeddingProfiles]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => {
        const indexedPages = dataset.indexedPages.get(`${spaceId}:${record.id}`) ?? 0
        return { profile: publicProfile(record), pages, indexedPages, status: indexedPages < pages ? 'stale' : 'ready' }
      })
  }

  async rebuildIndex(spaceId: string, input: AgentMemoryIndexInput): Promise<AgentMemoryExtraction> {
    const dataset = readAgentMemoryDataset()
    if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new Error('索引重建请求标识无效')
    if (findSpace(spaceId) === undefined) throw spaceNotFound()
    const prior = dataset.jobs.find((job) => job.kind === 'embedding' && job.originKind === 'space' && job.originId === input.requestId)
    if (prior !== undefined) {
      if (prior.embeddingProfile?.id !== input.profileId || prior.embeddingProfile?.revision !== input.profileRevision) {
        throw new Error('索引重建请求标识已用于其他参数')
      }
      return { ...prior }
    }
    const fixed = dataset.embeddingProfiles.find((record) => record.id === input.profileId && record.revision === input.profileRevision)
    const latest = dataset.embeddingProfiles.find((record) => record.id === input.profileId)
    if (fixed === undefined || !fixed.active || latest === undefined || !latest.active) {
      throw new Error('Embedding 配置不存在、已停用或修订不可用')
    }
    if (dataset.jobs.filter((job) => job.status === 'queued').length >= 32) {
      throw new Error('长期记忆后台任务队列已满')
    }
    const profile = publicProfile(fixed)
    const job: AgentMemoryExtraction = {
      id: nextMemoryId(dataset, 'job'),
      kind: 'embedding',
      originKind: 'space',
      originId: input.requestId,
      spaceId,
      status: 'queued',
      generation: 0,
      embeddingProfile: profile,
      model: { id: '', revision: 0, name: '', baseUrl: '', model: '', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 0, outputTokens: 0, capabilities: { text: false, tools: false, source: '' }, active: false, hasCredential: false },
      createdAt: nextMemoryStamp(),
      usage: {},
      estimatedTokens: 0,
      candidateIds: [],
      sources: activePages(spaceId).map((page) => ({ pageId: page.id, revision: page.revision, digest: page.digest })),
    }
    dataset.jobs.unshift(job)
    advanceIndexJob(job, input.profileId, spaceId)
    return { ...job }
  }

  async listProposals(query: { spaceId?: string; status?: AgentMemoryProposalStatus }): Promise<readonly AgentMemoryProposal[]> {
    return readAgentMemoryDataset().proposals
      .filter((proposal) => (query.spaceId === undefined || query.spaceId === '' || proposal.spaceId === query.spaceId) &&
        (query.status === undefined || proposal.status === query.status))
      .map((proposal) => ({ ...proposal }))
  }

  async decideProposal(proposalId: string, input: AgentMemoryProposalDecisionInput): Promise<AgentMemoryProposal> {
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new Error('候选决定必须为 approved 或 rejected')
    }
    const dataset = readAgentMemoryDataset()
    const proposal = dataset.proposals.find((row) => row.id === proposalId)
    if (proposal === undefined) throw new Error('Wiki 候选不存在')
    if (proposal.status === 'invalidated') throw new Error('候选来源已撤回，不能发布')
    if (proposal.status !== 'pending') {
      if (proposal.status === input.decision) return { ...proposal }
      throw new Error('Wiki 候选已处理')
    }
    if (input.decision === 'approved') {
      const expected = proposal.page.expectedRevision ?? 0
      if (proposal.pageId === undefined) {
        if (expected !== 0) throw new Error('新增页面基准 revision 必须为零')
        validatePageInput(proposal.page)
        const page = pageFromInput(undefined, proposal.spaceId, proposal.page, nextMemoryId(dataset, 'page'))
        commitPage(page, 0)
        proposal.pageId = page.id
      } else {
        const old = findPage(proposal.pageId)
        if (old === undefined || old.spaceId !== proposal.spaceId) throw new Error('Wiki 页面不存在')
        if (expected !== old.revision) throw new Error('Wiki 页面版本已变化，请重新读取')
        validatePageInput(proposal.page)
        const page = pageFromInput(old, proposal.spaceId, { ...proposal.page, slug: old.slug }, old.id)
        commitPage(page, old.revision)
      }
    }
    proposal.status = input.decision
    proposal.decidedAt = nextMemoryStamp()
    return { ...proposal }
  }

  async listExtractions(query?: { cursor?: string; limit?: number }): Promise<RuntimePage<AgentMemoryExtraction>> {
    const jobs = readAgentMemoryDataset().jobs.filter((job) => job.kind === 'extraction')
    return paginate(jobs, query?.cursor, query?.limit)
  }

  async createExtraction(input: AgentCreateMemoryExtractionInput): Promise<AgentMemoryExtraction> {
    const dataset = readAgentMemoryDataset()
    if (!REQUEST_ID_PATTERN.test(input.requestId) || ((input.runId ?? '') === '') === ((input.workflowId ?? '') === '')) {
      throw new Error('手动提炼必须提供请求标识及唯一的成功运行或工作流编号')
    }
    const prior = dataset.jobs.find((job) => job.kind === 'extraction' && job.originKind === 'manual' && job.originId === input.requestId)
    if (prior !== undefined) {
      if (prior.runId !== (input.runId ?? '') || prior.workflowId !== (input.workflowId ?? '')) {
        throw new Error('提炼请求标识已用于其他来源')
      }
      return { ...prior }
    }
    if (dataset.jobs.filter((job) => job.status === 'queued').length >= 32) {
      throw new Error('长期记忆后台任务队列已满')
    }
    const originKind = (input.runId ?? '') !== '' ? 'run' : 'workflow'
    const originId = originKind === 'run' ? input.runId ?? '' : input.workflowId ?? ''
    const snapshot = dataset.jobs.find((job) => job.kind === 'extraction' && job.originKind === originKind && job.originId === originId)
    if (snapshot === undefined) {
      throw new Error('成功来源没有固定的长期记忆提炼快照，无法提炼')
    }
    const job: AgentMemoryExtraction = {
      ...snapshot,
      id: nextMemoryId(dataset, 'ext'),
      originKind: 'manual',
      originId: input.requestId,
      runId: input.runId ?? '',
      workflowId: input.workflowId ?? '',
      status: 'queued',
      memoryStatus: 'unchanged',
      createdAt: nextMemoryStamp(),
      startedAt: undefined,
      endedAt: undefined,
      usage: {},
      estimatedTokens: 0,
      candidateIds: [],
      error: undefined,
      embeddingProfile: undefined,
      model: MEMORY_DEMO_MODEL,
    }
    dataset.jobs.unshift(job)
    advanceExtractionJob(job)
    return { ...job }
  }

  async getExtraction(extractionId: string): Promise<AgentMemoryExtraction> {
    const job = readAgentMemoryDataset().jobs.find((row) => row.id === extractionId)
    if (job === undefined) throw new Error('长期记忆提炼任务不存在')
    return { ...job }
  }

  async listEmbeddingProfiles(): Promise<readonly AgentEmbeddingProfile[]> {
    return readAgentMemoryDataset().embeddingProfiles
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => publicProfile(record))
  }

  async createEmbeddingProfile(input: AgentEmbeddingProfileInput): Promise<AgentEmbeddingProfile> {
    const dataset = readAgentMemoryDataset()
    validateEmbeddingInput(input)
    const credential = input.credential ?? ''
    const record: EmbeddingRecord = {
      id: nextMemoryId(dataset, 'emb'),
      revision: 1,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      model: input.model.trim(),
      dimensions: input.dimensions,
      active: input.active,
      hasCredential: credential !== '',
      ...(credential === '' ? {} : { credential }),
    }
    dataset.embeddingProfiles.push(record)
    return publicProfile(record)
  }

  async updateEmbeddingProfile(profileId: string, input: AgentUpdateEmbeddingProfileInput): Promise<AgentEmbeddingProfile> {
    const dataset = readAgentMemoryDataset()
    const record = dataset.embeddingProfiles.find((row) => row.id === profileId)
    if (record === undefined) throw new Error('Embedding 配置不存在')
    if (record.revision !== input.expectedRevision) throw new Error('Embedding 配置已变化，请重新读取')
    validateEmbeddingInput(input)
    record.revision += 1
    record.name = input.name.trim()
    record.baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    record.model = input.model.trim()
    record.dimensions = input.dimensions
    record.active = input.active
    if (input.credential !== undefined) record.credential = input.credential
    return publicProfile(record)
  }

  async listEmbeddingRequests(query?: { cursor?: string; limit?: number }): Promise<RuntimePage<AgentEmbeddingRequest>> {
    return paginate(readAgentMemoryDataset().embeddingRequests, query?.cursor, query?.limit)
  }
}

export { resetAgentMemoryData }

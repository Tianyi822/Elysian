import type {
  AgentEmbeddingProfile,
  AgentEmbeddingRequest,
  AgentMemoryExtraction,
  AgentMemoryPage,
  AgentMemoryProposal,
  AgentMemorySpace,
  AgentModelProfile,
  AgentWikiRef,
} from '@elysian/contracts'

/*
 * 长期记忆域演示数据集（确定性）。种子相对固定基准时间 2026-10-10T00:00:00Z 生成，
 * 不读当前时钟：时间戳由递增序号推导（基准 + 序号×7 秒），ID 由前缀＋序号拼接，
 * 摘要由内容经 FNV-1a 推导——同一操作序列永远得到同一结果。
 * 写操作只改内存：刷新即回种子；resetAgentMemoryData() 供测试复位并清掉后台定时器。
 * 状态机遵守服务端语义：撤回同事务把依赖候选标 invalidated；提炼/索引任务
 * queued→running→succeeded 经定时器推进（复用 websites 构建任务的 mock 先例），
 * interrupted 不自动重跑。
 */

/** 演示基准时间（种子与新增事实的时间原点）。 */
export const MEMORY_SEED_BASE_MS = Date.parse('2026-10-10T00:00:00Z')

const SEED_STEP_MS = 7_000
const JOB_STEP_MS = 1_200

export type AgentMemoryEmbeddingRecord = AgentEmbeddingProfile & { credential?: string }

export type AgentMemoryDataset = {
  /** 确定性序号：ID 与时间戳的唯一来源。 */
  sequence: number
  spaces: AgentMemorySpace[]
  /** 当前版页面（等价 wiki_pages）。 */
  pages: AgentMemoryPage[]
  /** 不可变修订（等价 wiki_page_revisions），键 `${pageId}:${revision}`。 */
  pageRevisions: Map<string, AgentMemoryPage>
  proposals: AgentMemoryProposal[]
  /** 提炼与索引任务（等价 wiki_jobs）。 */
  jobs: AgentMemoryExtraction[]
  embeddingProfiles: AgentMemoryEmbeddingRecord[]
  /** 已建索引页数，键 `${spaceId}:${profileId}`；缺省即 0。 */
  indexedPages: Map<string, number>
  embeddingRequests: AgentEmbeddingRequest[]
  timers: Set<ReturnType<typeof setTimeout>>
}

/** 演示固定模型（提炼任务快照携带的公开模型配置）。 */
export const MEMORY_DEMO_MODEL: AgentModelProfile = {
  id: 'model-seed',
  revision: 1,
  name: '演示模型',
  baseUrl: 'https://model.example.test/v1',
  model: 'demo-model',
  provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536,
  outputTokens: 4096,
  capabilities: { text: true, tools: true, source: 'demo' },
  active: true,
  hasCredential: true,
}

/** 内容摘要：FNV-1a 循环铺到 64 位十六进制，仅演示用，不承担密码学强度。 */
export function memoryDigest(...parts: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x1f
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const segment = hash.toString(16).padStart(8, '0')
  return segment.repeat(8)
}

function stampAt(dataset: AgentMemoryDataset): string {
  return new Date(MEMORY_SEED_BASE_MS + dataset.sequence * SEED_STEP_MS).toISOString()
}

/** 生成下一个确定性 ID（动态创建用，前缀区分实体；种子实体用固定可读 ID）。 */
export function nextMemoryId(dataset: AgentMemoryDataset, prefix: string): string {
  dataset.sequence += 1
  return `${prefix}-${100 + dataset.sequence}`
}

function seedSpace(id: string, name: string, kind: 'business' | 'global', sequence: number): AgentMemorySpace {
  return { id, revision: 1, name, kind, createdAt: new Date(MEMORY_SEED_BASE_MS + sequence * SEED_STEP_MS).toISOString() }
}

function seedPage(page: Omit<AgentMemoryPage, 'digest'> & { digest?: string }): AgentMemoryPage {
  return { ...page, digest: page.digest ?? memoryDigest(page.title, page.markdown) }
}

function createDataset(): AgentMemoryDataset {
  const dataset: AgentMemoryDataset = {
    sequence: 20,
    spaces: [
      seedSpace('space-global', '全局运维常识', 'global', 1),
      seedSpace('space-1', '容器运维', 'business', 2),
    ],
    pages: [],
    pageRevisions: new Map(),
    proposals: [],
    jobs: [],
    embeddingProfiles: [
      { id: 'emb-1', revision: 2, name: '通用文本向量', baseUrl: 'https://embedding.example.test/v1', model: 'text-embed-demo', dimensions: 1536, active: true, hasCredential: true, credential: 'demo-credential' },
      { id: 'emb-2', revision: 1, name: '备用向量（停用）', baseUrl: 'http://127.0.0.1:9000/v1', model: 'local-embed', dimensions: 512, active: false, hasCredential: false },
    ],
    indexedPages: new Map([['space-1:emb-1', 1]]),
    embeddingRequests: [
      { id: 'embed-req-1', profileId: 'emb-1', profileRevision: 2, purpose: 'index', jobId: 'job-embed-seed-1', page: { pageId: 'page-a', revision: 2, digest: memoryDigest('容器重启手册', '# 重启步骤') }, status: 'succeeded', inputBytes: 512, inputDigest: memoryDigest('index-input-1'), estimatedTokens: 96, usage: { promptTokens: 96, totalTokens: 96 }, startedAt: new Date(MEMORY_SEED_BASE_MS + 3 * SEED_STEP_MS).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 3 * SEED_STEP_MS + 900).toISOString() },
      { id: 'embed-req-2', profileId: 'emb-1', profileRevision: 2, purpose: 'query', status: 'succeeded', inputBytes: 64, inputDigest: memoryDigest('query-input-1'), estimatedTokens: 12, usage: {}, startedAt: new Date(MEMORY_SEED_BASE_MS + 4 * SEED_STEP_MS).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 4 * SEED_STEP_MS + 300).toISOString() },
      { id: 'embed-req-3', profileId: 'emb-2', profileRevision: 1, purpose: 'index', jobId: 'job-embed-seed-2', status: 'failed', inputBytes: 256, inputDigest: memoryDigest('index-input-2'), estimatedTokens: 48, usage: {}, startedAt: new Date(MEMORY_SEED_BASE_MS + 5 * SEED_STEP_MS).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 5 * SEED_STEP_MS + 500).toISOString(), error: { code: 'embedding-request-failed', message: 'Embedding 服务请求失败' } },
    ],
    timers: new Set(),
  }

  const pageA1 = seedPage({
    id: 'page-a', spaceId: 'space-1', slug: 'runbook/container-restart', revision: 1,
    title: '容器重启手册', markdown: '# 容器重启手册\n\n先核对健康状态，再按顺序重启。', kind: 'runbook', status: 'active',
    createdAt: new Date(MEMORY_SEED_BASE_MS + 6 * SEED_STEP_MS).toISOString(), updatedAt: new Date(MEMORY_SEED_BASE_MS + 6 * SEED_STEP_MS).toISOString(),
    evidence: [{ id: 'run-seed-1', kind: 'run', runId: 'run-seed-1', eventSeq: '9007199254740993', text: '已核验容器重启后健康检查通过', createdAt: new Date(MEMORY_SEED_BASE_MS + 6 * SEED_STEP_MS).toISOString(), digest: memoryDigest('run', '已核验容器重启后健康检查通过'), originalCleared: false }],
    sources: [], links: [], tags: ['Docker', '重启'], aliases: ['重启手册'],
  })
  const pageA2 = seedPage({ ...pageA1, revision: 2, markdown: '# 容器重启手册\n\n先核对健康状态，再按顺序重启；重启后观察五分钟。相关约定见 [[page-b]]。', links: ['page-b'], updatedAt: new Date(MEMORY_SEED_BASE_MS + 10 * SEED_STEP_MS).toISOString() })
  const pageB = seedPage({
    id: 'page-b', spaceId: 'space-1', slug: 'reference/port-map', revision: 1,
    title: '端口映射约定', markdown: '# 端口映射约定\n\n面板前端固定 48100，后端固定 48101。', kind: 'reference', status: 'active',
    createdAt: new Date(MEMORY_SEED_BASE_MS + 7 * SEED_STEP_MS).toISOString(), updatedAt: new Date(MEMORY_SEED_BASE_MS + 7 * SEED_STEP_MS).toISOString(),
    evidence: [], sources: [], links: [], tags: ['网络'],
  })
  const pageC = seedPage({
    id: 'page-c', spaceId: 'space-1', slug: 'observation/disk-noise', revision: 2,
    title: '磁盘噪声观察', markdown: '# 磁盘噪声观察\n\n某次维护窗口出现的磁盘噪声，已随硬件更换消失。', kind: 'observation', status: 'withdrawn',
    createdAt: new Date(MEMORY_SEED_BASE_MS + 8 * SEED_STEP_MS).toISOString(), updatedAt: new Date(MEMORY_SEED_BASE_MS + 12 * SEED_STEP_MS).toISOString(),
    withdrawnAt: new Date(MEMORY_SEED_BASE_MS + 12 * SEED_STEP_MS).toISOString(),
    evidence: [], sources: [], links: [], tags: [],
  })
  const pageD = seedPage({
    id: 'page-d', spaceId: 'space-1', slug: 'observation/backup-window', revision: 1,
    title: '备份窗口观察', markdown: '# 备份窗口观察\n\n夜间备份窗口曾出现 IO 抬升。', kind: 'observation', status: 'active',
    createdAt: new Date(MEMORY_SEED_BASE_MS + 9 * SEED_STEP_MS).toISOString(), updatedAt: new Date(MEMORY_SEED_BASE_MS + 9 * SEED_STEP_MS).toISOString(),
    expiresAt: new Date(MEMORY_SEED_BASE_MS - 24 * 60 * 60 * 1000).toISOString(),
    evidence: [], sources: [{ pageId: 'page-gone', revision: 1, digest: memoryDigest('missing-source') }], links: [], tags: [],
  })
  const pageG = seedPage({
    id: 'page-g', spaceId: 'space-global', slug: 'reference/global-alias', revision: 1,
    title: '全局命名速记', markdown: '# 全局命名速记\n\n项目命名一律使用 Elysian 前缀。', kind: 'reference', status: 'active',
    createdAt: new Date(MEMORY_SEED_BASE_MS + 11 * SEED_STEP_MS).toISOString(), updatedAt: new Date(MEMORY_SEED_BASE_MS + 11 * SEED_STEP_MS).toISOString(),
    evidence: [], sources: [], links: [], tags: ['命名'],
  })
  dataset.pages = [pageG, pageD, pageC, pageB, pageA2]
  for (const page of [pageA1, pageA2, pageB, { ...pageC, revision: 1, status: 'active' as const, withdrawnAt: undefined }, pageD, pageG]) {
    dataset.pageRevisions.set(`${page.id}:${page.revision}`, page)
  }

  dataset.proposals = [
    {
      id: 'prop-1', spaceId: 'space-1', status: 'pending', originKind: 'extraction', originId: 'ext-1',
      createdAt: new Date(MEMORY_SEED_BASE_MS + 14 * SEED_STEP_MS).toISOString(),
      page: { slug: 'convention/naming', title: '容器命名约定', markdown: '# 容器命名约定\n\n业务容器以业务名加用途后缀命名。', kind: 'convention', evidence: [], sources: [{ pageId: 'page-b', revision: 1, digest: pageB.digest }] },
    },
    {
      id: 'prop-2', spaceId: 'space-1', pageId: 'page-b', status: 'approved', originKind: 'extraction', originId: 'ext-1',
      createdAt: new Date(MEMORY_SEED_BASE_MS + 13 * SEED_STEP_MS).toISOString(), decidedAt: new Date(MEMORY_SEED_BASE_MS + 15 * SEED_STEP_MS).toISOString(),
      page: { expectedRevision: 0, slug: 'reference/port-map', title: '端口映射约定', markdown: '# 端口映射约定\n\n面板前端固定 48100，后端固定 48101。', kind: 'reference', evidence: [], sources: [] },
    },
    {
      id: 'prop-3', spaceId: 'space-1', status: 'rejected', originKind: 'markdown-import', originId: 'notes.md',
      createdAt: new Date(MEMORY_SEED_BASE_MS + 16 * SEED_STEP_MS).toISOString(), decidedAt: new Date(MEMORY_SEED_BASE_MS + 17 * SEED_STEP_MS).toISOString(),
      page: { slug: 'notes', title: '临时笔记', markdown: '# 临时笔记\n\n不值得长期保存。', kind: 'reference', evidence: [], sources: [] },
    },
  ]

  dataset.jobs = [
    {
      id: 'ext-1', kind: 'extraction', originKind: 'run', originId: 'run-seed-1', spaceId: 'space-1', status: 'succeeded', memoryStatus: 'updated',
      taskId: 'task-seed-1', runId: 'run-seed-1', generation: 1, model: MEMORY_DEMO_MODEL,
      createdAt: new Date(MEMORY_SEED_BASE_MS + 14 * SEED_STEP_MS).toISOString(), startedAt: new Date(MEMORY_SEED_BASE_MS + 14 * SEED_STEP_MS + 800).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 14 * SEED_STEP_MS + 4000).toISOString(),
      usage: { promptTokens: 812, totalTokens: 812 }, estimatedTokens: 700, candidateIds: ['prop-1'],
      sources: [{ pageId: 'page-b', revision: 1, digest: pageB.digest }],
    },
    {
      id: 'ext-2', kind: 'extraction', originKind: 'workflow', originId: 'wf-seed-1', spaceId: 'space-1', status: 'failed', memoryStatus: 'stale',
      taskId: 'task-seed-2', workflowId: 'wf-seed-1', generation: 1, model: MEMORY_DEMO_MODEL,
      createdAt: new Date(MEMORY_SEED_BASE_MS + 15 * SEED_STEP_MS).toISOString(), startedAt: new Date(MEMORY_SEED_BASE_MS + 15 * SEED_STEP_MS + 600).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 15 * SEED_STEP_MS + 2600).toISOString(),
      usage: { promptTokens: 300, totalTokens: 300 }, estimatedTokens: 260, candidateIds: [],
      sources: [], error: { code: 'memory-extraction-failed', message: '长期记忆提炼失败，已有记忆保持不变' },
    },
    {
      id: 'ext-3', kind: 'extraction', originKind: 'run', originId: 'run-seed-2', spaceId: 'space-1', status: 'interrupted', memoryStatus: 'stale',
      taskId: 'task-seed-3', runId: 'run-seed-2', generation: 2, model: MEMORY_DEMO_MODEL,
      createdAt: new Date(MEMORY_SEED_BASE_MS + 16 * SEED_STEP_MS).toISOString(), startedAt: new Date(MEMORY_SEED_BASE_MS + 16 * SEED_STEP_MS + 400).toISOString(), endedAt: new Date(MEMORY_SEED_BASE_MS + 16 * SEED_STEP_MS + 2000).toISOString(),
      usage: {}, estimatedTokens: 0, candidateIds: [],
      sources: [], error: { code: 'panel-restarted', message: '面板重启中断了长期记忆提炼，未自动重试' },
    },
  ]
  return dataset
}

let dataset: AgentMemoryDataset = createDataset()

/** 读取当前演示数据集（mock adapter 专用；测试经 resetAgentMemoryData 复位）。 */
export function readAgentMemoryDataset(): AgentMemoryDataset {
  return dataset
}

/** 复位演示数据集：清后台定时器并回到固定种子。 */
export function resetAgentMemoryData(): void {
  for (const timer of dataset.timers) clearTimeout(timer)
  dataset = createDataset()
}

/** 为当前 dataset 生成下一个时间戳（写操作落事实用）。 */
export function nextMemoryStamp(): string {
  return stampAt(dataset)
}

/** 注册一个后台定时器；reset 时统一清理。 */
export function scheduleMemoryTimer(callback: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    dataset.timers.delete(timer)
    callback()
  }, delayMs)
  dataset.timers.add(timer)
}

/** 后台任务推进的固定步长（queued→running→succeeded 各一步）。 */
export const MEMORY_JOB_STEP_MS = JOB_STEP_MS

/** 生成一个候选提案页输入（手工提炼成功后产出的确定性候选）。 */
export function manualExtractionCandidate(job: AgentMemoryExtraction, sequence: number): AgentMemoryProposal {
  const createdAt = new Date(MEMORY_SEED_BASE_MS + sequence * SEED_STEP_MS).toISOString()
  const text = `来自 ${job.originKind === 'workflow' ? '工作流' : '运行'} ${job.originId} 的公开结论摘录`
  return {
    id: `prop-${100 + sequence}`,
    spaceId: job.spaceId,
    status: 'pending',
    originKind: 'extraction',
    originId: job.id,
    createdAt,
    page: {
      slug: `experience/${job.originKind}-${job.originId}`,
      title: `${job.originKind === 'workflow' ? '工作流' : '运行'}经验整理`,
      markdown: `# ${job.originKind === 'workflow' ? '工作流' : '运行'}经验整理\n\n来源 ${job.originId} 的可复用结论（待人工确认）。`,
      kind: 'experience',
      evidence: [{ id: job.originId, kind: job.originKind === 'workflow' ? 'workflow' : 'run', runId: job.runId, text, createdAt, digest: memoryDigest(job.originKind, text), originalCleared: false }],
      sources: [...job.sources],
    },
  }
}

/** 观测页缺省有效期：基准时间加 30 天（与服务端 createWikiPageLocked 同口径）。 */
export function observationExpiry(stamp: string): string {
  return new Date(Date.parse(stamp) + 30 * 24 * 60 * 60 * 1000).toISOString()
}

/** 来源键：与 wiki_context 的 page 依赖口径一致（按 pageId 关联）。 */
export function sourceReferencesPage(sources: readonly AgentWikiRef[], pageId: string): boolean {
  return sources.some((source) => source.pageId === pageId)
}

/**
 * 当前可作手工提炼来源的种子事实：只有带提炼快照的成功来源可被克隆
 * （run-seed-1 → ext-1；wf-seed-1 → ext-2）。run-seed-2 无快照，
 * 手工提交它会得到与服务端一致的「成功来源没有固定的长期记忆提炼快照」。
 */
export const MEMORY_EXTRACTION_SOURCES = {
  runs: [{ id: 'run-seed-1' }],
  workflows: [{ id: 'wf-seed-1' }],
} as const

import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentCapabilityRevocation,
  AgentCapabilityRevocationQuery,
  AgentSkill,
  AgentSkillImportInput,
  AgentSkillImportTask,
} from '@elysian/contracts'
import { AgentHttpError } from '../../http/agent/agentShared'
import { DATASET_BASE_TIME } from '../seed'

/*
 * 技能与 MCP 域演示数据集。种子相对 DATASET_BASE_TIME 确定（刷新回种子）；
 * 导入任务按「每次读取推进一步」的可复现状态机推进：创建 queued → 第一次读取
 * running → 第二次读取终态（来源路径或地址含 broken 时 failed，否则 succeeded 并
 * 落进技能目录）；取消在 queued 时立即 cancelled、running 时标记 cancelRequestedAt
 * 后下一次读取收尾，与服务端 CancelImport 同语义。错误一律抛 AgentHttpError，
 * message/code 与服务端同文（request-conflict、skill-revision-conflict、
 * mcp-catalog-not-found、resource-busy 等），让页面按 code 分支的逻辑在演示与
 * 真实运行时一致。mcp-demo-busy 的探测恒被 resource-busy 拒绝，用于演示
 * 「结果未知，等待管理员核实」路径。
 */

export const AGENT_EXTENSIONS_IMPORT_QUEUE_LIMIT = 32
const IMPORT_HISTORY_LIMIT = 128

type StoredSkill = { revisions: AgentSkill[] }
type StoredImport = { task: AgentSkillImportTask; canonical: string; reads: number; input: AgentSkillImportInput }
export type StoredMCPServer = { value: AgentMCPServer; credential: string; environment: Record<string, string>; history?: AgentMCPServer[] }
type StoredCatalog = { serverId: string; revision: number; projection: AgentMCPCatalogProjection }

type ExtensionsData = {
  skills: StoredSkill[]
  imports: StoredImport[]
  servers: StoredMCPServer[]
  catalogs: StoredCatalog[]
  revocations: AgentCapabilityRevocation[]
  skillSequence: number
  importSequence: number
  serverSequence: number
}

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(DATASET_BASE_TIME) - minutes * 60_000).toISOString()
}

function seedSkill(input: {
  id: string
  revision: number
  enabled: boolean
  name: string
  description: string
  allowedTools?: string
  source: AgentSkill['source']
  digest: string
  bytes: number
  files: AgentSkill['files']
  minutes: number
}): StoredSkill {
  return {
    revisions: [{
      id: input.id,
      revision: input.revision,
      createdAt: minutesAgo(input.minutes),
      enabled: input.enabled,
      source: input.source,
      manifest: {
        name: input.name,
        description: input.description,
        ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      },
      digest: input.digest,
      bytes: input.bytes,
      files: input.files,
    }],
  }
}

const DEMO_SKILL_FILES = [
  { path: 'SKILL.md', size: 4096, digest: 'b10b4d0f1c6e2a88d7f3c9e45a617bc2d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3' },
  { path: 'references/runbook.md', size: 16384, digest: 'c21c5e1f2d7f3b99e8044d9f5a627bc3d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3' },
  { path: 'scripts/collect.py', size: 8192, digest: 'd32d6f2f3e8044c99f0055e0a6b738c4d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3' },
] as const

function seedData(empty = false): ExtensionsData {
  if (empty) {
    return { skills: [], imports: [], servers: [], catalogs: [], revocations: [], skillSequence: 0, importSequence: 0, serverSequence: 0 }
  }
  return {
    skills: [
      seedSkill({
        id: 'skill-demo-incident', revision: 2, enabled: true,
        name: 'incident-triage', description: '按运维手册分流当前事故：先核对告警面，再定位变更窗口。',
        allowedTools: 'docker_containers_list, docker_policy_view',
        source: { kind: 'git', url: 'https://git.example.com/ops/incident-triage.git', ref: 'v1.2.0', commit: '9f1e2a4c5d6e7f8012a3b4c5d6e7f8012a3b4c5' },
        digest: 'sha256-demo-skill-incident', bytes: 28672, files: DEMO_SKILL_FILES, minutes: 4320,
      }),
      seedSkill({
        id: 'skill-demo-backup', revision: 1, enabled: false,
        name: 'backup-verify', description: '核对最近一次备份归档的摘要与保留窗口，输出核查清单。',
        source: { kind: 'directory', path: '/opt/elysian/skills/backup-verify' },
        digest: 'sha256-demo-skill-backup', bytes: 12288,
        files: DEMO_SKILL_FILES.slice(0, 2), minutes: 1440,
      }),
    ],
    imports: [
      {
        task: {
          id: 'import-demo-1', requestId: 'demo-import-1697', state: 'succeeded',
          source: { kind: 'git', url: 'https://git.example.com/ops/incident-triage.git', ref: 'v1.2.0', commit: '9f1e2a4c5d6e7f8012a3b4c5d6e7f8012a3b4c5' },
          createdAt: minutesAgo(4330), startedAt: minutesAgo(4329), endedAt: minutesAgo(4328),
          skillId: 'skill-demo-incident', revision: 2,
        },
        canonical: 'demo-seed-import-1', reads: 99,
        input: { requestId: 'demo-import-1697', source: { kind: 'git', url: 'https://git.example.com/ops/incident-triage.git', ref: 'v1.2.0' }, enabled: true },
      },
      {
        task: {
          id: 'import-demo-2', requestId: 'demo-import-1704', state: 'failed',
          source: { kind: 'zip' }, createdAt: minutesAgo(720), startedAt: minutesAgo(719), endedAt: minutesAgo(718),
          error: { code: 'skill-package-invalid', message: '包内缺少带 frontmatter 的 SKILL.md' },
        },
        canonical: 'demo-seed-import-2', reads: 99,
        input: { requestId: 'demo-import-1704', source: { kind: 'zip' }, enabled: true },
      },
    ],
    servers: [
      { value: { id: 'mcp-demo-http', revision: 2, name: '演示检索（HTTP）', transport: 'streamable-http', url: 'https://mcp.demo.example.com/mcp', active: true, revoked: false, hasCredential: true }, credential: 'demo-credential', environment: {} },
      {
        value: {
          id: 'mcp-demo-stdio', revision: 1, name: '演示文件系统（stdio）', transport: 'stdio',
          stdio: { image: 'docker.io/library/alpine:3.20', command: ['fs-mcp', '--stdio'], grantId: 'grant-demo-readonly', grantRevision: 1, hasEnvironment: true },
          active: true, revoked: false, hasCredential: false,
        },
        credential: '', environment: { MCP_DEMO_TOKEN: 'demo-token' },
      },
      { value: { id: 'mcp-demo-busy', revision: 1, name: '演示探测被阻（租约未核实）', transport: 'streamable-http', url: 'https://mcp.busy.example.com/mcp', active: true, revoked: false, hasCredential: false }, credential: '', environment: {} },
      { value: { id: 'mcp-demo-revoked', revision: 1, name: '演示已撤销服务', transport: 'streamable-http', url: 'https://mcp.revoked.example.com/mcp', active: false, revoked: true, hasCredential: false }, credential: '', environment: {} },
    ],
    catalogs: [],
    revocations: [{ cursor: '1', kind: 'mcp', id: 'mcp-demo-revoked', revision: 0, reason: '管理员永久撤销该服务', createdAt: minutesAgo(60) }],
    skillSequence: 0,
    importSequence: 0,
    serverSequence: 0,
  }
}

let data: ExtensionsData = seedData()

/** 测试与刷新复位：默认回到固定种子；empty 供适配器契约套件从空库起步。 */
export function resetAgentExtensionsData(options?: { empty?: boolean }): void {
  data = options?.empty === true ? seedData(true) : seedData()
}

/** 测试内检视种子（只读快照）。 */
export function agentExtensionsSnapshot(): Readonly<ExtensionsData> {
  return data
}

function stamp(): string {
  return new Date().toISOString()
}

function canonicalImportInput(input: AgentSkillImportInput, archive?: Blob): string {
  const source = [input.source.kind, input.source.path ?? '', input.source.url ?? '', input.source.ref ?? '', input.source.subdirectory ?? ''].join('|')
  return JSON.stringify({ requestId: input.requestId, skillId: input.skillId ?? '', expectedRevision: input.expectedRevision ?? 0, source, enabled: input.enabled, credential: input.credential ?? '', archive: archive === undefined ? '' : `${archive.size}:${archive.type}` })
}

/** 与服务端 capabilityAlias 同式：前缀_ + sha256(id\x00name) 前 12 字节十六进制。 */
async function capabilityAlias(prefix: string, id: string, name: string): Promise<string> {
  const raw = `${id}\x00${name}`
  if (typeof crypto !== 'undefined' && crypto.subtle !== undefined) {
    const bytes = new TextEncoder().encode(raw)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const hex = Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${prefix}_${hex}`
  }
  // 无 SubtleCrypto 环境的确定性回落（仅演示与测试用）。
  let hash = 5381
  for (let index = 0; index < raw.length; index += 1) hash = ((hash * 33) ^ raw.charCodeAt(index)) >>> 0
  return `${prefix}_${hash.toString(16).padStart(12, '0').slice(0, 24)}`
}

function skillNameFromSource(source: AgentSkillImportInput['source']): string {
  if (source.kind === 'directory') return source.path?.split('/').filter(Boolean).pop() ?? 'directory-skill'
  if (source.kind === 'git') return source.url?.split('/').pop()?.replace(/\.git$/, '') ?? 'git-skill'
  return 'uploaded-skill'
}

function commitFromRef(source: AgentSkillImportInput['source']): string {
  return `a1b2c3d4e5f6${(source.ref ?? 'head').length.toString(16).padStart(2, '0')}7890abcdef1234567890abcdef`
}

/** 读取驱动的导入状态机：每次 touch 推进一步，契约与页面轮询都依赖它。 */
function touchImport(record: StoredImport): AgentSkillImportTask {
  record.reads += 1
  const task = record.task
  if (record.reads === 1 && task.state === 'queued' && !task.cancelRequestedAt) {
    task.state = 'running'
    task.startedAt = stamp()
  } else if (record.reads >= 2 && (task.state === 'queued' || task.state === 'running')) {
    finishImport(record)
  }
  return cloneImport(record.task)
}

function finishImport(record: StoredImport): void {
  const task = record.task
  const input = record.input
  task.endedAt = stamp()
  if (task.cancelRequestedAt) {
    task.state = 'cancelled'
    return
  }
  const target = task.source.path ?? task.source.url ?? ''
  if (target.includes('broken')) {
    task.state = 'failed'
    task.error = { code: 'skill-package-invalid', message: '演示导入失败：包内缺少带 frontmatter 的 SKILL.md' }
    return
  }
  task.state = 'succeeded'
  if (input.skillId) {
    const stored = data.skills.find((item) => item.revisions[item.revisions.length - 1]?.id === input.skillId)
    if (stored === undefined) throw new AgentHttpError('技能不存在', 'skill-not-found', 404)
    const latest = stored.revisions[stored.revisions.length - 1]
    if (latest === undefined || latest.revision !== (input.expectedRevision ?? 0)) {
      throw new AgentHttpError('技能修订已变化，请重新读取', 'skill-revision-conflict', 409)
    }
    const next: AgentSkill = { ...structuredClone(latest), revision: latest.revision + 1, createdAt: stamp(), enabled: input.enabled, source: task.source }
    stored.revisions.push(next)
    task.skillId = next.id
    task.revision = next.revision
    return
  }
  data.skillSequence += 1
  const name = skillNameFromSource(task.source)
  const created: AgentSkill = {
    id: `skill-imported-${data.skillSequence}`,
    revision: 1,
    createdAt: stamp(),
    enabled: input.enabled,
    source: task.source,
    manifest: { name, description: `由演示导入的技能包（来源 ${task.source.kind}）。` },
    digest: `sha256-demo-import-${data.skillSequence}`,
    bytes: 20480,
    files: [
      { path: 'SKILL.md', size: 2048, digest: `e5f6a7b8c9d0e1f2a3b4c5d6e7f8012a3b4c5d6e7f8012a3b4c5d6e7f8${data.skillSequence.toString(16).padStart(2, '0')}` },
      { path: 'scripts/run.sh', size: 512, digest: `f6a7b8c9d0e1f2a3b4c5d6e7f80112a3b4c5d6e7f8012a3b4c5d6e7f8${data.skillSequence.toString(16).padStart(2, '0')}` },
    ],
  }
  data.skills.push({ revisions: [created] })
  task.skillId = created.id
  task.revision = created.revision
}

function cloneImport(task: AgentSkillImportTask): AgentSkillImportTask {
  return structuredClone(task)
}

function latestSkill(id: string): AgentSkill | undefined {
  const stored = data.skills.find((item) => item.revisions[item.revisions.length - 1]?.id === id)
  const latest = stored?.revisions[stored.revisions.length - 1]
  return latest === undefined ? undefined : structuredClone(latest)
}

function publicServer(stored: StoredMCPServer): AgentMCPServer {
  const value = structuredClone(stored.value)
  if (value.stdio !== undefined) {
    value.stdio.hasEnvironment = Object.keys(stored.environment).length > 0
  }
  value.hasCredential = stored.credential !== ''
  return value
}

function validateMcpInput(input: AgentMCPServerInput): void {
  if (!input.name.trim() || input.name.length > 120) {
    throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
  }
  if (input.transport === 'streamable-http') {
    let parsed: URL
    try {
      parsed = new URL(input.url ?? '')
    } catch {
      throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.search !== '' || parsed.hash !== '') {
      throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
    }
    if (input.stdio !== undefined) throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
  } else if (input.transport === 'stdio') {
    if (input.url !== undefined && input.url !== '') throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
    if (input.credential !== undefined && input.credential !== '') throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
    const stdio = input.stdio
    if (stdio === undefined || !stdio.image.trim() || stdio.command.length === 0 || stdio.command[0] === '' || stdio.command.length > 64) {
      throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
    }
    const hasGrantId = stdio.grantId !== undefined && stdio.grantId !== ''
    const hasRevision = stdio.grantRevision !== undefined && stdio.grantRevision > 0
    if (hasGrantId !== hasRevision || (stdio.requestedAccess !== undefined && (hasGrantId || hasRevision))) {
      throw new AgentHttpError('MCP 容器授权必须同时固定有效编号和具体修订', 'invalid-mcp-grant', 400)
    }
  } else {
    throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
  }
  if (input.revoked && input.active) {
    throw new AgentHttpError('MCP 服务名称、传输配置或凭据格式无效', 'invalid-mcp-server', 400)
  }
}

/** 演示目录：按服务生成确定性 tools/resources/prompts 与三组别名。 */
async function demoCatalog(serverId: string, revision: number): Promise<AgentMCPCatalogProjection> {
  const tools = [
    { name: `${serverId}-search`, title: '演示检索', description: '在演示数据集中检索条目。', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ]
  const resources = [
    { uri: 'demo://catalog/status', name: 'demo-status', title: '演示目录状态', description: '演示服务的目录状态资源。', mimeType: 'text/plain' },
  ]
  const prompts = [
    { name: 'demo-summary', title: '演示摘要', description: '生成演示摘要提示。', arguments: [{ name: 'topic', description: '摘要主题', required: true }] },
  ]
  const modelAliases: Record<string, string> = {}
  for (const tool of tools) modelAliases[tool.name] = await capabilityAlias('mcp', serverId, tool.name)
  const resourceAliases: Record<string, string> = {}
  for (const resource of resources) resourceAliases[resource.uri] = await capabilityAlias('resource', serverId, resource.uri)
  const promptAliases: Record<string, string> = {}
  for (const prompt of prompts) promptAliases[prompt.name] = await capabilityAlias('prompt', serverId, prompt.name)
  let digestSeed = 5381
  for (const char of `${serverId}\x00${revision}`) digestSeed = ((digestSeed * 33) ^ char.charCodeAt(0)) >>> 0
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: true, resources: true, prompts: true },
    tools, resources, prompts,
    digest: `sha256-demo-catalog-${digestSeed.toString(16)}`,
    fetchedAt: stamp(),
    modelAliases, resourceAliases, promptAliases,
  }
}

async function probeCatalog(stored: StoredMCPServer, revision: number): Promise<AgentMCPCatalogProjection> {
  if (stored.value.id === 'mcp-demo-busy') {
    throw new AgentHttpError('存在冲突执行或未核实的执行结果，暂不能启动 MCP 探测', 'resource-busy', 409)
  }
  const projection = await demoCatalog(stored.value.id, revision)
  const existing = data.catalogs.find((item) => item.serverId === stored.value.id && item.revision === revision && item.projection.digest === projection.digest)
  const record = existing ?? { serverId: stored.value.id, revision, projection }
  if (existing === undefined) data.catalogs.push(record)
  return structuredClone(record.projection)
}

/** 供适配器使用的演示状态操作面；仅 agentExtensionsMockAdapter 消费。 */
export const agentExtensionsDemo = {
  getSkillFile(id: string, revision: number, path: string) {
    const skill = this.getSkill(id, revision)
    const file = skill.files.find((entry) => entry.path === path)
    if (file === undefined) throw new AgentHttpError('技能文件不存在', 'skill-file-not-found', 404)
    const base = { skillId: id, revision, path }
    if (file.size > 256 * 1024) return { ...base, previewable: false as const, reason: 'too-large' as const }
    if (/\.(?:png|jpe?g|zip|pdf)$/i.test(path)) return { ...base, previewable: false as const, reason: 'binary' as const }
    const content = path === 'SKILL.md'
      ? `---\nname: ${skill.manifest.name}\ndescription: ${skill.manifest.description}\n---\n\n# ${skill.manifest.name}\n`
      : path.startsWith('scripts/') ? '#!/usr/bin/env python3\nprint("demo")\n' : '# 运维参考\n\n演示文件内容。\n'
    return { ...base, previewable: true as const, content }
  },
  listRevocations(query?: AgentCapabilityRevocationQuery) {
    const cursor = query?.cursor ?? ''
    if (cursor !== '' && (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
      throw new AgentHttpError('撤销记录游标必须为规范非负十进制字符串', 'invalid-cursor', 400)
    }
    const limit = query?.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AgentHttpError('每页条数必须为 1 到 200 的整数', 'invalid-limit', 400)
    const filtered = data.revocations.filter((item) =>
      Number(item.cursor) > Number(cursor || '0') &&
      (query?.kind === undefined || item.kind === query.kind) &&
      (query?.id === undefined || item.id === query.id))
    const items = filtered.slice(0, limit).map((item) => structuredClone(item))
    return { items, nextCursor: items.at(-1)?.cursor ?? cursor, hasMore: filtered.length > limit }
  },
  listSkills(): AgentSkill[] {
    return data.skills
      .map((item) => item.revisions[item.revisions.length - 1])
      .filter((item): item is AgentSkill => item !== undefined)
      .map((item) => structuredClone(item))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
  },
  getSkill(id: string, revision?: number): AgentSkill {
    const stored = data.skills.find((item) => item.revisions.some((entry) => entry.id === id))
    if (stored === undefined) throw new AgentHttpError('技能不存在', 'skill-not-found', 404)
    const found = revision === undefined
      ? stored.revisions[stored.revisions.length - 1]
      : [...stored.revisions].reverse().find((entry) => entry.revision === revision)
    if (found === undefined) throw new AgentHttpError('技能修订不存在', 'skill-revision-not-found', 404)
    return structuredClone(found)
  },
  setSkillEnabled(id: string, expectedRevision: number, enabled: boolean): AgentSkill {
    const stored = data.skills.find((item) => item.revisions[item.revisions.length - 1]?.id === id)
    const latest = stored?.revisions[stored.revisions.length - 1]
    if (stored === undefined || latest === undefined) throw new AgentHttpError('技能不存在', 'skill-not-found', 404)
    if (latest.revision !== expectedRevision) throw new AgentHttpError('技能修订已变化，请重新读取', 'skill-revision-conflict', 409)
    if (latest.enabled === enabled) return structuredClone(latest)
    const next: AgentSkill = { ...structuredClone(latest), revision: latest.revision + 1, createdAt: stamp(), enabled }
    stored.revisions.push(next)
    return structuredClone(next)
  },
  deleteSkill(id: string, revision: number): AgentSkill {
    const stored = data.skills.find((item) => item.revisions[item.revisions.length - 1]?.id === id)
    const latest = stored?.revisions[stored.revisions.length - 1]
    if (stored === undefined || latest === undefined) throw new AgentHttpError('技能不存在', 'skill-not-found', 404)
    if (latest.revision !== revision) throw new AgentHttpError('技能修订已变化，请重新读取', 'skill-revision-conflict', 409)
    data.skills = data.skills.filter((item) => item !== stored)
    return structuredClone(latest)
  },
  async startImport(input: AgentSkillImportInput, archive?: Blob): Promise<{ task: AgentSkillImportTask; duplicate: boolean }> {
    if (input.source.kind === 'zip' && archive === undefined) {
      throw new AgentHttpError('ZIP 导入必须提供上传内容', 'missing-zip', 400)
    }
    if (input.source.kind !== 'zip' && archive !== undefined) {
      throw new AgentHttpError('该导入类型不接受 ZIP 上传', 'unexpected-zip', 400)
    }
    const canonical = canonicalImportInput(input, archive)
    const active = data.imports.filter((item) => item.task.state === 'queued' || item.task.state === 'running').length
    for (const record of data.imports) {
      if (record.task.requestId === input.requestId) {
        if (record.canonical !== canonical) throw new AgentHttpError('该请求标识已用于不同的技能导入', 'request-conflict', 409)
        return { task: cloneImport(record.task), duplicate: true }
      }
    }
    if (active >= AGENT_EXTENSIONS_IMPORT_QUEUE_LIMIT) {
      throw new AgentHttpError('技能导入队列已满', 'import-queue-full', 429)
    }
    if (input.skillId !== undefined && input.skillId !== '') {
      const latest = latestSkill(input.skillId)
      if (latest === undefined) throw new AgentHttpError('技能不存在', 'skill-not-found', 404)
      if (latest.revision !== input.expectedRevision) throw new AgentHttpError('技能修订已变化，请重新读取', 'skill-revision-conflict', 409)
    }
    data.importSequence += 1
    const task: AgentSkillImportTask = {
      id: `import-${data.importSequence}`,
      requestId: input.requestId,
      state: 'queued',
      source: structuredClone({ ...input.source, ...(input.source.kind === 'git' ? { commit: commitFromRef(input.source) } : {}) }),
      createdAt: stamp(),
      ...(input.skillId !== undefined && input.skillId !== '' ? { skillId: input.skillId } : {}),
    }
    const record: StoredImport = { task, canonical, reads: 0, input }
    data.imports.push(record)
    return { task: cloneImport(task), duplicate: false }
  },
  getImport(id: string): AgentSkillImportTask {
    const record = data.imports.find((item) => item.task.id === id)
    if (record === undefined) throw new AgentHttpError('技能导入任务不存在', 'import-not-found', 404)
    return touchImport(record)
  },
  listImports(cursor: string, limit: number): { items: AgentSkillImportTask[]; nextCursor: string; hasMore: boolean } {
    const size = limit === 0 ? 50 : limit
    const offset = cursor === '' ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentHttpError('技能导入分页游标无效', 'invalid-cursor', 400)
    const items: AgentSkillImportTask[] = []
    let hasMore = false
    let nextCursor = ''
    for (let index = data.imports.length - 1 - offset; index >= 0; index -= 1) {
      const record = data.imports[index]
      if (record === undefined) continue
      if (items.length === size) {
        hasMore = true
        nextCursor = String(offset + size)
        break
      }
      items.push(touchImport(record))
    }
    return { items, nextCursor, hasMore }
  },
  cancelImport(id: string): AgentSkillImportTask {
    const record = data.imports.find((item) => item.task.id === id)
    if (record === undefined) throw new AgentHttpError('技能导入任务不存在', 'import-not-found', 404)
    const task = record.task
    if (task.state !== 'queued' && task.state !== 'running') return cloneImport(task)
    if (!task.cancelRequestedAt) {
      task.cancelRequestedAt = stamp()
      if (task.state === 'queued') {
        task.state = 'cancelled'
        task.endedAt = stamp()
      }
    }
    return cloneImport(task)
  },
  deleteImport(id: string): AgentSkillImportTask {
    const record = data.imports.find((item) => item.task.id === id)
    if (record === undefined) throw new AgentHttpError('技能导入任务不存在', 'import-not-found', 404)
    if (record.task.state === 'queued' || record.task.state === 'running') {
      throw new AgentHttpError('导入任务尚未结束，不能删除记录', 'import-not-finished', 409)
    }
    data.imports = data.imports.filter((item) => item !== record)
    pruneImportHistory()
    return cloneImport(record.task)
  },
  listServers(): AgentMCPServer[] {
    return data.servers.map(publicServer)
  },
  createServer(input: AgentMCPServerInput): AgentMCPServer {
    validateMcpInput(input)
    data.serverSequence += 1
    const environment = input.stdio?.environment === undefined ? {} : { ...input.stdio.environment }
    const stored: StoredMCPServer = {
      value: {
        id: `mcp-${data.serverSequence}`,
        revision: 1,
        name: input.name.trim(),
        transport: input.transport,
        ...(input.transport === 'streamable-http' ? { url: (input.url ?? '').trim() } : {}),
        ...(input.transport === 'stdio' && input.stdio !== undefined ? {
          stdio: {
            image: input.stdio.image,
            command: [...input.stdio.command],
            hasEnvironment: Object.keys(environment).length > 0,
            ...(input.stdio.requestedAccess === undefined ? {} : { requestedAccess: structuredClone(input.stdio.requestedAccess) }),
            ...(input.stdio.grantId !== undefined && input.stdio.grantId !== '' ? { grantId: input.stdio.grantId } : {}),
            ...(input.stdio.grantRevision !== undefined ? { grantRevision: input.stdio.grantRevision } : {}),
          },
        } : {}),
        active: input.active,
        revoked: input.revoked,
        hasCredential: (input.credential ?? '') !== '',
      },
      credential: input.credential ?? '',
      environment,
    }
    data.servers.push(stored)
    return publicServer(stored)
  },
  getServer(id: string, revision: number): AgentMCPServer {
    const stored = data.servers.find((item) => item.value.id === id)
    if (stored === undefined) throw new AgentHttpError('MCP 服务不存在', 'mcp-not-found', 404)
    const record = stored.value.revision === revision ? publicServer(stored) : stored.history?.find(item => item.revision === revision)
    if (!record) throw new AgentHttpError('MCP 配置修订不存在', 'mcp-revision-not-found', 404)
    return structuredClone(record)
  },
  updateServer(id: string, expectedRevision: number, input: AgentMCPServerInput): AgentMCPServer {
    const stored = data.servers.find((item) => item.value.id === id)
    if (stored === undefined) throw new AgentHttpError('MCP 服务不存在', 'mcp-not-found', 404)
    if (stored.value.revoked) throw new AgentHttpError('已撤销的 MCP 服务不能恢复，请创建新的配置', 'mcp-revoked', 409)
    if (stored.value.revision !== expectedRevision) throw new AgentHttpError('MCP 配置已修改，请重新读取后重试', 'revision-conflict', 409)
    validateMcpInput(input)
    stored.history = [...(stored.history ?? []), publicServer(stored)]
    if (input.credential !== undefined) stored.credential = input.credential
    if (input.stdio?.environment !== undefined) stored.environment = { ...input.stdio.environment }
    stored.value = {
      id: stored.value.id,
      revision: stored.value.revision + 1,
      name: input.name.trim(),
      transport: input.transport,
      ...(input.transport === 'streamable-http' ? { url: (input.url ?? '').trim() } : {}),
      ...(input.transport === 'stdio' && input.stdio !== undefined ? {
        stdio: {
          image: input.stdio.image,
          command: [...input.stdio.command],
          hasEnvironment: Object.keys(stored.environment).length > 0,
          ...(input.stdio.requestedAccess === undefined ? {} : { requestedAccess: structuredClone(input.stdio.requestedAccess) }),
            ...(input.stdio.grantId !== undefined && input.stdio.grantId !== '' ? { grantId: input.stdio.grantId } : {}),
          ...(input.stdio.grantRevision !== undefined ? { grantRevision: input.stdio.grantRevision } : {}),
        },
      } : {}),
      active: input.active,
      revoked: input.revoked,
      hasCredential: stored.credential !== '',
    }
    return publicServer(stored)
  },
  async probe(id: string, revision: number): Promise<AgentMCPCatalogProjection> {
    const stored = data.servers.find((item) => item.value.id === id)
    if (stored === undefined) throw new AgentHttpError('MCP 服务不存在', 'mcp-not-found', 404)
    if (stored.value.revision !== revision) throw new AgentHttpError('MCP 配置修订不存在', 'mcp-revision-not-found', 404)
    if (stored.value.revoked || data.revocations.some((entry) => entry.kind === 'mcp' && entry.id === id && (entry.revision === 0 || entry.revision === revision))) {
      throw new AgentHttpError('MCP 服务已永久撤销，不能探测', 'mcp-revoked', 409)
    }
    if (!stored.value.active) throw new AgentHttpError('MCP 服务已停用，不能开始新运行', 'mcp-inactive', 409)
    return probeCatalog(stored, revision)
  },
  async catalog(id: string, revision: number, digest: string): Promise<AgentMCPCatalogProjection> {
    const stored = data.servers.find((item) => item.value.id === id)
    if (stored === undefined) throw new AgentHttpError('MCP 服务不存在', 'mcp-not-found', 404)
    if (stored.value.revision !== revision && !stored.history?.some(item => item.revision === revision)) throw new AgentHttpError('MCP 配置修订不存在', 'mcp-revision-not-found', 404)
    const record = [...data.catalogs].reverse().find((item) => item.serverId === id && item.revision === revision && (digest === '' || item.projection.digest === digest))
    if (record === undefined) throw new AgentHttpError('MCP 服务尚无匹配的已验证目录', 'mcp-catalog-not-found', 404)
    return structuredClone(record.projection)
  },
}

/** 终态记录超出滚动保留条数时丢弃最旧的终态记录（同服务端 ImportHistory）。 */
function pruneImportHistory(): void {
  const excess = data.imports.length - IMPORT_HISTORY_LIMIT
  if (excess <= 0) return
  let dropped = 0
  data.imports = data.imports.filter((item) => {
    if (dropped >= excess) return true
    if (item.task.state === 'queued' || item.task.state === 'running') return true
    dropped += 1
    return false
  })
}

import { MOCK_WEBSITE_RUNTIME_REPORT } from './websiteRuntimeCatalog'
import {
  effectivePortHostIp,
  hostPortBindingsOverlap,
} from '../../features/container/containerCreateForm'
import type {
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  Container,
  ContainerAction,
  ContainerCreateInput,
  ContainerImage,
  ImagePullProgress,
  DependencyProbeReport,
  DependencySetupResult,
  ElysianEvent,
  EventStreamHandlers,
  FileEntry,
  FileSearchResult,
  FirewallForwardInput,
  FirewallForwardRule,
  FirewallImportResult,
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
  HostUser,
  HostUserInput,
  Incident,
  IncidentListRow,
  LoginLogListReport,
  LogClearReport,
  LogStorageStats,
  ModuleStatus,
  OperationLogEntry,
  OperationLogListReport,
  PlatformLogCategory,
  RuntimeLogEntry,
  RuntimeLogListReport,
  Skill,
  SshAuthMethods,
  SshAuthSettings,
  SshLoginKey,
  SshLoginRecord,
  SshOverview,
  SshPasswordResetResult,
  SshRootAuth,
  SshRootLoginPolicy,
  Unsubscribe,
  WebsiteListReport,
  WebsiteProject,
  WebsiteAccessInput,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProjectUpdateInput,
  WebsiteProxyStatus,
} from '@elysian/contracts'
import {
  PLATFORM_LOG_CATEGORY_LABELS,
  SEVERITY_RANK,
  SSH_KEY_NAME_MAX_LENGTH,
  formatLogBytes,
  isValidHostUserName,
  isValidSshKeyName,
  isValidSshPort,
} from '@elysian/contracts'
import type {
  ApprovalAdapter,
  AuditAdapter,
  ContainerAdapter,
  DependenciesAdapter,
  HostTerminalHandlers,
  HostTerminalSessionInfo,
  EventsAdapter,
  FilesAdapter,
  FilePermissionInput,
  FirewallAdapter,
  IncidentAdapter,
  IncidentListQuery,
  IncidentListResult,
  LogsAdapter,
  RunAdapter,
  SessionAdapter,
  SessionListRow,
  PanelPasswordChangeInput,
  SessionStatus,
  SkillAdapter,
  SshAdapter,
  SshKeyAccount,
  UserAdapter,
  WebsitesAdapter,
  WebsiteMutateResult,
} from '../../contracts/adapters'
import {
  addFirewallForward,
  addFirewallIpRule,
  addFirewallRule,
  findDuplicateForward,
  findDuplicateFirewallRule,
  findDuplicateIpRule,
  getFirewallForwards,
  getFirewallIpRules,
  getFirewallRules,
  getFirewallToggles,
  getScanProtection,
  importFirewallRules,
  removeFirewallForward,
  removeFirewallIpRule,
  removeFirewallRule,
  setFirewallToggles,
  setScanConfigFirewall,
  setScanProtection,
  unblockScanIp,
  updateFirewallForward,
  updateFirewallIpRule,
  updateFirewallRule,
} from './firewallData'
import {
  addHostUser,
  findHostUserById,
  findHostUserByName,
  getHostUsers,
  removeHostUser,
  updateHostUser,
} from './usersData'
import {
  addSshLoginKey,
  findSshLoginKeyByName,
  generateSshRootKey,
  getSshAuthSettings,
  getSshLoginKeys,
  getSshLoginRecords,
  getSshOverview,
  getSshRootAuth,
  removeSshLoginKey,
  removeSshLoginKeysByUser,
  resetSshRootPassword,
  saveSshAuthSettings,
  saveSshRootLoginPolicy,
  setSshServiceEnabled,
} from './sshData'
import { completeTerminalCommand, execContainerCommand } from './containerTerminal'
import {
  chmodMockEntry,
  compressMockEntry,
  copyMockEntry,
  listMockDirectory,
  measureMockDirectory,
  moveMockEntry,
  renameMockEntry,
  searchMockFiles,
} from './filesData'
import {
  getLoginLogs,
  operationLogEntries,
  replaceOperationLogEntries,
  replaceRuntimeLogEntries,
  runtimeLogEntries,
} from './logsData'
import {
  addWebsiteProject,
  getWebsiteLogs,
  getWebsiteProjects,
  removeWebsiteProject,
  setWebsiteProjectAccess,
  setWebsiteProjectRunning,
  updateWebsiteProject,
} from './websitesData'
import { mockImageArtifact } from './containersData'
import { autoContainerName } from '@elysian/contracts'
import {
  INITIAL_DISKS,
  INITIAL_LOAD,
  nextDisksWalk,
  nextLoadWalk,
} from './resourceMetrics'
import { toIncidentListRows } from './dataset'
import type { MockDataset } from './dataset'

/*
 * 各个领域的 mock 适配实现。它们共用同一份内存数据集，
 * 因此审批、审计、事件流之间引用的标识是一致的。
 */

function matches(selected: readonly string[] | undefined, value: string | undefined): boolean {
  if (!selected || selected.length === 0) return true
  if (value === undefined) return false
  return selected.includes(value)
}

export function sortRows(
  rows: readonly IncidentListRow[],
  sort: IncidentListQuery['sort'],
): IncidentListRow[] {
  const sorted = [...rows]
  switch (sort) {
    case 'detected-asc':
      return sorted.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    case 'severity':
      return sorted.sort((a, b) => {
        const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        if (bySeverity !== 0) return bySeverity
        return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
      })
    case 'detected-desc':
    default:
      return sorted.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
}

export class MockIncidentAdapter implements IncidentAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async listRows(query: IncidentListQuery): Promise<IncidentListResult> {
    const rows = toIncidentListRows(this.dataset())
    const filtered = rows.filter(
      (row) =>
        matches(query.severities, row.severity) &&
        matches(query.statuses, row.status) &&
        matches(query.sources, row.source),
    )
    const availableSources = [...new Set(rows.map((row) => row.source))].sort()
    return {
      rows: sortRows(filtered, query.sort),
      total: filtered.length,
      availableSources,
    }
  }

  async find(incidentId: string): Promise<Incident | undefined> {
    return this.dataset().incidents.find((incident) => incident.id === incidentId)
  }
}

export class MockSkillAdapter implements SkillAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly Skill[]> {
    return this.dataset().skills
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<Skill> {
    const dataset = this.dataset()
    const index = dataset.skills.findIndex((candidate) => candidate.id === skillId)
    const current = index >= 0 ? dataset.skills[index] : undefined
    if (!current) throw new Error(`技能不存在：${skillId}`)
    const updated: Skill = { ...current, enabled }
    dataset.skills[index] = updated
    return updated
  }
}

export class MockApprovalAdapter implements ApprovalAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly ApprovalRequest[]> {
    return this.dataset().approvals
  }

  async decide(
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ): Promise<ApprovalRequest> {
    const dataset = this.dataset()
    const index = dataset.approvals.findIndex((candidate) => candidate.id === requestId)
    const current = index >= 0 ? dataset.approvals[index] : undefined
    if (!current) throw new Error(`审批请求不存在：${requestId}`)

    const decidedAt = new Date().toISOString()
    const updated: ApprovalRequest = {
      ...current,
      status: decision.outcome === 'rejected' ? 'rejected' : 'approved',
      outcome: decision.outcome,
      decidedBy: '当前用户',
      decidedAt,
      note: decision.note,
    }
    dataset.approvals[index] = updated

    // 审批决定必须留下审计痕迹：审计日志页刷新后就能看到这一条。
    const decisionLabel = decision.outcome === 'rejected' ? '已拒绝' : '已批准'
    dataset.audit.unshift({
      id: `${requestId}-DECISION`,
      at: decidedAt,
      kind: 'approval',
      actor: '当前用户',
      subject: current.target,
      summary: `审批决定：${decisionLabel} · ${current.actionTitle}`,
      detail: `风险 ${current.riskLevel}；影响范围：${current.blastRadius}；决策结果 ${decision.outcome}`,
      traceId: `approval-${requestId}`,
    })
    // 审计列表约定按时间倒序，插入后重排，避免时钟与种子基准时间不一致时顺序错乱。
    dataset.audit.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

    return updated
  }
}

export class MockAuditAdapter implements AuditAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AuditRecord[]> {
    return this.dataset().audit
  }
}

/**
 * 会话与权限的 mock 实现：演示环境全部放行。
 * 让「无权限」分支真实存在但默认不触发——接入认证后换成真实实现即可，界面不用改。
 */
/**
 * 会话的 mock 实现：演示模式恒放行，登录与登出直接成功（本地无后端，不强制登录）。
 * 内存持有一份演示会话列表：种子两行（当前会话 −2 小时创建、另一会话 −3 天创建、
 * −1 小时活跃），相对偏移确定、绝对值随取用时刻（与审批 mock 用 new Date() 同口径）。
 */
/** 演示模式没有真实凭据可改，如实失败而不是伪装成功（红线：绝不把演示状态呈现为已执行）。 */
const DEMO_PASSWORD_MIN_LENGTH = 8

export class MockSessionAdapter implements SessionAdapter {
  private rows: SessionListRow[]

  constructor() {
    const nowMs = Date.now()
    this.rows = [
      {
        createdAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
        lastUsedAt: new Date(nowMs).toISOString(),
        current: true,
      },
      {
        createdAt: new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString(),
        lastUsedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        current: false,
      },
    ]
  }

  async canView(): Promise<boolean> {
    return true
  }

  async status(): Promise<SessionStatus> {
    return { mode: 'demo', authenticated: true, devAccount: false }
  }

  async login(): Promise<void> {}

  async logout(): Promise<void> {}

  async listSessions(): Promise<readonly SessionListRow[]> {
    // 当前行在前（其 lastUsedAt 恒为最新），与服务端「按最近活跃倒序」同一呈现。
    return [...this.rows]
  }

  async changePassword(input: PanelPasswordChangeInput): Promise<void> {
    // 与服务端同一次序校验（先一致性、后长度）；校验通过即抛演示不支持。
    if (input.newPassword !== input.confirmNewPassword) throw new Error('两次输入的密码不一致')
    if (input.newPassword.length < DEMO_PASSWORD_MIN_LENGTH) throw new Error('密码至少需要 8 位')
    throw new Error('演示模式不支持修改面板密码')
  }

  async logoutOtherSessions(): Promise<void> {
    this.rows = this.rows.filter((row) => row.current)
  }
}

/** 文件目录的 mock 实现：读手工种子的目录树；列举与统计只读，四个变更动作只改内存数据。 */
export class MockFilesAdapter implements FilesAdapter {
  async list(dirPath: string): Promise<readonly FileEntry[]> {
    return listMockDirectory(dirPath)
  }

  async size(dirPath: string): Promise<number> {
    // 目录大小统计模拟真实 du 的耗时：给界面的等待状态留一个可见的窗口。
    await new Promise((resolve) => setTimeout(resolve, FILES_SIZE_DELAY_MS))
    return measureMockDirectory(dirPath)
  }

  async copyEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
    return copyMockEntry(srcPath, destDirPath)
  }

  async moveEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
    return moveMockEntry(srcPath, destDirPath)
  }

  async renameEntry(path: string, newName: string): Promise<FileEntry> {
    return renameMockEntry(path, newName)
  }

  async compressEntry(path: string): Promise<FileEntry> {
    return compressMockEntry(path)
  }

  async chmod(path: string, input: FilePermissionInput): Promise<void> {
    chmodMockEntry(path, input)
  }

  async search(keyword: string): Promise<readonly FileSearchResult[]> {
    return searchMockFiles(keyword)
  }
}

/**
 * 清空留痕的进程内序号：起点取 1000，避开种子条目已占用的编号，
 * 让「留痕」的 id 与种子条目的 id 形式一致且互不冲突（uuid 只要求响应内唯一）。
 */
let nextClearTraceSeq = 1000

/** jsonl 行的 UTF-8 字节数：与写盘口径一致，界面「日志大小」显示的就是这个数。 */
function logEntriesBytes(entries: readonly object[]): number {
  const encoder = new TextEncoder()
  return entries.reduce((sum, entry) => sum + encoder.encode(`${JSON.stringify(entry)}\n`).length, 0)
}

/** 分片数：真实实现按 UTC 自然日滚动分片，这里按条目时间分组得到同样的量级。 */
function logShardCount(entries: readonly { at: string }[]): number {
  return new Set(entries.map((entry) => entry.at.slice(0, 10))).size
}

/** 存储统计：两类条目的字节、分片数与最旧时间为两类合计（口径与真实实现的 collectStorageStats 一致）。 */
function logStorage(
  runtime: readonly RuntimeLogEntry[],
  operation: readonly OperationLogEntry[],
): LogStorageStats {
  const runtimeBytes = logEntriesBytes(runtime)
  const operationBytes = logEntriesBytes(operation)
  const oldest = [...runtime, ...operation].map((entry) => entry.at).sort()[0]
  return {
    totalBytes: runtimeBytes + operationBytes,
    runtimeBytes,
    operationBytes,
    fileCount: logShardCount(runtime) + logShardCount(operation),
    oldestAt: oldest ?? null,
    lastSweepAt: null,
    trimmedBySize: false,
    droppedRecords: 0,
    failedWrites: 0,
  }
}

function oldestAtOf(entries: readonly { at: string }[]): string | null {
  return [...entries].map((entry) => entry.at).sort()[0] ?? null
}

/** 清空一条运行日志留痕（与真实服务端同款文案与来源）。 */
function runtimeClearTrace(category: PlatformLogCategory, report: LogClearReport, at: string): RuntimeLogEntry {
  return {
    id: `${at}#${(nextClearTraceSeq += 1)}`,
    at,
    level: 'warning',
    source: 'logs.clear',
    message: `${PLATFORM_LOG_CATEGORY_LABELS[category]}已清空：删除 ${report.fileCount} 个文件，释放 ${formatLogBytes(report.totalBytes)}`,
  }
}

/** 清空一条操作日志留痕：动作、方法、路径与真实服务端的采集结果同形。 */
function operationClearTrace(category: PlatformLogCategory, report: LogClearReport, at: string): OperationLogEntry {
  return {
    id: `${at}#${(nextClearTraceSeq += 1)}`,
    at,
    category: 'logs',
    action: `清空${PLATFORM_LOG_CATEGORY_LABELS[category]}`,
    target: null,
    summary: `删除 ${report.fileCount} 个文件，释放 ${formatLogBytes(report.totalBytes)}`,
    result: 'success',
    method: 'POST',
    path: `/api/logs/${category}/clear`,
    httpStatus: 200,
  }
}

/**
 * 日志的 mock 实现：读内存里的条目数组（种子见 logsData），列表返回报告。
 * 清空改写内存数组并留下本次清空的留痕——与真实服务端同形的自指留痕（规格 7.2）：
 * 被清空的类别清空后最多剩一条记录，且那条就是清空动作自己。
 * 列表不设截断：演示数据只有几百条，远低于服务端的单次读取上限。
 */
export class MockLogsAdapter implements LogsAdapter {
  async runtimeLog(): Promise<RuntimeLogListReport> {
    const entries = runtimeLogEntries()
    return {
      entries,
      total: entries.length,
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(entries, operationLogEntries()),
    }
  }

  async loginLogs(): Promise<LoginLogListReport> {
    const entries = getLoginLogs()
    return {
      entries,
      total: entries.length,
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
    }
  }

  async operationLogs(): Promise<OperationLogListReport> {
    const entries = operationLogEntries()
    return {
      entries,
      total: entries.length,
      truncated: false,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(runtimeLogEntries(), entries),
    }
  }

  async clearLogs(category: PlatformLogCategory): Promise<LogClearReport> {
    const cleared = category === 'runtime' ? runtimeLogEntries() : operationLogEntries()
    const clearedAt = new Date().toISOString()
    // 报告回的是**已删除的事实**：条目前的字节、分片数与最旧时间。
    const report: LogClearReport = {
      category,
      fileCount: logShardCount(cleared),
      totalBytes: logEntriesBytes(cleared),
      oldestAt: oldestAtOf(cleared),
      clearedAt,
    }
    const trace = runtimeClearTrace(category, report, clearedAt)
    if (category === 'runtime') {
      // 清空运行日志：新文件里只剩这条 warning 留痕。
      replaceRuntimeLogEntries([trace])
    } else {
      // 清空操作日志：操作日志里只剩这条成功留痕；清空动作本身同时记进运行日志（服务端同样如此）。
      replaceOperationLogEntries([operationClearTrace(category, report, clearedAt)])
      replaceRuntimeLogEntries([...runtimeLogEntries(), trace])
    }
    return report
  }
}

/** 演示目录大小统计的固定耗时；测试想控制节奏时注入自己的 FilesAdapter。 */
const FILES_SIZE_DELAY_MS = 400

export class MockRunAdapter implements RunAdapter {
  constructor(private readonly dataset: () => MockDataset) {}

  async list(): Promise<readonly AgentRun[]> {
    return this.dataset().runs
  }

  async find(runId: string): Promise<AgentRun | undefined> {
    return this.dataset().runs.find((run) => run.id === runId)
  }

  async listModuleStatuses(): Promise<readonly ModuleStatus[]> {
    return this.dataset().moduleStatuses
  }
}

type MockContainerTerminalSession = {
  containerId: string
  handlers: HostTerminalHandlers
}

export class MockContainerAdapter implements ContainerAdapter {
  private nextTerminalId = 1
  private readonly terminalSessions = new Map<string, MockContainerTerminalSession>()

  constructor(
    private readonly dataset: () => MockDataset,
    private readonly hooks: {
      onAction: (containerId: string) => void
      scheduleRestart: (containerId: string) => void
      onCreate: (containerId: string) => void
    },
  ) {}

  async list(): Promise<readonly Container[]> {
    return [...this.dataset().containers]
  }

  async listImages(): Promise<readonly ContainerImage[]> {
    return [...this.dataset().images]
  }

  async searchImageNames(term: string, registry?: string): Promise<{ names: readonly string[]; searchable: boolean }> {
    if (registry?.trim() && registry.trim() !== 'https://registry-1.docker.io') {
      return { names: [], searchable: false }
    }
    const repositories = [...new Set([
      'alpine', 'busybox', 'docker', 'mysql', 'nginx', 'node', 'postgres', 'redis', 'ubuntu',
      ...this.dataset().images.map((image) => image.name),
    ])].sort()
    const query = term.trim().toLowerCase()
    return { names: repositories.filter((name) => name.includes(query)), searchable: true }
  }

  async imageTags(name: string, registry?: string): Promise<{ tags: readonly string[]; searchable: boolean }> {
    if (registry?.trim() && registry.trim() !== 'https://registry-1.docker.io') {
      return { tags: [], searchable: false }
    }
    const examples: Record<string, string[]> = {
      alpine: ['latest', '3.21', '3.20'],
      nginx: ['latest', '1.27', '1.26-alpine'],
      redis: ['latest', '8-alpine', '7-alpine'],
      ubuntu: ['latest', '24.04', '22.04'],
    }
    const tags = examples[name] ?? ['latest']
    return { tags: [...new Set([...tags, ...this.dataset().images.filter((image) => image.name === name).map((image) => image.tag)])], searchable: true }
  }

  async createPolicy(): Promise<{ mountRoot: string; reservedPorts: readonly number[] }> {
    return { mountRoot: '/srv/elysian', reservedPorts: [48100] }
  }

  async connectTerminal(
    containerId: string,
    handlers: HostTerminalHandlers,
  ): Promise<HostTerminalSessionInfo> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const id = `ctr-term-${this.nextTerminalId}`
    this.nextTerminalId += 1
    this.terminalSessions.set(id, { containerId, handlers })
    return { id, user: 'demo', hostLabel: container.name, prompt: '$ ' }
  }

  async sendTerminalInput(sessionId: string, line: string): Promise<void> {
    const session = this.requireTerminalSession(sessionId)
    const container = this.dataset().containers.find((c) => c.id === session.containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const image = this.dataset().images.find((i) => i.id === container.imageId)
    if (!image) throw new Error('容器所用镜像不存在，无法执行演示终端命令')
    const { lines } = execContainerCommand(container, image, line)
    if (lines.length > 0) {
      session.handlers.onFrame(sessionId, { type: 'output', lines })
    }
  }

  async interruptTerminal(sessionId: string): Promise<void> {
    this.requireTerminalSession(sessionId)
  }

  completeTerminal(sessionId: string, draft: string, cursor: number) {
    if (!this.terminalSessions.has(sessionId)) return { draft, cursor }
    return completeTerminalCommand(draft, cursor)
  }

  async disconnectTerminal(sessionId: string): Promise<void> {
    if (!this.terminalSessions.delete(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
  }

  /** 取消未决的终端连接：mock 的 connectTerminal 同步 resolve，没有 pending 概念，no-op。 */
  cancelTerminalConnect(): void {}

  private requireTerminalSession(sessionId: string): MockContainerTerminalSession {
    const session = this.terminalSessions.get(sessionId)
    if (!session) throw new Error(`终端会话不存在 ${sessionId}`)
    return session
  }

  async requestAction(containerId: string, action: ContainerAction): Promise<Container> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，操作失败')
    if (action === 'start') {
      container.status = 'running'
      container.startedAt = new Date().toISOString()
    } else if (action === 'stop') {
      container.status = 'stopped'
      container.startedAt = undefined
    } else {
      container.status = 'restarting'
      this.hooks.scheduleRestart(containerId)
    }
    this.hooks.onAction(containerId)
    return { ...container }
  }

  async create(input: ContainerCreateInput): Promise<Container> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === input.imageId)
    if (!image) throw new Error('镜像不存在，无法创建容器')
    const name = input.name?.trim() || autoContainerName(dataset.containers, image.name)
    if (dataset.containers.some((c) => c.name === name)) {
      throw new Error(`容器名称已存在：${name}`)
    }
    const policy = await this.createPolicy()
    for (const port of input.ports) {
      if (policy.reservedPorts.includes(port.hostPort)) {
        throw new Error(`宿主端口为面板保留：${port.hostPort}`)
      }
      const hostIp = effectivePortHostIp(port.hostIp)
      const conflicts = (entry: { hostPort: number; protocol: string; hostIp?: string }) =>
        entry.hostPort === port.hostPort &&
        entry.protocol === port.protocol &&
        hostPortBindingsOverlap(hostIp, effectivePortHostIp(entry.hostIp))
      if (dataset.containers.some((container) => container.ports.some(conflicts))) {
        throw new Error('宿主端口已被占用')
      }
      const dupInInput = input.ports.some(
        (other) =>
          other !== port &&
          other.hostPort === port.hostPort &&
          other.protocol === port.protocol &&
          hostPortBindingsOverlap(hostIp, effectivePortHostIp(other.hostIp)),
      )
      if (dupInInput) {
        throw new Error('宿主端口已被占用')
      }
    }
    const now = new Date().toISOString()
    const container: Container = {
      id: `ctr-${name}`,
      name,
      status: 'running',
      imageId: input.imageId,
      ports: input.ports.map((p) => ({ ...p })),
      createdAt: now,
      startedAt: now,
      command: input.command?.trim() ?? '',
      env: input.env.map((e) => ({ ...e })),
      volumes: input.volumes.map((v) => ({ ...v })),
      restartPolicy: input.restartPolicy,
    }
    dataset.containers.push(container)
    this.hooks.onCreate(container.id)
    return { ...container }
  }

  async removeImage(imageId: string): Promise<void> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === imageId)
    if (!image) throw new Error('镜像不存在，删除失败')
    if (dataset.containers.some((c) => c.imageId === imageId)) {
      throw new Error('镜像仍被容器引用，删除失败')
    }
    dataset.images = dataset.images.filter((i) => i.id !== imageId)
  }

  async pullImage(input: { name: string; tag: string; registry?: string }, onProgress?: (progress: ImagePullProgress) => void): Promise<ContainerImage> {
    // registry 只是界面记录的拉取源：mock 不区分来源，全部走同一份确定性数据。
    const dataset = this.dataset()
    if (dataset.images.some((i) => i.name === input.name && i.tag === input.tag)) {
      throw new Error(`镜像已存在：${input.name}:${input.tag}`)
    }
    if (onProgress) {
      for (const currentBytes of [0, 25, 65, 100]) {
        onProgress({ phase: currentBytes === 100 ? 'finalizing' : 'downloading', layerId: '演示镜像层', currentBytes: currentBytes * 1024 * 1024, totalBytes: 100 * 1024 * 1024 })
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const { id, digest, sizeMb } = mockImageArtifact(input.name, input.tag)
    const image: ContainerImage = {
      id,
      name: input.name,
      tag: input.tag,
      digest,
      sizeMb,
      pulledAt: new Date().toISOString(),
    }
    dataset.images.push(image)
    return { ...image }
  }

  watchLive(handlers: {
    onEvent: (event: ElysianEvent) => void
    onStatus: (status: 'live' | 'connecting') => void
  }): Unsubscribe {
    handlers.onStatus('live')
    return () => {}
  }
}

/** 同步规则的模拟耗时：留出一拍让「同步中」的忙碌态可见。 */
const SYNC_DELAY_MS = 800

/** 同步账号用同一个节奏，两个页签的忙碌态观感一致。 */
const HOST_USER_SYNC_DELAY_MS = SYNC_DELAY_MS

export class MockFirewallAdapter implements FirewallAdapter {
  async list(): Promise<readonly FirewallRule[]> {
    return getFirewallRules()
  }

  async toggles(): Promise<FirewallToggles> {
    return getFirewallToggles()
  }

  async setToggles(next: FirewallToggles): Promise<FirewallToggles> {
    return setFirewallToggles(next)
  }

  async create(input: FirewallRuleInput): Promise<FirewallRule> {
    if (findDuplicateFirewallRule(input)) {
      throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
    }
    return addFirewallRule(input, new Date().toISOString())
  }

  async update(ruleId: string, input: FirewallRuleInput): Promise<FirewallRule> {
    if (findDuplicateFirewallRule(input, ruleId)) {
      throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
    }
    return updateFirewallRule(ruleId, input, new Date().toISOString())
  }

  async remove(ruleId: string): Promise<void> {
    removeFirewallRule(ruleId)
  }

  async importRules(inputs: readonly FirewallRuleInput[]): Promise<FirewallImportResult> {
    return importFirewallRules(inputs, new Date().toISOString())
  }

  async listIpRules(): Promise<readonly FirewallIpRule[]> {
    return getFirewallIpRules()
  }

  async createIpRule(input: FirewallIpRuleInput): Promise<FirewallIpRule> {
    if (findDuplicateIpRule(input)) {
      throw new Error(`IP 规则已存在：${input.source.trim()}`)
    }
    return addFirewallIpRule(input, new Date().toISOString())
  }

  async updateIpRule(ruleId: string, input: FirewallIpRuleInput): Promise<FirewallIpRule> {
    if (findDuplicateIpRule(input, ruleId)) {
      throw new Error(`IP 规则已存在：${input.source.trim()}`)
    }
    return updateFirewallIpRule(ruleId, input, new Date().toISOString())
  }

  async removeIpRule(ruleId: string): Promise<void> {
    removeFirewallIpRule(ruleId)
  }

  async listForwards(): Promise<readonly FirewallForwardRule[]> {
    return getFirewallForwards()
  }

  async createForward(input: FirewallForwardInput): Promise<FirewallForwardRule> {
    if (findDuplicateForward(input)) {
      throw new Error(`端口转发已存在：${input.protocol} ${input.port}`)
    }
    return addFirewallForward(input, new Date().toISOString())
  }

  async updateForward(ruleId: string, input: FirewallForwardInput): Promise<FirewallForwardRule> {
    if (findDuplicateForward(input, ruleId)) {
      throw new Error(`端口转发已存在：${input.protocol} ${input.port}`)
    }
    return updateFirewallForward(ruleId, input, new Date().toISOString())
  }

  async removeForward(ruleId: string): Promise<void> {
    removeFirewallForward(ruleId)
  }

  async scanProtection(): Promise<FirewallScanProtection> {
    return getScanProtection()
  }

  async setScanProtection(enabled: boolean): Promise<FirewallScanProtection> {
    return setScanProtection(enabled)
  }

  async setScanConfig(config: FirewallScanConfig): Promise<FirewallScanProtection> {
    return setScanConfigFirewall(config)
  }

  async unblockIp(ip: string): Promise<FirewallScanProtection> {
    return unblockScanIp(ip)
  }

  async syncFromSystem(): Promise<{ total: number }> {
    // 模拟读取操作系统防火墙的耗时；演示里规则集与「系统」天然一致，只回读总数。
    await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS))
    return {
      total: getFirewallRules().length + getFirewallIpRules().length + getFirewallForwards().length,
    }
  }
}

export class MockSshAdapter implements SshAdapter {
  async overview(): Promise<SshOverview> {
    return getSshOverview()
  }

  async settings(): Promise<SshAuthSettings> {
    return getSshAuthSettings()
  }

  async rootAuth(): Promise<SshRootAuth> {
    return getSshRootAuth()
  }

  async setServiceEnabled(enabled: boolean): Promise<SshOverview> {
    return setSshServiceEnabled(enabled, new Date().toISOString())
  }

  async setAuthMethods(methods: SshAuthMethods): Promise<SshAuthSettings> {
    return saveSshAuthSettings({ ...getSshAuthSettings(), ...methods })
  }

  async setPort(port: number): Promise<SshAuthSettings> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    if (!isValidSshPort(port)) throw new Error('SSH 端口需为 1-65535 的整数')
    return saveSshAuthSettings({ ...getSshAuthSettings(), port })
  }

  async saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth> {
    return saveSshRootLoginPolicy(policy)
  }

  async resetRootPassword(password: string): Promise<SshPasswordResetResult> {
    return resetSshRootPassword(password, new Date().toISOString())
  }

  async createRootKey(): Promise<SshRootAuth> {
    // 私钥仅随本次响应携带（生成序号进派生种子，重新生成得到不同指纹）。
    return generateSshRootKey(new Date().toISOString())
  }

  async listKeys(): Promise<readonly SshLoginKey[]> {
    return getSshLoginKeys()
  }

  async keyAccounts(): Promise<readonly SshKeyAccount[]> {
    // mock 侧的归属清单就是账号数据集：id 回传给 createKey，与真实实现回传登录名同形。
    return getHostUsers().map((user) => ({ id: user.id, name: user.name }))
  }

  async listLoginRecords(): Promise<readonly SshLoginRecord[]> {
    return getSshLoginRecords()
  }

  async createKey(input: { name: string; userId: string }): Promise<SshLoginKey> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    const name = input.name.trim()
    if (!isValidSshKeyName(name)) throw new Error(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
    if (findSshLoginKeyByName(name)) throw new Error(`密钥名称已存在：${name}`)
    const owner = findHostUserById(input.userId)
    if (!owner) throw new Error(`归属账号不存在：${input.userId}`)
    return addSshLoginKey(name, owner.id, new Date().toISOString())
  }

  async removeKey(keyId: string): Promise<void> {
    removeSshLoginKey(keyId)
  }
}

export class MockUserAdapter implements UserAdapter {
  async list(): Promise<readonly HostUser[]> {
    return getHostUsers()
  }

  async create(input: { name: string } & HostUserInput): Promise<HostUser> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    if (!isValidHostUserName(input.name)) {
      throw new Error('用户名只能用小写字母、数字、下划线与连字符，且由字母或下划线开头')
    }
    if (findHostUserByName(input.name)) throw new Error(`用户名已存在：${input.name}`)
    // mock 不消费 password：真实实现的 chpasswd 路径在演示态不存在，字段在这里丢弃、不落数据集。
    const { name, password: _password, ...rest } = input
    return addHostUser(name, rest, new Date().toISOString())
  }

  async update(userId: string, input: HostUserInput): Promise<HostUser> {
    // 同上：password 只属于真实实现，mock 保持行为不变。
    const { password: _password, ...rest } = input
    return updateHostUser(userId, rest)
  }

  async remove(userId: string): Promise<void> {
    // 账号没了，授权它的密钥也就登不进去，一并从演示数据集里移除。
    removeSshLoginKeysByUser(userId)
    removeHostUser(userId)
  }

  async syncFromSystem(): Promise<{ total: number }> {
    // 模拟读取系统账号的耗时；演示里账号集与「系统」天然一致，只回读总数。
    await new Promise((resolve) => setTimeout(resolve, HOST_USER_SYNC_DELAY_MS))
    return { total: getHostUsers().length }
  }
}

/** 演示环境恒报通道正常：mock 呈现完整功能，不模拟降级与漂移。 */
const DEMO_PROXY_STATUS: WebsiteProxyStatus = { state: 'active', detail: null }

export class MockWebsitesAdapter implements WebsitesAdapter {
  async runtimeCatalog() {
    return structuredClone(MOCK_WEBSITE_RUNTIME_REPORT)
  }
  async list(): Promise<WebsiteListReport> {
    return { projects: getWebsiteProjects(), proxy: DEMO_PROXY_STATUS }
  }

  async create(kind: WebsiteProjectKind, input: WebsiteProjectCreateInput): Promise<WebsiteMutateResult> {
    return { project: addWebsiteProject(kind, input), firewallPort: null }
  }

  async update(projectId: string, input: WebsiteProjectUpdateInput): Promise<WebsiteProject> {
    return updateWebsiteProject(projectId, input)
  }

  async setAccess(projectId: string, access: WebsiteAccessInput): Promise<WebsiteMutateResult> {
    return { project: setWebsiteProjectAccess(projectId, access), firewallPort: null }
  }

  async remove(projectId: string): Promise<void> {
    removeWebsiteProject(projectId)
  }

  async setRunning(projectId: string, running: boolean): Promise<WebsiteProject> {
    return setWebsiteProjectRunning(projectId, running)
  }

  async logs(projectId: string): Promise<readonly string[]> {
    return getWebsiteLogs(projectId)
  }

  async reconcileProxy(): Promise<WebsiteProxyStatus> {
    // 演示环境没有真实的宿主 Caddy 通道，对账是 no-op，状态保持正常。
    return DEMO_PROXY_STATUS
  }
}

/** 演示模式恒报双就绪：宿主依赖引导只属于 Docker 运行时的真实场景，本地开发不弹窗。 */
const DEMO_DEPENDENCY_REPORT: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

/**
 * 依赖检测 mock 实现：恒双 ok、不可变（演示模式不引导，与 AGENTS.md 替换表摘要一致）。
 * 要复现 missing / error 等模拟态，测试在 gateway 字面量手写 dependencies 片注入
 * 可控 probe（DependencyGuideDialogs.test.tsx / WebsitesPage.test.tsx 的既有做法，
 * 与 sshPanel.ts 的委托替身同款接缝）；真实场景由 http 实现接 /api/platform/dependencies。
 */
export class MockDependenciesAdapter implements DependenciesAdapter {
  async probe(): Promise<DependencyProbeReport> {
    return DEMO_DEPENDENCY_REPORT
  }

  /** 演示模式不弹引导。测试若注入缺失报告，分步安装走这个无副作用的成功结果。 */
  async setup(): Promise<DependencySetupResult> {
    return { ok: true, message: '已完成' }
  }
}

/**
 * 内存事件源：事件流端点不可用时的降级实现，契约与 SSE 实现完全一致。
 * 它按固定节奏产出确定性的事件内容，使界面在没有服务端进程时也能演示增量刷新。
 */
export function createInMemoryEventsAdapter(
  dataset: () => MockDataset,
  options: { intervalMs?: number } = {},
): EventsAdapter {
  const intervalMs = options.intervalMs ?? 2000

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      handlers.onStatus('connecting')

      let counter = 0
      let cursor = 0
      let walk = {
        cpu: 55,
        memory: 68,
        networkRx: 220,
        networkTx: 160,
        networkIo: 380,
        diskRead: 130,
        diskWrite: 80,
        diskIo: 210,
        load: { ...INITIAL_LOAD },
        disks: INITIAL_DISKS.map((disk) => ({ ...disk })),
      }
      const stepWalk = (): typeof walk => {
        const networkRx = Math.min(550, Math.max(30, walk.networkRx + Math.round((Math.random() - 0.5) * 50)))
        const networkTx = Math.min(450, Math.max(20, walk.networkTx + Math.round((Math.random() - 0.5) * 40)))
        const diskRead = Math.min(320, Math.max(20, walk.diskRead + Math.round((Math.random() - 0.5) * 36)))
        const diskWrite = Math.min(280, Math.max(15, walk.diskWrite + Math.round((Math.random() - 0.5) * 30)))
        walk = {
          cpu: Math.min(90, Math.max(20, walk.cpu + Math.round((Math.random() - 0.5) * 4))),
          memory: Math.min(92, Math.max(45, walk.memory + Math.round((Math.random() - 0.5) * 2))),
          networkRx,
          networkTx,
          networkIo: networkRx + networkTx,
          diskRead,
          diskWrite,
          diskIo: diskRead + diskWrite,
          load: nextLoadWalk(walk.load),
          disks: nextDisksWalk(walk.disks),
        }
        return walk
      }

      const emitLater = () => {
        counter += 1
        const data = dataset()
        const events: ElysianEvent[] = []

        // 每拍一条资源采样；每 4 拍诞生一次新事故，让图表持续可见地动。
        events.push({
          id: `mem-${counter}-resource`,
          name: 'resource/sample',
          at: new Date().toISOString(),
          payload: stepWalk(),
        })
        if (counter % 4 === 0) {
          const roll = Math.random()
          const severity = roll < 0.1 ? 'sev1' : roll < 0.3 ? 'sev2' : roll < 0.7 ? 'sev3' : 'sev4'
          events.push({
            id: `mem-${counter}-new-incident`,
            name: 'incident/created',
            at: new Date().toISOString(),
            payload: { incidentId: `INC-LIVE-${counter}`, severity },
          })
        }

        const run = data.runs[cursor % Math.max(1, data.runs.length)]
        if (run) {
          events.push({
            id: `mem-${counter}-agent`,
            name: 'agent/status',
            at: new Date().toISOString(),
            payload: {
              moduleId: run.moduleId,
              // 与 mock 事件流端点保持同一套判定，避免同一个事件名在两处语义不同。
              status:
                run.status === 'running' || run.status === 'waiting-approval' ? 'running' : 'idle',
            },
          })
        }

        const approval = data.approvals[cursor % Math.max(1, data.approvals.length)]
        if (approval && approval.status === 'pending') {
          events.push({
            id: `mem-${counter}-approval`,
            name: 'approval/asked',
            at: new Date().toISOString(),
            payload: { approvalId: approval.id },
          })
        }

        const incident = data.incidents[cursor % Math.max(1, data.incidents.length)]
        if (incident) {
          events.push({
            id: `mem-${counter}-incident`,
            name: 'incident/updated',
            at: new Date().toISOString(),
            payload: { incidentId: incident.id, status: incident.status },
          })
        }

        cursor += 1
        for (const event of events) handlers.onEvent(event)
      }

      handlers.onStatus('live')
      const timer = setInterval(emitLater, intervalMs)

      return () => {
        clearInterval(timer)
      }
    },
  }
}

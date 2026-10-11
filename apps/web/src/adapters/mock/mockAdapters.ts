import { createMockWebsiteDeployments } from './websiteDeploymentsMock'
import type { FileDownload, FileUploadCheck, FileUploadOptions } from '../../contracts/adapters'
import { MOCK_WEBSITE_RUNTIME_REPORT } from './websiteRuntimeCatalog'
import {
  effectivePortHostIp,
  hostPortBindingsOverlap,
} from '../../features/container/containerCreateForm'
import {
  checkComposeReferences,
  isContainerBuildActive,
  normalizeWorkspaceRelativePath,
  validateContainerAppDisplayName,
  validateContainerAppSlug,
} from '@elysian/contracts'
import type {
  Container,
  ContainerAction,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildLogs,
  ContainerBuildPlan,
  ContainerBuildPreviewInput,
  ContainerBuildServicePlan,
  ContainerBuildSubmitInput,
  ContainerBuildTask,
  ContainerCreateInput,
  ComposeCheckResult,
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
  LoginLogEntry,
  LoginLogListReport,
  LogClearReport,
  LogStorageStats,
  OperationLogEntry,
  OperationLogListReport,
  PlatformLogCategory,
  RuntimeLogEntry,
  RuntimeLogListReport,
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
  SSH_KEY_NAME_MAX_LENGTH,
  formatLogBytes,
  isValidHostUserName,
  isValidSshKeyName,
  isValidSshPort,
  pageByQuery,
} from '@elysian/contracts'
import type {
  LoginLogListQuery,
  LogListQuery,
  OperationLogListQuery,
} from '@elysian/contracts'
import type {
  ContainerAdapter,
  DependenciesAdapter,
  HostTerminalHandlers,
  HostTerminalSessionInfo,
  EventsAdapter,
  FilesAdapter,
  FilePermissionInput,
  FirewallAdapter,
  LogsAdapter,
  SessionAdapter,
  SessionListRow,
  PanelPasswordChangeInput,
  SessionStatus,
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
  checkMockFileUpload,
  compressMockEntry,
  copyMockEntry,
  listMockDirectory,
  measureMockDirectory,
  moveMockEntry,
  renameMockEntry,
  searchMockFiles,
  uploadMockFile,
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
import { INITIAL_LOAD, nextLoadWalk } from './resourceMetrics'
import type { MockDataset } from './dataset'

/*
 * 各个领域的 mock 适配实现。它们共用同一份内存数据集，
 * 因此审批、审计、事件流之间引用的标识是一致的。
 */


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

  // 演示模式刻意忽略回跳参数（_returnTo 只声明不使用）且不回答 returnTo：本地无后端时不存在「把浏览器送回外部 origin」这件事。
  async status(_returnTo?: string): Promise<SessionStatus> {
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
  async prepareDownload(_path: string, signal?: AbortSignal): Promise<FileDownload> {
    signal?.throwIfAborted()
    throw new Error('演示模式没有真实文件内容，请在连接后端的文件页面下载')
  }

  startDownload(_download: FileDownload, onError?: (error: Error) => void): void {
    onError?.(new Error('演示模式没有真实文件内容'))
  }

  async checkUpload(dirPath: string, name: string, sizeBytes: number, signal?: AbortSignal): Promise<FileUploadCheck> {
    signal?.throwIfAborted()
    return checkMockFileUpload(dirPath, name, sizeBytes)
  }

  async uploadFile(dirPath: string, file: File, check: FileUploadCheck, overwrite: boolean, options?: FileUploadOptions): Promise<FileEntry> {
    options?.signal?.throwIfAborted()
    const saved = uploadMockFile(dirPath, file, check, overwrite)
    options?.onProgress?.(100)
    return saved
  }

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

/** 存储统计：两类条目的字节、行数与最旧时间为两类合计。 */
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
    runtimeRowCount: runtime.length,
    operationRowCount: operation.length,
    rowCount: runtime.length + operation.length,
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
    message: `${PLATFORM_LOG_CATEGORY_LABELS[category]}已清空：删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}`,
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
    summary: `删除 ${report.rowCount} 条记录，释放 ${formatLogBytes(report.totalBytes)}`,
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
  async runtimeLog(query?: LogListQuery): Promise<RuntimeLogListReport> {
    const runtime = runtimeLogEntries()
    const operation = operationLogEntries()
    const page = pageByQuery(runtime, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      return entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)
    })
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(runtime, operation),
    }
  }

  async loginLogs(query?: LoginLogListQuery): Promise<LoginLogListReport> {
    const rows = getLoginLogs().map((entry) => ({ ...entry, at: entry.time }))
    const page = pageByQuery(rows, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      if (query?.status && entry.status !== query.status) return false
      return (
        entry.ip.toLowerCase().includes(needle)
        || entry.location.toLowerCase().includes(needle)
        || entry.userAgent.toLowerCase().includes(needle)
      )
    })
    const entries: LoginLogEntry[] = page.entries.map(({ at: _at, ...entry }) => entry)
    return {
      entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
    }
  }

  async operationLogs(query?: OperationLogListQuery): Promise<OperationLogListReport> {
    const runtime = runtimeLogEntries()
    const operation = operationLogEntries()
    const page = pageByQuery(operation, query ?? {}, (entry, keyword) => {
      const needle = keyword.toLowerCase()
      if (query?.category && entry.category !== query.category) return false
      if (query?.result && entry.result !== query.result) return false
      return (
        entry.action.toLowerCase().includes(needle)
        || entry.summary.toLowerCase().includes(needle)
        || (entry.target?.toLowerCase().includes(needle) ?? false)
      )
    })
    return {
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      skippedLines: 0,
      skippedFiles: 0,
      storage: logStorage(runtime, operation),
    }
  }

  async clearLogs(category: PlatformLogCategory): Promise<LogClearReport> {
    const cleared = category === 'runtime' ? runtimeLogEntries() : operationLogEntries()
    const clearedAt = new Date().toISOString()
    // 报告回的是**已删除的事实**：条目前的字节、分片数与最旧时间。
    const report: LogClearReport = {
      category,
      rowCount: cleared.length,
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


type MockContainerTerminalSession = {
  containerId: string
  handlers: HostTerminalHandlers
}

/** 构建上下文上限：与工作区文件上限同值（files.go 三件套），preview 预警用。 */
const DEMO_BUILD_CONTEXT_MAX_FILES = 512
const DEMO_BUILD_CONTEXT_MAX_BYTES = 128 * 1024 * 1024

/** requestId 形状：与服务端 safeDeploymentID 同一正则（小写 uuid 形态）。 */
const DEMO_BUILD_REQUEST_ID_PATTERN = /^[a-f0-9-]{36}$/

/** dockerfile 形态的预览结果：收窄用，避免在联合类型上直接取字段。 */
type DockerfileBuildPlan = Extract<ContainerBuildPlan, { mode: 'dockerfile' }>

/** tag = UTC yyyyMMdd-HHmmss（任务提交时刻）+ 任务 id 前 4 字符，与真实侧同规则。 */
function demoBuildTag(createdAtIso: string, taskId: string): string {
  const at = new Date(createdAtIso)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}` +
    `-${taskId.slice(0, 4)}`
  )
}

/** 演示镜像 ID：同一 repository:tag 确定性生成，不伪装真实构建产物。 */
function demoBuildImageId(repository: string, tag: string): string {
  let hash = 0
  for (const char of `${repository}:${tag}`) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return `sha256:${hex(hash)}${hex(hash ^ 0x9e3779b9)}${hex(hash * 31)}${hex(hash ^ 0x85ebca6b)}`
}

export class MockContainerAdapter implements ContainerAdapter {
  private nextTerminalId = 1
  private readonly terminalSessions = new Map<string, MockContainerTerminalSession>()
  /**
   * 演示用工作区：只存内存，刷新即回空（AGENTS.md「演示状态只存在内存」）。
   * 目录形状与真实侧一致（<mountRoot>/apps/<slug>），好让回显路径的样式在演示下也成立。
   */
  private readonly demoApps = new Map<string, { displayName: string; createdAt: string; files: Map<string, string> }>()
  /**
   * 演示构建任务（ADR-0021 同款任务模型）：submit 生成任务并按注入时钟推进
   * queued → building → succeeded；requestId 幂等、取消与日志分页与 HTTP 侧同句。
   * 构建为内存模拟，不执行真实 Docker 构建，日志行里也如实标注。
   */
  private nextBuildSeq = 1
  private readonly demoBuilds = new Map<string, ContainerBuildTask>()
  private readonly demoBuildLogs = new Map<string, string[]>()
  /** 任务推进所需的元数据（目标清单与上下文统计），不进任务对象。 */
  private readonly demoBuildMeta = new Map<string, { targets: readonly { target: string; repository: string }[]; contextFiles: number; contextBytes: number }>()
  private readonly demoBuildTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

  constructor(
    private readonly dataset: () => MockDataset,
    private readonly hooks: {
      onAction: (containerId: string) => void
      scheduleRestart: (containerId: string) => void
      onCreate: (containerId: string) => void
    },
    private readonly options: {
      /** 注入时钟：tag 与任务时间戳都取它，测试不依赖当前时间。 */
      now?: () => Date
      /** 状态推进节奏：默认对齐真实观感（0.5s 排队、3s 构建），测试可注入 0。 */
      buildDelays?: { queuedMs: number; buildingMs: number }
    } = {},
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

  /** 演示工作区的绝对目录形状，与真实侧 <mountRoot>/apps/<slug> 一致。 */
  private demoAppDir(slug: string): string {
    return `/srv/elysian/apps/${slug}`
  }

  private requireDemoApp(slug: string) {
    const app = this.demoApps.get(slug)
    if (!app) throw new Error(`容器工作区不存在：${slug}`)
    return app
  }

  private demoFileEntries(files: Map<string, string>): readonly ContainerAppFile[] {
    return [...files.entries()]
      .map(([path, content]) => ({
        path,
        size: new TextEncoder().encode(content).length,
        modifiedAt: new Date().toISOString(),
        text: !content.includes('\u0000'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  async listApps(): Promise<readonly ContainerApp[]> {
    return [...this.demoApps.entries()]
      .map(([slug, app]) => ({
        slug,
        displayName: app.displayName,
        createdAt: app.createdAt,
        directory: this.demoAppDir(slug),
        files: this.demoFileEntries(app.files),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  }

  async createApp(input: { slug: string; displayName: string }): Promise<ContainerApp> {
    const slugError = validateContainerAppSlug(input.slug)
    if (slugError) throw new Error(slugError)
    const nameError = validateContainerAppDisplayName(input.displayName)
    if (nameError) throw new Error(nameError)
    if (this.demoApps.has(input.slug)) throw new Error(`工作区名称已存在，请换一个：${input.slug}`)
    const createdAt = new Date().toISOString()
    this.demoApps.set(input.slug, {
      displayName: input.displayName || input.slug,
      createdAt,
      files: new Map(),
    })
    return {
      slug: input.slug,
      displayName: input.displayName || input.slug,
      createdAt,
      directory: this.demoAppDir(input.slug),
      files: [],
    }
  }

  async removeApp(slug: string): Promise<void> {
    this.requireDemoApp(slug)
    // 与真实端点同款收紧：活跃构建任务期间删除被拒，409 文案逐字一致。
    if ([...this.demoBuilds.values()].some((task) => task.slug === slug && isContainerBuildActive(task.state))) {
      throw new Error('工作区有进行中的构建任务，请先取消或等待完成')
    }
    this.demoApps.delete(slug)
    for (const [id, task] of this.demoBuilds) {
      if (task.slug !== slug) continue
      this.clearBuildTimers(id)
      this.demoBuilds.delete(id)
      this.demoBuildLogs.delete(id)
      this.demoBuildMeta.delete(id)
    }
  }

  async uploadAppFile(slug: string, path: string, file: Blob): Promise<ContainerAppFile> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = await file.text()
    app.files.set(normalized, content)
    return this.demoFileEntries(new Map([[normalized, content]]))[0]!
  }

  async removeAppFile(slug: string, path: string): Promise<void> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!app.files.delete(normalized)) throw new Error(`工作区内没有该文件：${normalized}`)
  }

  async readAppContent(slug: string, path: string): Promise<{ path: string; content: string; file: ContainerAppFile }> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = app.files.get(normalized)
    if (content === undefined) throw new Error(`工作区内没有该文件：${normalized}`)
    return {
      path: normalized,
      content,
      file: this.demoFileEntries(new Map([[normalized, content]]))[0]!,
    }
  }

  async writeAppContent(slug: string, path: string, content: string): Promise<ContainerAppFile> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    if (content.includes('\u0000')) throw new Error('编辑内容必须是 UTF-8 文本且不含空字符')
    app.files.set(normalized, content)
    return this.demoFileEntries(new Map([[normalized, content]]))[0]!
  }

  /**
   * 演示侧的 compose 自检：与 Go 侧同一套保守规则（只判 ./ 开头的相对引用与
   * env_file，绝对路径/变量/锚点/build 一律列入未能判定）。两侧规则一致才不会
   * 出现「演示看着对、真实环境给出另一套结论」。
   */
  async checkCompose(slug: string, path: string): Promise<ComposeCheckResult> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = app.files.get(normalized)
    if (content === undefined) throw new Error(`工作区内没有该文件：${normalized}`)
    return checkComposeReferences({
      composePath: normalized,
      composeDir: `${this.demoAppDir(slug)}/${normalized.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''),
      content,
      hasFile: (relative) => {
        // 演示侧只有文件没有目录：引用指向目录时按「该前缀下有文件」判定存在。
        if (app.files.has(relative)) return true
        const prefix = relative.endsWith('/') ? relative : `${relative}/`
        return [...app.files.keys()].some((candidate) => candidate.startsWith(prefix))
      },
    })
  }

  /* ---------- 镜像构建（ADR-0021）：演示侧与 HTTP 侧同一套错误句与任务形状 ---------- */

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  private requireDemoBuild(slug: string, taskId: string): ContainerBuildTask {
    const task = this.demoBuilds.get(taskId)
    if (!task || task.slug !== slug) throw new Error(`构建任务不存在：${taskId}`)
    return task
  }

  private mutateBuild(taskId: string, mutate: (task: ContainerBuildTask) => void): void {
    const task = this.demoBuilds.get(taskId)
    if (!task) return
    mutate(task)
    task.updatedAt = this.nowIso()
  }

  private appendBuildLog(taskId: string, line: string): void {
    const lines = this.demoBuildLogs.get(taskId) ?? []
    lines.push(line)
    this.demoBuildLogs.set(taskId, lines)
  }

  private clearBuildTimers(taskId: string): void {
    for (const timer of this.demoBuildTimers.get(taskId) ?? []) clearTimeout(timer)
    this.demoBuildTimers.delete(taskId)
  }

  /** 构建上下文归一化：允许字面 "." 与 "./" 前缀，剥完逐段按工作区相对路径同规则校验。 */
  private normalizeBuildContext(context: string): string {
    let value = context.trim()
    if (value.startsWith('./')) value = value.slice(2)
    if (value === '') value = '.'
    if (value === '.') return '.'
    return normalizeWorkspaceRelativePath(value)
  }

  /** 上下文目录存在性：演示侧只有文件，前缀下有文件即算目录存在。 */
  private demoContextStats(
    app: { files: Map<string, string> },
    context: string,
  ): { contextFiles: number; contextBytes: number; exists: boolean } {
    const prefix = context === '.' ? '' : `${context}/`
    let contextFiles = 0
    let contextBytes = 0
    for (const [path, content] of app.files) {
      if (!path.startsWith(prefix)) continue
      contextFiles += 1
      contextBytes += new TextEncoder().encode(content).length
    }
    return { contextFiles, contextBytes, exists: context === '.' || contextFiles > 0 }
  }

  /** FROM 静态预检（演示侧）：只报未解析变量的行，不代入 ARG 默认值，也不做镜像源 DNS 校验。 */
  private scanDemoDockerfileFrom(content: string): string[] {
    const warnings: string[] = []
    content.split('\n').forEach((rawLine, index) => {
      const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(rawLine)
      if (match && match[1]!.includes('$')) {
        warnings.push(`第 ${index + 1} 行 FROM 含未解析变量，面板未校验其镜像源`)
      }
    })
    return warnings
  }

  /** compose 模式的固定示例服务：演示侧不解析 YAML，warnings 里如实标注。 */
  private demoComposeServicePlans(slug: string): readonly ContainerBuildServicePlan[] {
    const app = this.requireDemoApp(slug)
    const stats = this.demoContextStats(app, 'web')
    return [
      {
        service: 'web',
        hasBuild: true,
        target: 'web',
        dockerfile: 'web/Dockerfile',
        context: 'web',
        imageRepository: `elysian/${slug}/web`,
        contextFiles: stats.contextFiles,
        contextBytes: stats.contextBytes,
        imageNameInCompose: 'myapp-web',
        repositoryOccupied: false,
        warnings: [],
      },
      {
        service: 'db',
        hasBuild: false,
        target: '',
        dockerfile: '',
        context: '',
        imageRepository: '',
        contextFiles: 0,
        contextBytes: 0,
        imageNameInCompose: 'mariadb:11',
        repositoryOccupied: false,
        warnings: [],
      },
    ]
  }

  private demoBuildPreviewDockerfile(
    slug: string,
    input: Extract<ContainerBuildPreviewInput, { mode: 'dockerfile' }>,
  ): DockerfileBuildPlan {
    const app = this.requireDemoApp(slug)
    const target = input.target?.trim() || 'app'
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(target)) {
      throw new Error('镜像目标名只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头')
    }
    const dockerfile = normalizeWorkspaceRelativePath(input.dockerfile)
    const content = app.files.get(dockerfile)
    if (content === undefined) throw new Error(`工作区内没有该文件：${dockerfile}`)
    const context = this.normalizeBuildContext(input.context ?? '.')
    const stats = this.demoContextStats(app, context)
    if (!stats.exists) throw new Error(`构建上下文目录不存在：${context}`)
    if (dockerfile !== context && !dockerfile.startsWith(context === '.' ? '' : `${context}/`)) {
      throw new Error('Dockerfile 必须位于构建上下文目录内')
    }
    const warnings = this.scanDemoDockerfileFrom(content)
    if (stats.contextFiles > DEMO_BUILD_CONTEXT_MAX_FILES || stats.contextBytes > DEMO_BUILD_CONTEXT_MAX_BYTES) {
      warnings.push('构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败')
    }
    return {
      mode: 'dockerfile',
      slug,
      target,
      dockerfile,
      context,
      imageRepository: `elysian/${slug}/${target}`,
      contextFiles: stats.contextFiles,
      contextBytes: stats.contextBytes,
      repositoryOccupied: false,
      warnings,
    }
  }

  async previewAppBuild(slug: string, input: ContainerBuildPreviewInput): Promise<ContainerBuildPlan> {
    if (input.mode === 'dockerfile') return this.demoBuildPreviewDockerfile(slug, input)
    const app = this.requireDemoApp(slug)
    const compose = normalizeWorkspaceRelativePath(input.compose)
    if (!app.files.has(compose)) throw new Error(`工作区内没有该文件：${compose}`)
    return {
      mode: 'compose',
      slug,
      compose,
      services: this.demoComposeServicePlans(slug),
      warnings: ['演示模式返回固定示例,不解析 compose 文件内容'],
    }
  }

  async submitAppBuild(slug: string, input: ContainerBuildSubmitInput): Promise<ContainerBuildTask> {
    this.requireDemoApp(slug)
    if (!DEMO_BUILD_REQUEST_ID_PATTERN.test(input.requestId)) throw new Error('请求标识无效')
    const existing = [...this.demoBuilds.values()].find((task) => task.requestId === input.requestId)
    if (existing) {
      if (JSON.stringify(existing.input) === JSON.stringify(input)) return structuredClone(existing)
      throw new Error('请求标识已用于其他构建')
    }
    let targets: readonly { target: string; repository: string }[]
    let stats: { contextFiles: number; contextBytes: number }
    if (input.mode === 'dockerfile') {
      const plan = this.demoBuildPreviewDockerfile(slug, input)
      targets = [{ target: plan.target, repository: plan.imageRepository }]
      stats = { contextFiles: plan.contextFiles, contextBytes: plan.contextBytes }
    } else {
      const app = this.requireDemoApp(slug)
      const compose = normalizeWorkspaceRelativePath(input.compose)
      if (!app.files.has(compose)) throw new Error(`工作区内没有该文件：${compose}`)
      const services = this.demoComposeServicePlans(slug)
      // 校验次序与真实端点一致：数组内重复名 → 不存在 → 无 build 段。
      const names = input.services ?? services.filter((service) => service.hasBuild).map((service) => service.service)
      const seen = new Set<string>()
      for (const name of names) {
        if (seen.has(name)) throw new Error(`服务 ${name} 重复提交`)
        seen.add(name)
      }
      for (const name of names) {
        const plan = services.find((service) => service.service === name)
        if (!plan) throw new Error(`服务不存在：${name}`)
        if (!plan.hasBuild) throw new Error(`服务没有 build 配置：${name}`)
      }
      targets = names.map((name) => ({ target: name, repository: `elysian/${slug}/${name}` }))
      const web = services.find((service) => service.service === 'web')!
      stats = { contextFiles: web.contextFiles, contextBytes: web.contextBytes }
    }
    if ([...this.demoBuilds.values()].some((task) => task.slug === slug && isContainerBuildActive(task.state))) {
      throw new Error('工作区已有进行中的构建任务')
    }
    const seq = this.nextBuildSeq
    this.nextBuildSeq += 1
    // id 前 4 字符必须是 hex：tag 后缀由它派生（形状 ^\d{8}-\d{6}-[0-9a-f]{4}$）。
    const id = `${(0x1000 + seq).toString(16)}b1d5-build-${seq}`
    const createdAt = this.nowIso()
    const task: ContainerBuildTask = {
      id,
      slug,
      mode: input.mode,
      requestId: input.requestId,
      state: 'queued',
      stage: '等待构建资源',
      createdAt,
      updatedAt: createdAt,
      input: structuredClone(input),
      results: [],
      error: '',
    }
    this.demoBuilds.set(id, task)
    this.demoBuildMeta.set(id, { targets, contextFiles: stats.contextFiles, contextBytes: stats.contextBytes })
    this.appendBuildLog(id, '任务已提交，等待构建资源')
    this.driveBuild(id)
    return structuredClone(task)
  }

  /** 状态推进：queued（0.5s）→ building（打包/校验）→ 逐目标构建（3s）→ succeeded。 */
  private driveBuild(taskId: string): void {
    const delays = this.options.buildDelays ?? { queuedMs: 500, buildingMs: 3000 }
    const timers: ReturnType<typeof setTimeout>[] = []
    this.demoBuildTimers.set(taskId, timers)
    const alive = () => {
      const task = this.demoBuilds.get(taskId)
      return task !== undefined && isContainerBuildActive(task.state)
    }
    timers.push(setTimeout(() => {
      if (!alive()) return
      const meta = this.demoBuildMeta.get(taskId)!
      this.mutateBuild(taskId, (task) => {
        task.state = 'building'
        task.stage = `打包构建上下文（${meta.contextFiles} 个文件，${meta.contextBytes} 字节）`
      })
      this.appendBuildLog(taskId, `打包构建上下文（${meta.contextFiles} 个文件，${meta.contextBytes} 字节）`)
      this.appendBuildLog(taskId, '演示模式：构建为内存模拟,未执行真实 Docker 构建')
      timers.push(setTimeout(() => {
        if (!alive()) return
        this.appendBuildLog(taskId, '校验镜像来源')
        for (const target of meta.targets) {
          if (!alive()) return
          const task = this.demoBuilds.get(taskId)!
          const tag = demoBuildTag(task.createdAt, taskId)
          this.mutateBuild(taskId, (row) => { row.stage = `构建镜像 ${target.repository}` })
          this.appendBuildLog(taskId, `构建镜像 ${target.repository}:${tag}`)
          this.mutateBuild(taskId, (row) => {
            row.results = [...row.results, {
              target: target.target,
              repository: target.repository,
              tag,
              imageId: demoBuildImageId(target.repository, tag),
              state: 'succeeded',
              error: '',
            }]
          })
        }
        if (!alive()) return
        this.appendBuildLog(taskId, '清理旧镜像')
        this.mutateBuild(taskId, (task) => {
          task.state = 'succeeded'
          task.stage = '构建成功'
        })
        this.appendBuildLog(taskId, '构建成功')
      }, delays.buildingMs))
    }, delays.queuedMs))
  }

  async listAppBuilds(slug: string): Promise<readonly ContainerBuildTask[]> {
    this.requireDemoApp(slug)
    return [...this.demoBuilds.values()]
      .filter((task) => task.slug === slug)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => structuredClone(task))
  }

  async getAppBuild(slug: string, taskId: string): Promise<ContainerBuildTask> {
    return structuredClone(this.requireDemoBuild(slug, taskId))
  }

  async getAppBuildLogs(slug: string, taskId: string, offset: number): Promise<ContainerBuildLogs> {
    this.requireDemoBuild(slug, taskId)
    if (!Number.isInteger(offset) || offset < 0) throw new Error('日志偏移无效')
    const lines = this.demoBuildLogs.get(taskId) ?? []
    // 分页与真实端点同口径：字节偏移、行边界切割、单次最多 64 KiB。
    const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    const bytes = new TextEncoder().encode(text)
    const total = bytes.length
    if (offset >= total) return { lines: [], next: total, total }
    const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, total))
    let lastNewline = -1
    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) { lastNewline = index; break }
    }
    if (lastNewline < 0) {
      const body = new TextDecoder().decode(chunk)
      return { lines: body ? [body] : [], next: offset + chunk.length, total }
    }
    const body = new TextDecoder().decode(chunk.subarray(0, lastNewline))
    return { lines: body ? body.split('\n') : [], next: offset + lastNewline + 1, total }
  }

  async cancelAppBuild(slug: string, taskId: string): Promise<void> {
    const task = this.requireDemoBuild(slug, taskId)
    if (!isContainerBuildActive(task.state)) throw new Error('构建已结束，无法取消')
    this.clearBuildTimers(taskId)
    this.mutateBuild(taskId, (row) => {
      row.state = 'cancelled'
      row.stage = '已取消'
      row.error = '构建已取消'
    })
    this.appendBuildLog(taskId, '构建已取消')
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
  deployment = createMockWebsiteDeployments()
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

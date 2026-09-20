import type {
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  Container,
  ContainerAction,
  ContainerCreateInput,
  ContainerImage,
  DatabaseInstance,
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
  LoginLogEntry,
  ModuleStatus,
  RuntimeLogSnapshot,
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
  WebsiteProject,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProjectUpdateInput,
} from '@elysian/contracts'
import { SEVERITY_RANK, SSH_KEY_NAME_MAX_LENGTH, isValidHostUserName, isValidSshKeyName, isValidSshPort } from '@elysian/contracts'
import type {
  ApprovalAdapter,
  AuditAdapter,
  ContainerAdapter,
  DatabaseAdapter,
  DatabaseCreateInput,
  EventsAdapter,
  FilesAdapter,
  FilePermissionInput,
  FirewallAdapter,
  IncidentAdapter,
  IncidentListQuery,
  IncidentListResult,
  LogsAdapter,
  MockQueryResult,
  RunAdapter,
  SessionAdapter,
  SkillAdapter,
  SshAdapter,
  SshKeyAccount,
  UserAdapter,
  WebsitesAdapter,
} from '../../contracts/adapters'
import { DATABASE_INSTANCES, SQLITE_VERSION, addDatabaseInstance, removeDatabaseInstance } from './databaseData'
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
import { registerSqliteCatalog } from './databaseCatalog'
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
import { runMockQuery } from './databaseQuery'
import { execContainerCommand } from './containerTerminal'
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
import { getLoginLogs, getRuntimeLog } from './logsData'
import {
  addWebsiteProject,
  getWebsiteLogs,
  getWebsiteProjects,
  removeWebsiteProject,
  setWebsiteProjectRunning,
  updateWebsiteProject,
} from './websitesData'
import { CONTAINERS, CONTAINER_IMAGES, mockImageArtifact } from './containersData'
import { autoContainerName } from './containersData'
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
export class MockSessionAdapter implements SessionAdapter {
  async canView(): Promise<boolean> {
    return true
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

/** 日志的 mock 实现：读手工种子的登录记录与固定模板生成的运行日志；只读，无变更动作。 */
export class MockLogsAdapter implements LogsAdapter {
  async runtimeLog(): Promise<RuntimeLogSnapshot> {
    return getRuntimeLog()
  }

  async loginLogs(): Promise<readonly LoginLogEntry[]> {
    return getLoginLogs()
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

export class MockContainerAdapter implements ContainerAdapter {
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

  async execMockCommand(
    containerId: string,
    command: string,
  ): Promise<{ lines: readonly string[]; clear?: boolean }> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const image = this.dataset().images.find((i) => i.id === container.imageId)
    if (!image) throw new Error('容器所用镜像不存在，无法执行演示终端命令')
    return execContainerCommand(container, image, command)
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

  async pullImage(input: { name: string; tag: string; registry?: string }): Promise<ContainerImage> {
    // registry 只是界面记录的拉取源：mock 不区分来源，全部走同一份确定性数据。
    const dataset = this.dataset()
    if (dataset.images.some((i) => i.name === input.name && i.tag === input.tag)) {
      throw new Error(`镜像已存在：${input.name}:${input.tag}`)
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

export class MockDatabaseAdapter implements DatabaseAdapter {
  async list(): Promise<readonly DatabaseInstance[]> {
    // 只有存在的分组才拷贝：文件型实例没有凭证、使用量与连接数。
    return DATABASE_INSTANCES.map((database) => ({
      ...database,
      ...(database.credentials ? { credentials: { ...database.credentials } } : {}),
      ...(database.storage ? { storage: { ...database.storage } } : {}),
      ...(database.memory ? { memory: { ...database.memory } } : {}),
      ...(database.connections ? { connections: { ...database.connections } } : {}),
    }))
  }

  async execMockQuery(databaseId: string, statement: string): Promise<MockQueryResult> {
    const database = DATABASE_INSTANCES.find((item) => item.id === databaseId)
    if (!database) throw new Error(`未找到数据库实例 ${databaseId}`)
    return runMockQuery(database, statement)
  }

  async create(input: DatabaseCreateInput): Promise<DatabaseInstance> {
    if (
      DATABASE_INSTANCES.some((item) => item.engine === input.engine && item.name === input.name)
    ) {
      throw new Error(`数据库 ${input.name} 已存在`)
    }

    if (input.kind === 'file') {
      // 文件型（SQLite）：实例即一个本地 .db 文件。新建的空库没有表；
      // 上传的既有文件在演示里读不到内容，也按空库登记（不编造它的表结构）。
      const instance: DatabaseInstance = {
        id: `db-sqlite-${input.name}`,
        engine: input.engine,
        name: input.name,
        version: SQLITE_VERSION,
        status: 'running',
        filePath: input.filePath,
        fileSizeMb: input.fileSizeMb,
        tableCount: 0,
        lastWrittenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      addDatabaseInstance(instance)
      registerSqliteCatalog(instance.id)
      return { ...instance }
    }

    const container = CONTAINERS.find((item) => item.id === input.containerId)
    if (!container) throw new Error(`未找到容器 ${input.containerId}`)
    const image = CONTAINER_IMAGES.find((item) => item.id === container.imageId)
    const instance: DatabaseInstance = {
      id: `db-${container.name}-${input.name}`,
      engine: input.engine,
      name: input.name,
      // 版本取承载容器镜像的标签：mariadb:10.11 上的库就是 10.11。
      version: image?.tag ?? '0',
      status: 'running',
      containerId: container.id,
      credentials: { username: input.username, password: input.password },
      storage: { usedGb: 0.1, totalGb: 32 },
      memory: { usedGb: 0.2, totalGb: 4 },
      connections: { active: 1, max: 200 },
      updatedAt: new Date().toISOString(),
    }
    addDatabaseInstance(instance)
    return { ...instance }
  }

  async remove(databaseId: string): Promise<void> {
    const database = DATABASE_INSTANCES.find((item) => item.id === databaseId)
    if (!database) throw new Error(`未找到数据库实例 ${databaseId}`)
    removeDatabaseInstance(databaseId)
  }
}

export class MockWebsitesAdapter implements WebsitesAdapter {
  async list(): Promise<readonly WebsiteProject[]> {
    return getWebsiteProjects()
  }

  async create(kind: WebsiteProjectKind, input: WebsiteProjectCreateInput): Promise<WebsiteProject> {
    return addWebsiteProject(kind, input)
  }

  async update(projectId: string, input: WebsiteProjectUpdateInput): Promise<WebsiteProject> {
    return updateWebsiteProject(projectId, input)
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

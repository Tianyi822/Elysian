import type {
  AgentRun,
  ApprovalOutcome,
  ApprovalRequest,
  AuditRecord,
  Container,
  ContainerAction,
  ContainerCreateInput,
  ContainerImage,
  DatabaseEngine,
  DatabaseInstance,
  EventStreamHandlers,
  FileEntry,
  FileSearchResult,
  FirewallImportResult,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanProtection,
  FirewallToggles,
  HostUser,
  HostUserInput,
  Incident,
  IncidentListRow,
  ModuleStatus,
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
} from '@elysian/contracts'

/*
 * Web 侧适配接口。界面只依赖这些接口，不关心数据来自 mock、内存降级还是真实网关。
 * 这是整个前端唯一的测试接缝：页面测试在这里注入替代实现。
 */

/** 事件中心的查询条件。空数组或缺省表示不筛选该维度。 */
export type IncidentListQuery = {
  severities?: readonly string[]
  statuses?: readonly string[]
  sources?: readonly string[]
  sort?: IncidentSort
}

export type IncidentSort = 'detected-desc' | 'detected-asc' | 'severity'

export type IncidentListResult = {
  rows: readonly IncidentListRow[]
  total: number
  /** 数据集里出现过的全部来源，供筛选器渲染候选项。 */
  availableSources: readonly string[]
}

export interface IncidentAdapter {
  listRows(query: IncidentListQuery): Promise<IncidentListResult>
  find(incidentId: string): Promise<Incident | undefined>
}

export interface SkillAdapter {
  list(): Promise<readonly Skill[]>
  setEnabled(skillId: string, enabled: boolean): Promise<Skill>
}

export interface ApprovalAdapter {
  list(): Promise<readonly ApprovalRequest[]>
  decide(
    requestId: string,
    decision: { outcome: ApprovalOutcome; note?: string },
  ): Promise<ApprovalRequest>
}

export interface AuditAdapter {
  list(): Promise<readonly AuditRecord[]>
}

export interface RunAdapter {
  list(): Promise<readonly AgentRun[]>
  find(runId: string): Promise<AgentRun | undefined>
  /** 各职责模块的忙闲状态。 */
  listModuleStatuses(): Promise<readonly ModuleStatus[]>
}

export interface EventsAdapter {
  subscribe(handlers: EventStreamHandlers): Unsubscribe
}

/** 演示终端的命令结果；clear 为 true 时界面清空输出区。 */
export type MockCommandResult = { lines: readonly string[]; clear?: boolean }

/**
 * 容器域适配接口。本期为 mock 实现：操作改写内存数据集，
 * 状态变化经 container/updated 事件推回；未来换真实运行时 adapter，页面不改。
 */
export interface ContainerAdapter {
  list(): Promise<readonly Container[]>
  listImages(): Promise<readonly ContainerImage[]>
  /** 演示终端：命令在本页 mock 内确定性求值，不执行真实 Shell。 */
  execMockCommand(containerId: string, command: string): Promise<MockCommandResult>
  /** 请求容器动作（启动/停止/重启，均为 mock）。 */
  requestAction(containerId: string, action: ContainerAction): Promise<Container>
  /** 创建容器（mock）：追加内存数据集并推 container/created。 */
  create(input: ContainerCreateInput): Promise<Container>
  /** 删除镜像（mock）：仅允许删除未被引用的镜像，改写内存数据集。 */
  removeImage(imageId: string): Promise<void>
  /** 拉取镜像（mock）：确定性生成摘要与体积后追加内存数据集，同名同标签视为已存在；registry 仅记录拉取源，不产生真实数据流。 */
  pullImage(input: { name: string; tag: string; registry?: string }): Promise<ContainerImage>
}

/** 演示会话的结果：结构化结果集、纯文本行，或清屏请求。 */
export type MockQueryResult =
  | { kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[]; notice: string }
  | { kind: 'text'; lines: readonly string[] }
  | { kind: 'clear' }

/**
 * 创建数据库的输入：表单收集后经 adapter 提交；是演示动作，不产生真实连接。
 * 分两支——服务型由容器承载、要账号与访问权限；文件型（SQLite）只是一个本地文件，
 * 没有容器也没有账号，只记路径、大小与来源。
 */
export type DatabaseCreateContainerInput = {
  kind: 'container'
  engine: DatabaseEngine
  name: string
  /** 字符集；仅 MariaDB/MySQL 有意义。 */
  charset?: string
  username: string
  password: string
  accessScope: 'localhost' | 'container-network' | 'any-host'
  containerId: string
}

export type DatabaseCreateFileInput = {
  kind: 'file'
  engine: DatabaseEngine
  /** 数据库名，取文件名去掉扩展名。 */
  name: string
  /** 文件绝对路径。 */
  filePath: string
  /** 文件大小（MB）。 */
  fileSizeMb: number
  /** `uploaded` 是上传/选择的既有文件，`created` 是本机新建的空库。 */
  origin: 'uploaded' | 'created'
}

export type DatabaseCreateInput = DatabaseCreateContainerInput | DatabaseCreateFileInput

/** 数据库区适配接口。本期为 mock 实现；未来换真实 adapter，页面不改。 */
export interface DatabaseAdapter {
  list(): Promise<readonly DatabaseInstance[]>
  /** 演示会话：语句在本页 mock 内确定性求值，不执行任何真实 SQL。 */
  execMockQuery(databaseId: string, statement: string): Promise<MockQueryResult>
  /** 创建数据库（演示）：追加内存数据集并返回新实例；同名同引擎视为已存在。 */
  create(input: DatabaseCreateInput): Promise<DatabaseInstance>
  /** 删除数据库（演示）：只改内存数据集，不触碰任何真实数据库。 */
  remove(databaseId: string): Promise<void>
}

/** 防火墙区适配接口。本期为 mock 实现；真实防火墙动作由未来执行层筛选，页面不改。 */
export interface FirewallAdapter {
  list(): Promise<readonly FirewallRule[]>
  toggles(): Promise<FirewallToggles>
  /** 切换防火墙总开关或禁 ping（演示）：只改内存状态，不触碰任何真实防火墙。 */
  setToggles(toggles: FirewallToggles): Promise<FirewallToggles>
  create(input: FirewallRuleInput): Promise<FirewallRule>
  update(ruleId: string, input: FirewallRuleInput): Promise<FirewallRule>
  remove(ruleId: string): Promise<void>
  /** 批量导入：去重后落进演示数据集，返回新增列表与跳过数量。 */
  importRules(inputs: readonly FirewallRuleInput[]): Promise<FirewallImportResult>
  /** 端口防扫描状态：开关、统计与当前封锁列表。 */
  scanProtection(): Promise<FirewallScanProtection>
  setScanProtection(enabled: boolean): Promise<FirewallScanProtection>
  unblockIp(ip: string): Promise<FirewallScanProtection>
  /** 从承载本面板的操作系统同步防火墙规则（演示）：返回同步后的规则总数。 */
  syncFromSystem(): Promise<{ total: number }>
}

/**
 * SSH 区适配接口。本期为 mock 实现：改动只落内存数据集；
 * 真实的 SSH 变更（启停服务、改端口与认证方式、换 Root 凭据）涉及系统级操作，
 * 由未来执行层筛选与执行，页面不改。
 */
export interface SshAdapter {
  /** 服务概况：开关、状态、上次启停时间与登录统计。 */
  overview(): Promise<SshOverview>
  settings(): Promise<SshAuthSettings>
  rootAuth(): Promise<SshRootAuth>
  /** 启停本机 SSH 服务（演示）：只改内存状态，不触碰任何真实主机。 */
  setServiceEnabled(enabled: boolean): Promise<SshOverview>
  /** 保存登录方式开关（演示）。 */
  setAuthMethods(methods: SshAuthMethods): Promise<SshAuthSettings>
  /** 保存监听端口（演示）：非法端口直接拒绝。 */
  setPort(port: number): Promise<SshAuthSettings>
  /** 保存 Root 登录策略（演示）。 */
  saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth>
  /** 重置 Root 密码（演示）：弱密码在 mock 侧即被拒绝，不产生任何真实变更。 */
  resetRootPassword(password: string): Promise<SshPasswordResetResult>
  /** 登录密钥列表（演示）：可自定义名称、多条并存的登录密钥，与主机 root 密钥分开管理。 */
  listKeys(): Promise<readonly SshLoginKey[]>
  /** 登录记录（演示）：按时间倒序的登录事实，含来源地址、客户端端口、账号与结果。 */
  listLoginRecords(): Promise<readonly SshLoginRecord[]>
  /** 创建登录密钥（演示）：名称去空白后校验，名称重复、归属账号不存在都拒绝。 */
  createKey(input: { name: string; userId: string }): Promise<SshLoginKey>
  /** 删除登录密钥（演示）：只改内存数据集，不触碰任何真实授权文件。 */
  removeKey(keyId: string): Promise<void>
}

/**
 * 主机账号适配接口。本期为 mock 实现：账号改动只落内存数据集；
 * 真实的账号增删改由未来执行层筛选与执行，页面不改。
 */
export interface UserAdapter {
  /** 主机账号列表（演示）：这台机器上的系统账号，按创建时间倒序。 */
  list(): Promise<readonly HostUser[]>
  /** 创建账号（演示）：用户名按 Linux 取名规则校验，重名即拒绝。 */
  create(input: { name: string } & HostUserInput): Promise<HostUser>
  /** 修改账号（演示）：只改认证方式、状态、管理员归属与备注，用户名不动。 */
  update(userId: string, input: HostUserInput): Promise<HostUser>
  /** 删除账号（演示）：只改内存数据集，不触碰任何真实系统账号。 */
  remove(userId: string): Promise<void>
  /** 从承载本页签的操作系统重新读取账号列表（演示）：返回同步后的账号总数。 */
  syncFromSystem(): Promise<{ total: number }>
}

/** 页面级访问区域。权限只做到这一粒度，本阶段不实现更细的权限模型。 */
export type PageArea =
  | 'dashboard'
  | 'security'
  | 'containers'  | 'databases'
  | 'files'
  | 'incidents'
  | 'runs'
  | 'skills'
  | 'approvals'
  | 'audit'
  | 'settings'

/**
 * 文件目录的读取接缝，形状对齐未来的目录列举服务。本期只有只读列举与目录大小统计；
 * 上传、删除等系统级变更等执行层接入后再扩展。
 */
export interface FilesAdapter {
  /**
   * 列出一个目录的直接子项（演示）。路径须为归一化后的绝对路径；
   * 不承诺任何顺序，排序由界面决定；目录不存在时抛出中文错误。
   */
  list(dirPath: string): Promise<readonly FileEntry[]>
  /**
   * 递归统计一个目录的总大小（字节，演示）。目录大小不在列举里给出——
   * 累计求和代价大，由界面按需触发；真实实现可能明显耗时，界面须有等待状态。
   */
  size(dirPath: string): Promise<number>
  /** 复制一个条目到目标目录（演示）。目标重名时自动加「 副本」后缀，返回新条目。 */
  copyEntry(srcPath: string, destDirPath: string): Promise<FileEntry>
  /** 移动一个条目到目标目录（演示）。目标与源所在目录相同、或把目录移进它自己内部时报错。 */
  moveEntry(srcPath: string, destDirPath: string): Promise<FileEntry>
  /** 重命名一个条目（演示）。名称非法或与同级条目重名时报错，返回重命名后的条目。 */
  renameEntry(path: string, newName: string): Promise<FileEntry>
  /** 把一个条目压缩成同级的「名称.tar.gz」（演示），返回新条目；同级已有同名压缩包时报错。 */
  compressEntry(path: string): Promise<FileEntry>
  /** 改一个条目的权限与所有者（演示）；recursive 为真时连同全部后代一起改。 */
  chmod(path: string, input: FilePermissionInput): Promise<void>
  /**
   * 按关键词在全树范围搜索目录与文件（演示）。名称与所在路径参与匹配，
   * 口径由契约的 matchesFilePath 定义；空关键词返回空数组。
   * 本期是内存遍历，未来由服务端索引提供同形结果。
   */
  search(keyword: string): Promise<readonly FileSearchResult[]>
}

/** 权限变更（演示）：模式为三位八进制，所有者为系统账号名。 */
export type FilePermissionInput = {
  mode: string
  owner: string
  /** 只对目录有意义：连同全部后代一起改。 */
  recursive: boolean
}

/**
 * 会话与权限占位。本期没有认证，mock 实现全部放行；
 * 但界面上的「无权限」分支是真实存在的，接入认证后由这里决定。
 */
export interface SessionAdapter {
  canView(area: PageArea): Promise<boolean>
}

/** 页面注入的聚合入口。 */
export interface ElysianGateway {
  session: SessionAdapter
  incidents: IncidentAdapter
  runs: RunAdapter
  skills: SkillAdapter
  approvals: ApprovalAdapter
  audit: AuditAdapter
  events: EventsAdapter
  containers: ContainerAdapter
  databases: DatabaseAdapter
  firewall: FirewallAdapter
  ssh: SshAdapter
  users: UserAdapter
  files: FilesAdapter
  /** 把演示数据重置回种子状态。 */
  reset(): Promise<void>
}

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
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallForwardRule,
  FirewallForwardInput,
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
 * 本机 Web 终端会话的身份。connect 之后界面用这些字段画标签与提示符；
 * 真实 PTY 接入后形状不变，只换 adapter 实现。
 */
export type HostTerminalSessionInfo = {
  id: string
  user: string
  hostLabel: string
  prompt: string
}

/**
 * 本机终端适配接口。本期为 mock：connect 开一条内存会话，命令在本页确定性求值，
 * 不执行真实 Shell；未来换 WebSocket/PTY adapter，页面不改。
 */
export interface TerminalAdapter {
  /** 连上本机（演示）：固定用户 ops、主机名 elysian-demo。 */
  connect(): Promise<HostTerminalSessionInfo>
  /** 演示终端：命令在本页 mock 内确定性求值，不执行真实 Shell。 */
  execMockCommand(sessionId: string, command: string): Promise<MockCommandResult>
  /** 断开一条会话（演示）：之后再 exec 必须失败。 */
  disconnect(sessionId: string): Promise<void>
}

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

/** 防火墙区适配接口。演示态由 mock 实现；Docker 运行时由 HTTP adapter 接通容器内 ufw，页面不改。 */
export interface FirewallAdapter {
  list(): Promise<readonly FirewallRule[]>
  toggles(): Promise<FirewallToggles>
  /** 切换防火墙总开关或禁 ping：演示态只改内存；Docker 真实态执行 ufw enable/disable 与 before.rules 切换。 */
  setToggles(toggles: FirewallToggles): Promise<FirewallToggles>
  create(input: FirewallRuleInput): Promise<FirewallRule>
  update(ruleId: string, input: FirewallRuleInput): Promise<FirewallRule>
  remove(ruleId: string): Promise<void>
  /** 批量导入：去重后落进数据集，返回新增列表与跳过数量。 */
  importRules(inputs: readonly FirewallRuleInput[]): Promise<FirewallImportResult>
  /** IP 规则（纯来源封禁，无端口）：真实态对应 `ufw allow/deny from <来源>`。 */
  listIpRules(): Promise<readonly FirewallIpRule[]>
  createIpRule(input: FirewallIpRuleInput): Promise<FirewallIpRule>
  updateIpRule(ruleId: string, input: FirewallIpRuleInput): Promise<FirewallIpRule>
  removeIpRule(ruleId: string): Promise<void>
  /** 端口转发（DNAT）：真实态写入 before.rules 的 *nat 标记段。 */
  listForwards(): Promise<readonly FirewallForwardRule[]>
  createForward(input: FirewallForwardInput): Promise<FirewallForwardRule>
  updateForward(ruleId: string, input: FirewallForwardInput): Promise<FirewallForwardRule>
  removeForward(ruleId: string): Promise<void>
  /** 端口防扫描状态：开关、配置、统计与当前封锁列表（真实实现基于内核 xt_recent 双名单 jail）。 */
  scanProtection(): Promise<FirewallScanProtection>
  setScanProtection(enabled: boolean): Promise<FirewallScanProtection>
  /** 更新防扫描配置（监控端口、窗口、阈值、封禁时长）；真实态改写规则文本并 reload。 */
  setScanConfig(config: FirewallScanConfig): Promise<FirewallScanProtection>
  /** 解封封锁名单中的 IP。 */
  unblockIp(ip: string): Promise<FirewallScanProtection>
  /** 从承载本面板的操作系统同步防火墙规则：返回同步后的规则总数。 */
  syncFromSystem(): Promise<{ total: number }>
}

/**
 * 日志接缝：平台运行日志与平台登录日志的只读读取。
 * 本期 mock 读内存种子；真实实现由采集服务提供同形数据，界面不改。
 */
export interface LogsAdapter {
  /** 读取整份平台运行日志（演示），含字节大小。 */
  runtimeLog(): Promise<RuntimeLogSnapshot>
  /** 读取平台登录日志（演示），按时间倒序返回。 */
  loginLogs(): Promise<readonly LoginLogEntry[]>
}

/**
 * SSH 区适配接口。演示态由 mock 实现；Docker 运行时由 HTTP adapter 接通容器内 sshd，
 * 真实执行全部经服务端编排（sshd_config 补丁、chpasswd、ssh-keygen），页面不改。
 */
/**
 * 密钥可归属的主机账号（轻量清单）。真实实现来自 getent passwd 的真实系统账号
 * （有登录 shell、uid≥1000，root 不列——Root 密钥由 Root 密钥卡单独管理）；
 * mock 实现来自账号数据集。创建密钥时把所选账号的 id 回传给 createKey。
 */
export type SshKeyAccount = {
  /** 账号标识：真实实现即系统账号名（登录名），mock 实现为账号数据集 id。 */
  id: string
  /** 展示名：真实实现为登录名，mock 实现为账号昵称。 */
  name: string
}

export interface SshAdapter {
  /**
   * 服务概况。真实实现：enabled 与 status 都映射 sshd 是否在跑（以 pidfile 探测），
   * changedAt 无可靠来源恒为 null；登录统计按今日/昨日/近 7 天三个窗口从登录日志汇总。
   */
  overview(): Promise<SshOverview>
  /** 登录方式与监听端口：真实实现读 /etc/ssh/sshd_config，缺省指令按 sshd 默认值呈现。 */
  settings(): Promise<SshAuthSettings>
  /** Root 登录策略与 Root 凭据：策略读配置，密钥材料取 root authorized_keys 首行（无则 null）。 */
  rootAuth(): Promise<SshRootAuth>
  /** 启停本机 SSH 服务：真实实现执行 service ssh start|stop。 */
  setServiceEnabled(enabled: boolean): Promise<SshOverview>
  /** 保存登录方式开关：真实实现补丁 sshd_config、sshd -t 预检通过后重启 sshd。 */
  setAuthMethods(methods: SshAuthMethods): Promise<SshAuthSettings>
  /** 保存监听端口：非法端口直接拒绝；真实实现走补丁 → 预检 → 重启，失败回滚配置。 */
  setPort(port: number): Promise<SshAuthSettings>
  /** 保存 Root 登录策略：取值限契约枚举；落盘流程同登录方式开关。 */
  saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth>
  /** 重置 Root 密码：服务端复验强度（弱密码拒绝）；真实实现经 chpasswd 的 stdin 下发，密码不进命令行。 */
  resetRootPassword(password: string): Promise<SshPasswordResetResult>
  /**
   * 生成（或重新生成）Root 密钥：真实实现 ssh-keygen 生成 ed25519 密钥对，
   * 新公钥替换 root authorized_keys 的首行（其余行保留），私钥仅随本次响应一次性返回、不落盘。
   */
  createRootKey(): Promise<SshRootAuth>
  /** 登录密钥列表：真实实现汇总各账号 authorized_keys，按 ssh-keygen 指纹呈现；不返回私钥。 */
  listKeys(): Promise<readonly SshLoginKey[]>
  /** 登录记录：按时间倒序的登录事实，含来源地址、客户端端口、账号与结果。 */
  listLoginRecords(): Promise<readonly SshLoginRecord[]>
  /** 密钥可归属的主机账号清单（见 SshKeyAccount）。 */
  keyAccounts(): Promise<readonly SshKeyAccount[]>
  /**
   * 创建登录密钥：名称去空白后校验并拒绝换行/控制字符；真实实现生成 ed25519 密钥对，
   * 公钥经验证后追加目标账号 authorized_keys，私钥仅随本次响应一次性返回、不落盘。
   */
  createKey(input: { name: string; userId: string }): Promise<SshLoginKey>
  /** 删除登录密钥：真实实现按公钥行从 authorized_keys 移除，写前备份。 */
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

/**
 * 网站部署适配接口。本期为 mock 实现：项目改动只落内存数据集；
 * 真实的项目启停、删除由未来执行层筛选与执行，页面不改。
 */
export interface WebsitesAdapter {
  /** 全部项目（演示）：五种运行时类型共用一份列表，卡片上以标签区分。 */
  list(): Promise<readonly WebsiteProject[]>
  /** 新建项目（演示）：新建即已停止、无证书；同类型同名拒绝。 */
  create(kind: WebsiteProjectKind, input: WebsiteProjectCreateInput): Promise<WebsiteProject>
  /** 修改项目（演示）：设置弹窗只改备注与到期时间。 */
  update(projectId: string, input: WebsiteProjectUpdateInput): Promise<WebsiteProject>
  /** 删除项目（演示）：只改内存数据集，不触碰任何真实站点。 */
  remove(projectId: string): Promise<void>
  /** 启动或停止项目（演示）：Java/Node 启动后补进程号，停止后清空。 */
  setRunning(projectId: string, running: boolean): Promise<WebsiteProject>
  /** 项目运行日志（演示）：确定性模板行，详情抽屉按需拉取。 */
  logs(projectId: string): Promise<readonly string[]>
}

/** 页面级访问区域。权限只做到这一粒度，本阶段不实现更细的权限模型。 */
export type PageArea =
  | 'dashboard'
  | 'security'
  | 'containers'  | 'databases'
  | 'files'
  | 'logs'
  | 'terminals'
  | 'websites'
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

/** 资源历史查询的时间窗（与仪表盘 FilterBar 选项对齐）。 */
export type ResourceHistoryTimeRange = '5m' | '30m' | '1h' | '5h' | '7d'

/** 资源采样点：毫秒时间戳为横轴。 */
export type ResourceSamplePoint = {
  ts: number
  cpu: number
  memory: number
  networkIo: number
  networkRx: number
  networkTx: number
  diskIo: number
  diskRead: number
  diskWrite: number
}

/** 按时间窗读取资源指标历史（演示内存缓冲，未来同源持久化）。 */
export interface ResourceHistoryAdapter {
  list(range: ResourceHistoryTimeRange): Promise<readonly ResourceSamplePoint[]>
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
  logs: LogsAdapter
  terminals: TerminalAdapter
  websites: WebsitesAdapter
  resources: ResourceHistoryAdapter
  /** 把演示数据重置回种子状态。 */
  reset(): Promise<void>
}

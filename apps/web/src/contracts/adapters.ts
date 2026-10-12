import type {
  PanelCommit,
  PanelInfo,
  PanelPorts,
  PanelTask,
  PanelTaskReport,
  PanelUpdate,
  PanelUpdateChannel,
  PanelUpdateTarget,
} from '@elysian/contracts'
import type {
  WebsiteSource,
  WebsiteGitSourceInput,
  WebsiteDeploymentInput,
  WebsiteDeploymentTask,
  WebsiteBuildConfig,
  WebsiteDeploymentLogs,
} from '@elysian/contracts'
import type {
  AgentModelProfile,
  AgentModelService,
  AgentModelServiceInput,
  AgentModelDiscoveryInput,
  AgentDiscoveredModel,
  AgentUpdateModelServiceInput,
  AgentModelProfileInput,
  AgentRuntimeInfo,
  AgentUpdateModelProfileInput,
  Container,
  ContainerAction,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildLogs,
  ContainerBuildPlan,
  ContainerBuildPreviewInput,
  ContainerBuildSubmitInput,
  ContainerBuildTask,
  ContainerCreateInput,
  ComposeCheckResult,
  ContainerImage,
  ImagePullProgress,
  DatabaseEngine,
  DatabaseInstance,
  DependencyProbeReport,
  DependencySetupResult,
  DependencySetupStep,
  DependencySetupTarget,
  ElysianEvent,
  EventStreamHandlers,
  FileEntry,
  FileSearchResult,
  FirewallAdapter,
  FirewallPortSync,
  LoginLogListQuery,
  LoginLogListReport,
  LogClearReport,
  LogListQuery,
  OperationLogListQuery,
  OperationLogListReport,
  PlatformLogCategory,
  RuntimeLogListReport,
  SshAdapter,
  Unsubscribe,
  UserAdapter,
  WebsiteAccessInput,
  WebsiteListReport,
  WebsiteProject,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProjectUpdateInput,
  WebsiteProxyStatus,
  WebsiteRuntimeCatalogReport,
} from '@elysian/contracts'
import type { TerminalCompletion } from '../components/terminal/terminalSession'

/*
 * Web 侧适配接口。界面只依赖这些接口，不关心数据来自 mock、内存降级还是真实网关。
 * 这是整个前端唯一的测试接缝：页面测试在这里注入替代实现。
 */

export interface EventsAdapter {
  subscribe(handlers: EventStreamHandlers): Unsubscribe
}

/** 演示命令引擎的结果（容器终端 mock 在用）；clear 为 true 时界面清空输出区。 */
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

/** 本机终端的下行帧：输出行、新提示符（命令结束信号）、截断标记与会话退出。 */
export type HostTerminalFrame =
  | { type: 'output'; lines: readonly string[] }
  | { type: 'prompt'; prompt: string }
  | { type: 'truncated'; droppedBytes: number }
  | { type: 'exit'; exitCode: number }

/** 连接关闭信息：WebSocket 关闭码与 reason（协议口径见终端实现规格「关闭码」一节）。 */
export type HostTerminalCloseInfo = { code: number; reason: string }

/** 本机终端的流式回调：帧按会话路由，关闭事件带关闭码。 */
export type HostTerminalHandlers = {
  onFrame: (sessionId: string, frame: HostTerminalFrame) => void
  onClose: (sessionId: string, info: HostTerminalCloseInfo) => void
}

/**
 * 本机终端适配接口（流式）：mock 在内存确定性求值，真实实现经 WebSocket 接
 * 容器内 PTY；两者对同一套契约断言跑（terminalAdapterContract）。
 */
export interface TerminalAdapter {
  /** 连上本机并注册流式回调；resolve 即 ready（mock 立即，真实在 ready 帧后）。 */
  connect(handlers: HostTerminalHandlers): Promise<HostTerminalSessionInfo>
  /** 送一行命令（不带换行）；会话不存在或已断开抛中文错误。 */
  sendInput(sessionId: string, line: string): Promise<void>
  /** 发送 Ctrl+C（\x03）到 PTY；mock 无进程可打断，为本地 no-op。 */
  interrupt(sessionId: string): Promise<void>
  /** 同步补全：mock 用固定词表，真实用 ready/prompt 帧推送的补全上下文缓存。 */
  complete(sessionId: string, draft: string, cursor: number): TerminalCompletion
  /** 断开会话；之后再 sendInput/interrupt 必须失败。 */
  disconnect(sessionId: string): Promise<void>
}

/**
 * 容器域适配接口。本期为 mock 实现：操作改写内存数据集，
 * 状态变化经 container/updated 事件推回；未来换真实运行时 adapter，页面不改。
 */
export type ContainerHostPolicy = {
  mountRoot: string
  reservedPorts: readonly number[]
}

export interface ContainerAdapter {
  list(): Promise<readonly Container[]>
  listImages(): Promise<readonly ContainerImage[]>
  /** 查询当前镜像源中的仓库名；目录不可用时 searchable=false，仍可手动输入。 */
  searchImageNames(term: string, registry?: string, signal?: AbortSignal): Promise<{ names: readonly string[]; searchable: boolean }>
  /** 查询选定仓库的公开版本标签；不可列出时仍允许手动输入引用。 */
  imageTags(name: string, registry?: string, signal?: AbortSignal): Promise<{ tags: readonly string[]; searchable: boolean }>
  /** Docker 运行时读取挂载根与保留端口；mock 返回演示策略。 */
  createPolicy(): Promise<ContainerHostPolicy>
  /** 打开容器终端流式会话；mock 在内存求值，Docker 运行时经 WebSocket 接 exec PTY。 */
  connectTerminal(
    containerId: string,
    handlers: HostTerminalHandlers,
  ): Promise<HostTerminalSessionInfo>
  sendTerminalInput(sessionId: string, line: string): Promise<void>
  interruptTerminal(sessionId: string): Promise<void>
  completeTerminal(sessionId: string, draft: string, cursor: number): TerminalCompletion
  disconnectTerminal(sessionId: string): Promise<void>
  /**
   * 取消未决的终端连接（connecting 态关窗或容器被删时调用）。语义与结算次序：
   * 对全部未 ready 的 pending 先 settle（以「连接容器终端失败」reject，被取消的
   * connectTerminal promise 不得悬挂）再关 socket（1000）；只作用于未 ready 的
   * 连接，已 ready 会话仍走 disconnectTerminal。可选：mock 没有 pending 概念，no-op。
   */
  cancelTerminalConnect?(): void
  /** 请求容器动作（启动/停止/重启，均为 mock）。 */
  requestAction(containerId: string, action: ContainerAction): Promise<Container>
  /** 创建容器（mock）：追加内存数据集并推 container/created。 */
  create(input: ContainerCreateInput): Promise<Container>
  /**
   * 容器工作区：随容器一起上传的配置文件的存放、内容读写、compose 路径自检
   * 与镜像构建（ADR-0021）。面板只落盘并回显真实路径，不执行 docker compose；
   * 镜像构建经 Docker Engine 的 /build 接口异步执行，compose up 不做。
   */
  /** 列全部工作区（含当场扫出的文件清单）。 */
  listApps(): Promise<readonly ContainerApp[]>
  /** 建工作区：标识与展示名按服务端同一规则校验，重名回中文错误。 */
  createApp(input: { slug: string; displayName: string }): Promise<ContainerApp>
  /** 删工作区：连目录一起删，调用方必须已就绝对路径取得二次确认；活跃构建任务期间被拒。 */
  removeApp(slug: string): Promise<void>
  /** 上传单个文件（覆盖同名）；file 是浏览器 File 对象或等价的可读流来源。 */
  uploadAppFile(slug: string, path: string, file: Blob): Promise<ContainerAppFile>
  removeAppFile(slug: string, path: string): Promise<void>
  /** 读文本文件全文；非 UTF-8 或超限回中文错误。 */
  readAppContent(slug: string, path: string): Promise<{ path: string; content: string; file: ContainerAppFile }>
  /** 覆盖写文本文件。 */
  writeAppContent(slug: string, path: string, content: string): Promise<ContainerAppFile>
  /** 对某个 compose 文件做引用路径自检；结果是保守扫描，coverage 字段说明范围。 */
  checkCompose(slug: string, path: string): Promise<ComposeCheckResult>
  /** 构建预览（只读不构建）：路径校验、上下文统计、FROM 镜像源静态校验与占用回查。 */
  previewAppBuild(slug: string, input: ContainerBuildPreviewInput): Promise<ContainerBuildPlan>
  /** 提交构建任务（202）：requestId 同参幂等返回原任务，同工作区活跃任务唯一。 */
  submitAppBuild(slug: string, input: ContainerBuildSubmitInput): Promise<ContainerBuildTask>
  /** 列该工作区的构建任务，按创建时间倒序。 */
  listAppBuilds(slug: string): Promise<readonly ContainerBuildTask[]>
  /** 读单个构建任务；不存在抛中文错误。 */
  getAppBuild(slug: string, taskId: string): Promise<ContainerBuildTask>
  /** 分页读构建日志：offset 为已读字节，单次最多 64 KiB。 */
  getAppBuildLogs(slug: string, taskId: string, offset: number): Promise<ContainerBuildLogs>
  /** 取消活跃构建任务（排队中直接取消，构建中取消引擎流）；已终态抛中文错误。 */
  cancelAppBuild(slug: string, taskId: string): Promise<void>
  /** 删除镜像（mock）：仅允许删除未被引用的镜像，改写内存数据集。 */
  removeImage(imageId: string): Promise<void>
  /** 拉取镜像（mock）：确定性生成摘要与体积后追加内存数据集，同名同标签视为已存在；registry 仅记录拉取源，不产生真实数据流。 */
  pullImage(input: { name: string; tag: string; registry?: string }, onProgress?: (progress: ImagePullProgress) => void): Promise<ContainerImage>
  /**
   * 容器状态 SSE：Docker 运行时订阅 /api/docker/events；mock 立即上报 live 并返回空退订
   * （采样仍由 gateway 的 containerEvents.wrap 负责）。
   */
  watchLive(handlers: {
    onEvent: (event: ElysianEvent) => void
    onStatus: (status: 'live' | 'connecting') => void
  }): Unsubscribe
}

/**
 * 创建数据库的输入：表单收集后经 adapter 提交；Docker 运行时由 HTTP adapter 落地。
 * 分两支——服务型由容器承载、要账号与访问权限；文件型（SQLite）只是一个本地文件，
 * 没有容器也没有账号；真实 SQLite 的路径与大小由服务端决定。
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
  versionTag?: string
  hostPort?: number
  confirmPublic?: boolean
  target?: { kind: 'new'; imageId: string; containerName: string } | { kind: 'managed'; containerId: string } | { kind: 'adopt'; containerId: string; admin: { username: string; password: string } }
}

export type DatabaseCreateFileInput = {
  kind: 'file'
  engine: DatabaseEngine
  /** 数据库名，取文件名去掉扩展名。 */
  name: string
  /** SQLite 文件来源：上传既有文件或新建空库；路径与大小由服务端决定。 */
  origin: 'uploaded' | 'created'
  /** 上传时必须带真实浏览器文件；新建空库不带。 */
  file?: File
}

export type DatabaseCreateInput = DatabaseCreateContainerInput | DatabaseCreateFileInput

/** 数据库区适配接口：Docker 运行时走 HTTP/WebSocket。 */
/** 数据库创建结果：实例之外带回任意主机访问端口的防火墙自动开放事实（其他场景为 null）。 */
export type DatabaseCreateResult = {
  instance: DatabaseInstance
  firewallPort: FirewallPortSync | null
}

export interface DatabaseAdapter {
  list(): Promise<readonly DatabaseInstance[]>
  /** 创建容器数据库或 SQLite 文件；任意主机访问的端口自动开放结果随实例带回。 */
  create(input: DatabaseCreateInput, onProgress?: (percent: number) => void): Promise<DatabaseCreateResult>
  /** 删除目标逻辑库或 SQLite 文件；真实容器与卷由独立操作删除。 */
  remove(databaseId: string): Promise<void>
  discover?(engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag?: string): Promise<{ images: readonly ContainerImage[]; containers: readonly { id: string; name: string; accessScope: string; managed: boolean; versionTag: string }[] }>
  reveal?(databaseId: string): Promise<{ username: string; password: string }>
  removeContainer?(databaseId: string): Promise<void>
  reconcile?(databaseId: string): Promise<DatabaseInstance>
  forget?(databaseId: string): Promise<void>
  openTerminal?(databaseId: string): Promise<{ execute(input: string): Promise<readonly string[]>; close(): void }>
  /** 下载一致性 SQLite 快照；失败（含会话过期）抛中文错误，不再静默下载错误 JSON。 */
  downloadSqlite?(databaseId: string): Promise<void>
}

/**
 * 防火墙区适配接口。已上提 @elysian/contracts（security/firewall.ts）——server 侧服务层
 * 与 web 侧 adapter 共用同一接口定义，这里 re-export 保持所有消费方 import 路径不变。
 */
export type { FirewallAdapter } from '@elysian/contracts'

/**
 * 日志接缝：平台运行日志、操作日志与登录日志的读取，加一个按类别的清空。
 * 三类在容器内走真实 HTTP（服务端写 `~/.Elysian/logs/platform/`，界面读同一份文件）；
 * 宿主机本地开发仍读内存种子。两种实现跑同一套契约断言（logsAdapterContract）。
 */
export interface LogsAdapter {
  /** 读取平台运行日志（时间倒序，最新在最上，含截断与存储统计）。 */
  runtimeLog(query?: LogListQuery): Promise<RuntimeLogListReport>
  /** 读取平台登录日志（时间倒序，含截断标记）。 */
  loginLogs(query?: LoginLogListQuery): Promise<LoginLogListReport>
  /** 读取平台操作日志（时间倒序，含截断与存储统计）。 */
  operationLogs(query?: OperationLogListQuery): Promise<OperationLogListReport>
  /**
   * 清空一个类别的日志，返回已删除的事实（不可恢复）。
   * 清空动作本身会留下一条留痕：该类别最多剩一条记录，且必须是本次清空的留痕。
   */
  clearLogs(category: PlatformLogCategory): Promise<LogClearReport>
}

/**
 * 密钥可归属的主机账号（轻量清单）。定义已上提 @elysian/contracts（security/ssh.ts），
 * 这里 re-export 保持消费方 import 路径不变；语义见契约侧 JSDoc。
 */
export type { SshKeyAccount } from '@elysian/contracts'

/**
 * SSH 区适配接口。已上提 @elysian/contracts（security/ssh.ts）——server 侧服务层
 * 与 web 侧 adapter 共用同一接口定义，这里 re-export 保持所有消费方 import 路径不变。
 */
export type { SshAdapter } from '@elysian/contracts'

/**
 * 主机账号适配接口。已上提 @elysian/contracts（security/users.ts）——server 侧服务层
 * 与 web 侧 adapter 共用同一接口定义，这里 re-export 保持所有消费方 import 路径不变。
 */
export type { UserAdapter } from '@elysian/contracts'

/**
 * 网站部署适配接口。mock 实现服务宿主机本地开发（内存演示数据集）；
 * Docker 运行时经同源 HTTP（/api/websites）落真实容器、站点目录与反向代理，
 * 两种实现对同一套契约断言复跑——这就是「mock 可替换」的验证方式。
 */
/** 创建与访问方式切换的结果：项目之外带回直连端口的防火墙自动开放事实（不联动场景为 null）。 */
export type WebsiteMutateResult = {
  project: WebsiteProject
  firewallPort: FirewallPortSync | null
}

export interface WebsiteDeploymentsAdapter {
  archive(file: File, mode: 'source' | 'artifact', signal?: AbortSignal): Promise<WebsiteSource>
  git(input: WebsiteGitSourceInput, signal?: AbortSignal): Promise<WebsiteSource>
  source(id: string, signal?: AbortSignal): Promise<WebsiteSource>
  discardSource(id: string): Promise<void>
  submit(input: WebsiteDeploymentInput): Promise<WebsiteDeploymentTask>
  list(): Promise<readonly WebsiteDeploymentTask[]>
  task(id: string): Promise<WebsiteDeploymentTask>
  logs(id: string, offset: number): Promise<WebsiteDeploymentLogs>
  cancel(id: string): Promise<void>
  resume(id: string, config: WebsiteBuildConfig): Promise<WebsiteDeploymentTask>
  rollback(projectId: string): Promise<WebsiteDeploymentTask>
}

export interface WebsitesAdapter {
  /** 旧 adapter 可缺省；生产与标准 mock 均提供完整部署接缝。 */
  deployment?: WebsiteDeploymentsAdapter
  runtimeCatalog(signal?: AbortSignal): Promise<WebsiteRuntimeCatalogReport>
  /** 全部项目附带反向代理通道状态：列表读取时探测一次，读端点无副作用。 */
  list(): Promise<WebsiteListReport>
  /** 新建项目：新建即已停止、无证书；名称跨类型全局唯一（站点目录只由名称推导）。 */
  create(kind: WebsiteProjectKind, input: WebsiteProjectCreateInput): Promise<WebsiteMutateResult>
  /** 修改项目备注与到期时间。 */
  update(projectId: string, input: WebsiteProjectUpdateInput): Promise<WebsiteProject>
  /** 切换直连或域名访问，并可更换证书。 */
  setAccess(projectId: string, access: WebsiteAccessInput): Promise<WebsiteMutateResult>
  /** 删除项目：停容器、回收反向代理路由、删容器与站点目录、删登记；不幂等。 */
  remove(projectId: string): Promise<void>
  /** 启动或停止项目：每个项目的独立运行容器启停。 */
  setRunning(projectId: string, running: boolean): Promise<WebsiteProject>
  /** 项目运行日志：读取项目容器日志。 */
  logs(projectId: string): Promise<readonly string[]>
  /**
   * 域级对账：从登记全量重新生成并下发反向代理配置，返回下发后的通道状态。
   * 覆盖「降级期间创建了域名站点、通道恢复后路由未下发」与「配置漂移」两个场景。
   */
  reconcileProxy(): Promise<WebsiteProxyStatus>
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
  | 'agent'
  | 'runs'
  | 'skills'
  | 'approvals'
  | 'audit'
  | 'settings'

/** 下载准备结果。ID 仅在当前登录会话中短时有效，不代替登录凭据。 */
export type FileDownload = { id: string; name: string; sizeBytes: number; expiresAt: string }

/** 上传前核对的目标状态；token 由服务端绑定路径、大小与目标版本。 */
export type FileUploadCheck = {
  state: 'create' | 'replace'
  token: string
  existing?: FileEntry
}

export type FileUploadOptions = {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

/** 文件管理接缝：真实运行时走同源 API，本地演示只修改内存目录树。 */
export interface FilesAdapter {
  prepareDownload(path: string, signal?: AbortSignal): Promise<FileDownload>
  /** 交给浏览器下载管理器；后续 HTTP 错误通过回调通知，不宣称保存完成。 */
  startDownload(download: FileDownload, onError?: (error: Error) => void): void
  checkUpload(dirPath: string, name: string, sizeBytes: number, signal?: AbortSignal): Promise<FileUploadCheck>
  uploadFile(dirPath: string, file: File, check: FileUploadCheck, overwrite: boolean, options?: FileUploadOptions): Promise<FileEntry>
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

/** 会话运行模式：demo 为本地无后端演示（恒放行不强制登录），real 为真实服务端会话。 */
export type SessionMode = 'demo' | 'real'

/** 会话探测结果（GET /api/auth/session）：真实模式由服务端判定，演示模式恒放行。 */
export type SessionStatus = {
  /** demo：本地无后端演示，恒放行不强制登录；real：真实会话。 */
  mode: SessionMode
  authenticated: boolean
  /** 服务端开发固定账号当前可用（仅 real 模式可能为 true）。 */
  devAccount: boolean
  /** 服务端裁决过的回跳地址（仅请求带 returnTo 时回答）：null 表示被拦截，undefined 表示未回答。 */
  returnTo?: string | null
}

/** 活跃会话列表的一行（GET /api/auth/sessions）：不含会话 id（不透明凭据不下发），也没有设备信息（服务端不采集）。 */
export type SessionListRow = {
  /** 会话创建时间（ISO 字符串）。 */
  createdAt: string
  /** 最近一次使用时间（ISO 字符串，服务端滑动窗口的基准）。 */
  lastUsedAt: string
  /** 是否为发起本次请求的当前会话。 */
  current: boolean
}

/** 修改面板密码的输入：三个口令字段只经请求体直达服务端，不进任何日志。 */
export type PanelPasswordChangeInput = {
  currentPassword: string
  newPassword: string
  confirmNewPassword: string
}

/**
 * 会话与权限接缝。`canView` 是页面级权限占位（未来策略接缝）；
 * 登录鉴权走 `status`/`login`/`logout`：Docker 运行时经 /api/auth 承载真实会话，
 * 演示模式（mock、本地无后端）不强制登录。
 */
export interface SessionAdapter {
  canView(area: PageArea): Promise<boolean>
  /** 探测当前会话；带 returnTo 时同时请求服务端裁决回跳地址；passive 后台检查不延长空闲期限。服务端不可达或响应无效时抛中文错误。 */
  status(returnTo?: string, options?: { passive?: boolean }): Promise<SessionStatus>
  /** 登录（用户名 + 密码，Cookie 由服务端下发）；失败抛中文 Error（如「用户名或密码错误」），成功无返回。 */
  login(username: string, password: string): Promise<void>
  /** 登出并清除会话 Cookie；幂等。 */
  logout(): Promise<void>
  /** 列出活跃会话（含当前会话标记），按最近活跃倒序；real 模式经 GET /api/auth/sessions。 */
  listSessions(): Promise<readonly SessionListRow[]>
  /** 修改面板密码：成功后全部会话按 pwdEpoch 语义失效、当前会话 Cookie 一并清除；失败抛中文 Error。 */
  changePassword(input: PanelPasswordChangeInput): Promise<void>
  /** 退出除当前会话外的全部活跃会话；成功后重列会话只剩当前会话。 */
  logoutOtherSessions(): Promise<void>
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

/**
 * 宿主依赖检测接缝：现场探测宿主 Docker Engine 与 Caddy 管理通道的就绪性。
 * Docker 运行时经同源 HTTP（/api/platform/dependencies，服务端每次请求现场探测、
 * 结果不吃缓存）；mock 实现恒双 ok（本地开发是演示模式，宿主依赖引导只属于
 * Docker 运行时的真实场景）。探测失败时引导层静默降级，不伪装成依赖缺失。
 */
export interface DependenciesAdapter {
  /** 现场探测宿主 Docker 与 Caddy 通道；mock 实现恒双 ok（演示模式不引导）。 */
  probe(): Promise<DependencyProbeReport>
  /**
   * 在宿主上执行安装的一步。脚本由服务端固定，这里只传目标与步骤名。
   * mock 立即成功：演示模式不弹引导；测试注入缺失报告时用它走完分步而不碰宿主。
   */
  setup(target: DependencySetupTarget, step: DependencySetupStep): Promise<DependencySetupResult>
}

/** 模型设置所需的 Agent 内核就绪报告。 */
export interface AgentRuntimeAdapter {
  runtime(signal?: AbortSignal): Promise<AgentRuntimeInfo>
}

/** 系统设置中的模型目录与服务配置。 */
export interface ModelSettingsAdapter {
  discoverModels(input: AgentModelDiscoveryInput, signal?: AbortSignal): Promise<readonly AgentDiscoveredModel[]>
  listModelServices(signal?: AbortSignal): Promise<readonly AgentModelService[]>
  createModelService(input: AgentModelServiceInput): Promise<AgentModelService>
  updateModelService(serviceId: string, input: AgentUpdateModelServiceInput): Promise<AgentModelService>
  listModelProfiles(signal?: AbortSignal): Promise<readonly AgentModelProfile[]>
  createModelProfile(input: AgentModelProfileInput): Promise<AgentModelProfile>
  /** 更新产生新修订（body 携带 expectedRevision；凭据省略沿用、空串清除）。 */
  updateModelProfile(profileId: string, input: AgentUpdateModelProfileInput): Promise<AgentModelProfile>
}

export interface PanelAdapter {
 info(): Promise<PanelInfo>
 checkUpdate(channel: PanelUpdateChannel): Promise<PanelUpdate>
 /** 更新日志：列所选更新来源最近的提交，只读上游，不改动面板状态。 */
 commits(channel: PanelUpdateChannel): Promise<PanelCommit[]>
 ports(value: PanelPorts, requestId: string): Promise<PanelTask>
 restart(requestId: string): Promise<PanelTask>
 update(target: PanelUpdateTarget, requestId: string): Promise<PanelTask>
 task(id: string, offset?: number): Promise<PanelTaskReport>
 ready(origin: string, id: string, signal?: AbortSignal): Promise<boolean>
}

export interface ElysianGateway {
  modelSettings: ModelSettingsAdapter
  agentRuntime: AgentRuntimeAdapter
 panel: PanelAdapter
  session: SessionAdapter
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
  dependencies: DependenciesAdapter
}

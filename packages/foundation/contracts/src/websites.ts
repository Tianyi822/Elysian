/*
 * 网站部署域类型与词典。本期只做项目列表的演示呈现：
 * 项目的启动、停止、删除都是系统级变更，由未来接入的执行层筛选与执行，
 * 这里的类型只描述界面需要呈现的事实。
 * 项目按运行时类型登记（PHP、.NET 与反向代理不在本期范围），
 * 单张列表承载全部类型，类型在创建时选择、在卡片与详情上以标签呈现。
 */

/** 项目类型：网站项目按运行时归类，创建时选择、列表上以标签呈现。 */
export type WebsiteProjectKind = 'java' | 'node' | 'go' | 'python' | 'html'

export const WEBSITE_PROJECT_KINDS = [
  'java',
  'node',
  'go',
  'python',
  'html',
] as const satisfies readonly WebsiteProjectKind[]

export const WEBSITE_PROJECT_KIND_LABELS: Record<WebsiteProjectKind, string> = {
  java: 'Java项目',
  node: 'Node项目',
  go: 'Go项目',
  python: 'Python项目',
  html: 'HTML项目',
}

export type WebsiteRunState = 'running' | 'stopped'

export const WEBSITE_RUN_STATES = [
  'running',
  'stopped',
] as const satisfies readonly WebsiteRunState[]

export const WEBSITE_RUN_STATE_LABELS: Record<WebsiteRunState, string> = {
  running: '运行中',
  stopped: '已停止',
}

export type WebsiteCertState = 'deployed' | 'expired' | 'none'

export const WEBSITE_CERT_STATES = [
  'deployed',
  'expired',
  'none',
] as const satisfies readonly WebsiteCertState[]

export const WEBSITE_CERT_STATE_LABELS: Record<WebsiteCertState, string> = {
  deployed: '已部署',
  expired: '已过期',
  none: '未部署',
}

export type WebsiteCategory = 'production' | 'testing' | 'development'

export const WEBSITE_CATEGORIES = [
  'production',
  'testing',
  'development',
] as const satisfies readonly WebsiteCategory[]

export const WEBSITE_CATEGORY_LABELS: Record<WebsiteCategory, string> = {
  production: '生产环境',
  testing: '测试环境',
  development: '开发环境',
}

/** 需要选择运行时版本的项目类型（HTML 静态站无运行时版本）。 */
export type WebsiteRuntimeKind = Exclude<WebsiteProjectKind, 'html'>

/**
 * 各语言可选运行时版本（演示 mock）：后期接真实开发环境配置时，
 * 只换这份目录的数据源，表单与卡片仍读同一形状。
 */
export const WEBSITE_RUNTIME_VERSIONS: Record<WebsiteRuntimeKind, readonly string[]> = {
  java: ['11', '17', '21'],
  node: ['18.19.1', '20.11.1', '22.4.0'],
  go: ['1.21.5', '1.22.4', '1.23.1'],
  python: ['3.10.14', '3.11.9', '3.12.4'],
}

/** 代码落地的固定根前缀：创建时不可改，详情页只读展示完整路径。 */
export const WEBSITE_ROOT_BASE = '/www/wwwroot'

export const WEBSITE_PROJECT_NAME_MAX_LENGTH = 64

/** 项目流量统计（演示数据）：今日流量与累计流量。 */
export type WebsiteTraffic = {
  todayMb: number
  totalGb: number
}

export type WebsiteProject = {
  id: string
  kind: WebsiteProjectKind
  /** 项目名称，卡片首行的显示主体。 */
  name: string
  /** 运行进程号：非 HTML 类型运行中有 PID，已停止或 HTML 为 null。 */
  pid: number | null
  /** 服务端口：所有类型必有。 */
  port: number
  /** 运行时版本：Java/Node/Go/Python 有值，HTML 为 null。 */
  runtimeVersion: string | null
  /** 项目根目录（绝对路径），由固定前缀与项目名推导，不可在创建表单改。 */
  rootDir: string
  runState: WebsiteRunState
  /** 到期时间（ISO）；演示字段，创建表单不填。 */
  expiryAt: string | null
  /** 备注为空时界面显示 —。 */
  note: string | null
  cert: WebsiteCertState
  /** 项目分类，供「全部分类」下拉过滤。 */
  category: WebsiteCategory
  /** 部署命令：启动该项目所执行的命令；HTML 静态站由 Web 服务直接托管，为 null。 */
  deployCommand: string | null
  /** Git 仓库地址：演示字段，本期只存地址不真拉代码。 */
  gitUrl: string | null
  /** 流量统计（演示数据）。 */
  traffic: WebsiteTraffic
}

/** 新建项目的输入。根目录由服务端按固定前缀推导；新建即已停止、无证书。 */
export type WebsiteProjectCreateInput = {
  name: string
  /** 端口必填，1–65535。 */
  port: number
  /** 运行时版本：非 HTML 类型必填；HTML 传入会被忽略。 */
  runtimeVersion?: string | null
  /** Git 仓库地址；空串按未配置处理。 */
  gitUrl?: string | null
  note?: string | null
}

/** 修改项目的输入：设置弹窗只改备注与到期时间，名称与根目录不动。 */
export type WebsiteProjectUpdateInput = {
  note?: string | null
  /** ISO 时间或 null（取消到期）。 */
  expiryAt?: string | null
}

/** 所有项目类型都配置端口。 */
export function websiteProjectUsesPort(_kind: WebsiteProjectKind): boolean {
  return true
}

/** 是否需要选择运行时版本：HTML 静态站没有。 */
export function websiteProjectUsesRuntime(kind: WebsiteProjectKind): boolean {
  return kind !== 'html'
}

/** 由项目名推导固定根目录。 */
export function websiteProjectRootDir(name: string): string {
  return `${WEBSITE_ROOT_BASE}/${name.trim()}`
}

/**
 * 从 Git 地址解析仓库名作项目名候选。
 * 支持 https://…/org/repo(.git) 与 git@host:org/repo(.git)；解析失败返回 null。
 * 不依赖 DOM URL：契约包保持无运行时 DOM 依赖。
 */
export function parseProjectNameFromGitUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  const withoutGit = trimmed.replace(/\.git$/i, '')
  const sshMatch = /^git@[^:]+:(.+)$/i.exec(withoutGit)
  const httpsMatch = /^https?:\/\/[^/]+\/(.+)$/i.exec(withoutGit)
  const path = sshMatch?.[1] ?? httpsMatch?.[1]
  if (!path) return null
  const segments = path.split('/').filter(Boolean)
  const last = segments.at(-1)
  if (!last) return null
  return last.slice(0, WEBSITE_PROJECT_NAME_MAX_LENGTH)
}

/** 项目名判据：去空白后非空且不超上限。 */
export function isValidWebsiteProjectName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= WEBSITE_PROJECT_NAME_MAX_LENGTH
}

/** 端口判据：1–65535 的整数。 */
export function isValidWebsitePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

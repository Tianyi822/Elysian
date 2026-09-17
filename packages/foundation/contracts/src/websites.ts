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
  /** 运行进程号：Java 与 Node 展示该信息，已停止的进程没有 PID，为 null。 */
  pid: number | null
  /** 服务端口：只有 Java 与 Node 有端口概念，其余类型为 null。 */
  port: number | null
  /** 运行时版本：Node 展示该信息（如 20.11.1），其余类型为 null。 */
  runtimeVersion: string | null
  /** 项目根目录（绝对路径）。 */
  rootDir: string
  runState: WebsiteRunState
  /** 到期时间（ISO）：Go 项目没有到期概念，为 null。 */
  expiryAt: string | null
  /** 备注为空时界面显示 —。 */
  note: string | null
  cert: WebsiteCertState
  /** 项目分类，供「全部分类」下拉过滤。 */
  category: WebsiteCategory
  /** 部署命令：启动该项目所执行的命令；HTML 静态站由 Web 服务直接托管，为 null。 */
  deployCommand: string | null
  /** 流量统计（演示数据）。 */
  traffic: WebsiteTraffic
}

/** 新建项目的输入。运行状态、PID 与证书不由表单决定：新建即已停止、无证书，由演示引擎按需演进。 */
export type WebsiteProjectCreateInput = {
  name: string
  /** 根目录缺省由名称推导（/www/wwwroot/<名称>）。 */
  rootDir?: string
  /** 端口仅 Java 与 Node 接受，其余类型传入也会被忽略。 */
  port?: number
  note?: string | null
}

/** 修改项目的输入：设置弹窗只改备注与到期时间，名称与根目录不动。 */
export type WebsiteProjectUpdateInput = {
  note?: string | null
  /** ISO 时间或 null（取消到期）。 */
  expiryAt?: string | null
}

/** 端口是否为该项目类型的必备概念，供工具栏与建站表单共用同一把尺子。 */
export function websiteProjectUsesPort(kind: WebsiteProjectKind): boolean {
  return kind === 'java' || kind === 'node'
}

export const WEBSITE_PROJECT_NAME_MAX_LENGTH = 64

/** 项目名判据：去空白后非空且不超上限。 */
export function isValidWebsiteProjectName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= WEBSITE_PROJECT_NAME_MAX_LENGTH
}

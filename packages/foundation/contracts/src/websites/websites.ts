import type { WebsiteRelease, WebsiteDeploymentTarget } from './deployments.ts'
/*
 * 网站部署域类型与词典。每个项目一个 Docker 容器：运行时使用钉死版本的
 * 官方镜像，HTML 使用固定 Nginx 镜像；站点目录 bind 挂载，直连端口发布到
 * 0.0.0.0，域名模式发布到 127.0.0.1（PHP 与 .NET 不在本期范围）。
 * 反向代理由宿主 Caddy 承载：面板经 admin unix socket 以整配置原子替换
 * （POST /load）下发由登记全量生成的路由，通道状态与配置漂移在列表读取时
 * 以 WebsiteProxyStatus 如实呈现；本模块只放类型、枚举、纯常量表与纯函数，
 * 名称/端口/域名判据与缺省命令生成由表单、mock 与服务端共用同一份。
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

export type WebsiteAccessMode = 'direct' | 'domain'

/** 证书只描述用户上传的公开 CA 证书；applied 是 Caddy 配置核对事实。 */
export type WebsiteCertificate = {
  issuer: string
  notAfter: string
  fingerprint256: string
  applied: boolean
}

export type WebsiteAccessInput =
  | { mode: 'direct' }
  | { mode: 'domain'; domain: string; certificatePem?: string; privateKeyPem?: string }

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

/** 反向代理通道状态：列表读取时对宿主 Caddy 管理通道探测一次的结果。 */
export type WebsiteProxyState = 'active' | 'unavailable'

export const WEBSITE_PROXY_STATES = [
  'active',
  'unavailable',
] as const satisfies readonly WebsiteProxyState[]

export const WEBSITE_PROXY_STATE_LABELS: Record<WebsiteProxyState, string> = {
  active: '正常',
  unavailable: '不可用',
}

/** 需要选择运行时版本的项目类型（HTML 静态站无运行时版本）。 */
export type WebsiteRuntimeKind = Exclude<WebsiteProjectKind, 'html'>

/**
 * 后端从官方发布记录与镜像标签取得的可选运行时版本；版本钉死、禁 latest。
 */
export type WebsiteRuntimeCatalogEntry = {
  version: string
  image: string
  maintenance: 'maintained' | 'legacy'
  checkedAt: string
}

export type WebsiteRuntimeCatalog = Record<WebsiteRuntimeKind, readonly WebsiteRuntimeCatalogEntry[]>
export type WebsiteRuntimeCatalogReport = {
  catalog: WebsiteRuntimeCatalog
  fetchedAt: string
  stale: boolean
  detail: string | null
}

/** Java 初始 GA 的省略零分量展开为完整版本，正式构建号保持原样。 */
export function normalizeWebsiteJavaReleaseVersion(version: string): string {
  const match = /^(\d+(?:\.\d+){0,3})\+(\d+)$/.exec(version)
  if (!match) return version
  const parts = match[1]!.split('.')
  while (parts.length < 3) parts.push('0')
  return `${parts.join('.')}+${match[2]}`
}

export function isWebsiteRuntimeReleaseVersion(kind: WebsiteRuntimeKind, version: string): boolean {
  return kind === 'java' ? /^(8u\d+-b\d+|\d+\.\d+\.\d+(?:\.\d+)?\+\d+)$/.test(version) : /^\d+\.\d+\.\d+$/.test(version)
}

/** 传输与缓存的共同校验出口：拒绝预发布、浮动镜像和版本／镜像不匹配。 */
export function parseWebsiteRuntimeCatalogReport(value: unknown): WebsiteRuntimeCatalogReport {
  const message = '正式运行时版本目录响应无效'
  if (!value || typeof value !== 'object') throw new Error(message)
  const row = value as Record<string, unknown>
  if (typeof row.fetchedAt !== 'string' || !Number.isFinite(Date.parse(row.fetchedAt)) || typeof row.stale !== 'boolean' || (row.detail !== null && typeof row.detail !== 'string')) throw new Error(message)
  if (!row.catalog || typeof row.catalog !== 'object') throw new Error(message)
  const source = row.catalog as Record<string, unknown>
  const catalog: WebsiteRuntimeCatalog = { java: [], node: [], go: [], python: [] }
  for (const kind of ['java', 'node', 'go', 'python'] as const) {
    const entries = source[kind]
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 5000) throw new Error(message)
    const seen = new Set<string>()
    catalog[kind] = entries.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error(message)
      const entry = item as Record<string, unknown>
      if (typeof entry.version !== 'string' || !isWebsiteRuntimeReleaseVersion(kind, entry.version) || seen.has(entry.version) || typeof entry.image !== 'string' || (entry.maintenance !== 'maintained' && entry.maintenance !== 'legacy') || typeof entry.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.checkedAt)) throw new Error(message)
      const image = entry.image
      if (kind === 'java') {
        const match = /^eclipse-temurin:(8u\d+-b\d+|\d+(?:\.\d+){0,3}_\d+)-(jre|jdk)$/.exec(image)
        if (!match) throw new Error(message)
        const exact = normalizeWebsiteJavaReleaseVersion(match[1]!.replace('_', '+'))
        if (entry.version !== exact) throw new Error(message)
      } else if (image !== `${kind === 'go' ? 'golang' : kind}:${entry.version}${kind === 'python' ? '-slim' : ''}`) throw new Error(message)
      seen.add(entry.version)
      return { version: entry.version, image, maintenance: entry.maintenance, checkedAt: entry.checkedAt }
    })
  }
  return { catalog, fetchedAt: row.fetchedAt, stale: row.stale, detail: row.detail }
}

/** 演示缺省挂载根：mock 与无服务端挂载根信息时的站点目录前缀来源。 */
const WEBSITE_DEMO_MOUNT_ROOT = '/www'

/** 演示缺省的站点根前缀（演示挂载根 + /wwwroot）；真实环境路径由服务端挂载根推导。 */
export const WEBSITE_ROOT_BASE = '/www/wwwroot'

export const WEBSITE_PROJECT_NAME_MAX_LENGTH = 64

/** 流量统计形状：真实实现无统计来源、恒为 0，不伪造数字；mock 演示数据保留非零。 */
export type WebsiteTraffic = {
  todayMb: number
  totalGb: number
}

export type WebsiteProject = {
  currentRelease?: WebsiteRelease
  previousRelease?: WebsiteRelease
  buildRuntimeVersion?: string
  deploymentTarget?: WebsiteDeploymentTarget

  id: string
  kind: WebsiteProjectKind
  /** 项目名称，卡片首行的显示主体；站点目录路径段的唯一来源，跨类型全局唯一。 */
  name: string
  /** 容器主进程在宿主命名空间的 PID；停止时为 null。 */
  pid: number | null
  /** 站点容器 ID（64 位十六进制）；容器被外部删除后保留登记值如实显示。 */
  containerId: string | null
  /** 宿主发布端口。直连绑 0.0.0.0，域名绑 127.0.0.1；HTML 容器内端口为 80。 */
  port: number
  /** 运行时版本：Java/Node/Go/Python 有值，HTML 为 null。 */
  runtimeVersion: string | null
  /** 站点目录的绝对路径：真实环境为服务端解析的挂载根下路径（<mountRoot>/wwwroot/<项目名>），演示环境为固定前缀。 */
  rootDir: string
  /** 运行状态来自容器 State.Running。 */
  runState: WebsiteRunState
  accessMode: WebsiteAccessMode
  /** 域名访问时的主机名；直连为 null。 */
  domain: string | null
  /** 当前 Caddy 配置的 :443 监听、域名、处理器和目标均与项目登记一致；不代表证书已签发或公网可达。 */
  routeApplied: boolean
  /** 到期时间（ISO）；演示字段，创建表单不填。 */
  expiryAt: string | null
  /** 备注为空时界面显示 —。 */
  note: string | null
  certificate: WebsiteCertificate | null
  /** 项目分类，供「全部分类」下拉过滤。 */
  category: WebsiteCategory
  /** 面板为站点容器配置的启动命令；HTML 使用 Nginx 默认命令。 */
  deployCommand: string | null
  /** Git 仓库地址；部署来源固定实际提交，人工创建项目仅保留登记。 */
  gitUrl: string | null
  /** 流量统计：真实实现恒 0（无统计来源，不伪造数字），mock 演示数据保留非零。 */
  traffic: WebsiteTraffic
}

/** 新建项目的输入。站点目录由服务端按挂载根下的项目名推导；新建即已停止。 */
export type WebsiteProjectCreateInput = {
  name: string
  /** 端口必填，1–65535。 */
  port: number
  /** 运行时版本：非 HTML 类型必填；HTML 传入会被忽略。 */
  runtimeVersion?: string | null
  access: WebsiteAccessInput
  /** Docker Cmd 参数；非 HTML 类型必须由用户明确填写。 */
  command?: string | null
  /** Git 仓库地址；空串按未配置处理。 */
  gitUrl?: string | null
  note?: string | null
}

/** 修改项目的输入：备注、到期时间和非 HTML 启动命令；访问方式由专用入口管理。 */
export type WebsiteProjectUpdateInput = {
  note?: string | null
  /** ISO 时间或 null（取消到期）。 */
  expiryAt?: string | null
  command?: string | null
}

/**
 * 反向代理通道状态报告：state 为 unavailable 时 detail 给中文原因；
 * 通道可用但当前 Caddy 配置与登记期望有缺口（例如外部重置）时 state 仍为
 * active、detail 如实写缺口（如「N 个站点的路由未下发」）；
 * 正常且无漂移为 detail null。
 */
export type WebsiteProxyStatus = {
  state: WebsiteProxyState
  detail: string | null
}

/** 站点列表响应：项目列表附带反向代理通道状态（列表读取时探测一次，读端点无副作用）。 */
export type WebsiteListReport = {
  projects: readonly WebsiteProject[]
  proxy: WebsiteProxyStatus
}

/** 所有项目类型都登记宿主端口：HTML 与 Node 静态目标映射到独立 Nginx 容器的 80 端口。 */
export function websiteProjectUsesPort(_kind: WebsiteProjectKind): boolean {
  return true
}

/** 是否需要选择运行时版本：HTML 静态站没有。 */
export function websiteProjectUsesRuntime(kind: WebsiteProjectKind): boolean {
  return kind !== 'html'
}

/**
 * 由项目名推导站点目录绝对路径：`<mountRoot>/wwwroot/<项目名>`，名称两侧空白先行去除。
 * mountRoot 是服务端解析的挂载根（缺省演示值 '/www'）；真实环境由
 * `ELYSIAN_DOCKER_MOUNT_ROOT` 解析出的根传入（缺省 '/srv'）。
 */
export function websiteProjectRootDir(name: string, mountRoot = WEBSITE_DEMO_MOUNT_ROOT): string {
  return `${mountRoot}/wwwroot/${name.trim()}`
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

/**
 * 项目名判据：去空白后 1–64 字符，且不含 `/`、`\`、`:` 与控制字符，不得为 `.` 或 `..`。
 * 冒号与斜杠一样是引擎 bind 字符串的分隔符（`source:dest[:mode]`），放进名称会把
 * bind 源截断到第一个冒号之前、容器创建必然失败。名称是站点目录路径段的唯一来源
 * （路径穿越防线），表单、mock 与服务端共用同一判据。
 */
export function isValidWebsiteProjectName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > WEBSITE_PROJECT_NAME_MAX_LENGTH) return false
  if (trimmed === '.' || trimmed === '..') return false
  // 控制字符按 C0（U+0000–U+001F）加 DEL（U+007F）计：目录名里不该出现任何一项。
  if (/[/\\:\u0000-\u001f\u007f]/.test(trimmed)) return false
  return true
}

/** 端口判据：1–65535 的整数。 */
export function isValidWebsitePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** RFC 1123 标签形态：字母数字开头结尾，中间可夹连字符。 */
const WEBSITE_DOMAIN_LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

/** 域名总长上限（ASCII 形态，与 DNS 全名一致）。 */
const WEBSITE_DOMAIN_MAX_LENGTH = 253

/**
 * 域名判据：RFC 1123 形态——每标签 `[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?`、
 * 总长不超过 253、至少两级标签；IP 字面量与通配符（`*.`）一律拒绝（通配符与非
 * ASCII 字符本身过不了标签形态，IP 字面量在形态上合法、须显式排除）。
 * 表单与服务端共用；是否绑定域名由调用方决定，本函数只判非空串的词法。
 */
export function isValidWebsiteDomain(domain: string): boolean {
  const trimmed = domain.trim()
  if (!trimmed || trimmed.length > WEBSITE_DOMAIN_MAX_LENGTH) return false
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(trimmed)) return false
  const labels = trimmed.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => WEBSITE_DOMAIN_LABEL_PATTERN.test(label))
}

/** HTML 使用固定的 Docker 官方 Nginx 镜像。 */
export const WEBSITE_HTML_IMAGE = 'nginx:1.30.4-alpine3.24'

/**
 * version 必须落在后端提供的正式版本目录内，否则返回 null；HTML 返回固定镜像。
 * 建容器与删除时的镜像核对都从这里取引用，用户无法指定任意镜像。
 */
export function websiteRuntimeImageRef(
  kind: WebsiteProjectKind,
  version: string | null,
  catalog?: WebsiteRuntimeCatalog,
): string | null {
  if (kind === 'html') return WEBSITE_HTML_IMAGE
  if (version === null) return null
  return catalog?.[kind].find((entry) => entry.version === version)?.image ?? null
}

/**
 * 面板为站点容器配置的启动命令（创建时生成、固化进登记，如实反映容器 Cmd）：
 * java、node、go 与 python 需要用户填写命令；
 * HTML 使用固定 Nginx 命令。前端与 mock 共用本函数，Go 服务端保持同一规则。
 */
export function websiteDefaultDeployCommand(kind: WebsiteProjectKind): string | null {
  return kind === 'html' ? 'nginx -g daemon off;' : null
}

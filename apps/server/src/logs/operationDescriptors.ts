import {
  FIREWALL_POLICY_LABELS,
  SSH_ROOT_LOGIN_POLICY_LABELS,
  type FirewallPolicy,
  type OperationLogCategory,
  type SshRootLoginPolicy,
} from '@elysian/contracts'
import { FIREWALL_MOUNT } from '../firewall/firewallRoutes.ts'
import { FILES_MOUNT } from '../files/filesRoutes.ts'
import { SSH_MOUNT } from '../ssh/sshRoutes.ts'
import { USERS_MOUNT } from '../users/usersRoutes.ts'
import { DOCKER_MOUNT } from '../docker/dockerRoutes.ts'
import { AUTH_MOUNT, DATABASE_MOUNT, PLATFORM_MOUNT, WEBSITES_MOUNT } from '../shared/apiMounts.ts'
import { LOGS_MOUNT } from './logsRoutes.ts'

/*
 * 操作日志的端点描述符表：**什么动作被记录、记成什么**的唯一权威。
 *
 * 采集中间件（operationAudit）挂在 app 层、包住每一个到达服务端的写请求：命中本表的
 * 请求由服务端自己生成记录，客户端无法提交、也无法影响 category/action/result/actor
 * 任何一个字段（详见 operationAudit 的注释）。因此本表的全部内容都是**服务端常量**，
 * 唯一从请求取值的是 summarize 与 target 函数——它们只读自己点名的那几个字段。
 *
 * 凭据隔离是结构性的：**只有声明了 summarize 的端点才会被读取请求体**（对象名要取体时，
 * 该端点本来就有参数摘要，两者同桌）。于是「不声明 ⇒ 请求体里的密码/密钥材料永远不进日志」
 * 不靠实现者的自觉，而靠采集中间件在 clone 之前就先查这张表。据此**不声明**的端点：
 * POST /api/security/ssh/root-password、POST /api/security/users、PUT /api/security/users/:id
 * （前者的体是密码，后两者的体含密码）与 POST /api/auth/login、POST /api/auth/password
 * （登录与改密的体都含密码字段）；POST /api/auth/sessions/logout-others 无请求体，同样无可摘要。
 *
 * 数据库写端点登记动作与目标；密码与语句正文均不进入摘要。
 *
 * 新增写端点若忘记登记，operationDescriptors.test.ts 的漂移守卫会立刻变红。
 */

/** 摘要与对象的取值上下文：只含白名单字段的请求体、路径参数与最终状态码。 */
export type OperationInput = {
  /** 已解析的请求体对象；没有体、体超限或不是 JSON 对象时为 null。 */
  body: Record<string, unknown> | null
  /** 从路由模板与具体路径还原的路径参数（extractPathParams）。 */
  params: Record<string, string>
  /** 最终 HTTP 状态码（服务端事实）。 */
  status: number
}

export type OperationDescriptor = {
  category: OperationLogCategory
  /** 中文动作短语。 */
  action: string
  /**
   * 动作对象；省略时记录为 null。函数形拿得到路径参数，也拿得到请求体——但**只有声明了
   * summarize 的端点才会被读取请求体**，因此未声明 summarize 的端点里传入的 body 恒为 null
   * （凭据类端点的对象名只能来自路径参数，如「账号 <id>」）。
   */
  target?: string | ((input: Omit<OperationInput, 'status'>) => string | null)
  /**
   * 参数摘要：只从白名单字段生成，返回 null 表示无摘要。
   * **它是唯一让采集器读取请求体的声明**：不声明 summarize 的端点永远不会被 clone、
   * 永远不会被读体——凭据类端点因此结构性地不可能泄漏到日志，不靠实现者的自觉。
   */
  summarize?: (input: OperationInput) => string | null
}

/** 本表存在动作对象的端点才用的取值器：字段缺失或类型不符一律回 null（摘要随之退化为无）。 */
function text(body: Record<string, unknown> | null, field: string): string | null {
  const value = body?.[field]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 开关的中文取值：只有 true 才算「开」（体里缺字段时按「关」呈现，与服务端的布尔校验一致）。 */
function onOff(value: unknown): string {
  return value === true ? '开' : '关'
}

/** 路径参数取值：模板里有、具体路径里给不出时回 null。 */
function param(params: Record<string, string>, name: string): string | null {
  return params[name] ?? null
}

function policyLabel(value: unknown): string | null {
  return typeof value === 'string' && value in FIREWALL_POLICY_LABELS
    ? FIREWALL_POLICY_LABELS[value as FirewallPolicy]
    : null
}

function rootLoginLabel(value: unknown): string | null {
  return typeof value === 'string' && value in SSH_ROOT_LOGIN_POLICY_LABELS
    ? SSH_ROOT_LOGIN_POLICY_LABELS[value as SshRootLoginPolicy]
    : null
}

/** 端口规则的参数摘要：`<protocol>/<port> <policy>`（两片规则、IP 规则与转发的共用形）。 */
function ruleSummary(body: Record<string, unknown> | null): string | null {
  const port = body?.['port']
  if (typeof port !== 'number' && typeof port !== 'string') return null
  const protocol = body?.['protocol'] === 'udp' ? 'udp' : 'tcp'
  const label = policyLabel(body?.['policy'])
  return label === null ? null : `${protocol}/${String(port)} ${label}`
}

/** 端口转发的参数摘要：`<port> → <targetHost>:<targetPort>`。 */
function forwardSummary(body: Record<string, unknown> | null): string | null {
  const port = body?.['port']
  const host = body?.['targetHost']
  const targetPort = body?.['targetPort']
  if (typeof port !== 'number' && typeof port !== 'string') return null
  if (typeof host !== 'string') return null
  if (typeof targetPort !== 'number' && typeof targetPort !== 'string') return null
  return `${String(port)} → ${host}:${String(targetPort)}`
}

/** IP 规则的参数摘要：`来源 <source> <policy>`。 */
function ipRuleSummary(body: Record<string, unknown> | null): string | null {
  const source = text(body, 'source')
  const label = policyLabel(body?.['policy'])
  if (source === null || label === null) return null
  return `来源 ${source} ${label}`
}

/** 依赖安装步骤的对象名：只认固定步骤，其余不进日志对象。 */
function setupStepTarget(name: string, step: string | undefined): string | null {
  if (step === 'install') return `${name} 安装`
  if (step === 'configure') return `${name} 配置管理通道`
  if (step === 'enable') return `${name} 启动并常驻`
  return null
}

/**
 * 端点描述符表。键 = `${METHOD} ${含挂载前缀的全路径}`，与方法名、路由模板**逐字相同**
 * ——采集中间件用 hono/route 的 matchedRoutes(c) 取到的就是这两个值，键写错等于没登记。
 * 路径段用各片的挂载常量拼接，避免「改挂载前缀忘了改这张表」。
 */
export const OPERATION_DESCRIPTORS: Readonly<Record<string, OperationDescriptor>> = {
  // 安全区：SSH
  [`PUT ${SSH_MOUNT}/service-enabled`]: {
    category: 'security',
    action: '启停 SSH 服务',
    target: 'sshd',
    summarize: ({ body }) => (body?.['enabled'] === true ? '已启动' : '已停止'),
  },
  [`PUT ${SSH_MOUNT}/auth-methods`]: {
    category: 'security',
    action: '修改 SSH 登录方式',
    target: 'sshd',
    summarize: ({ body }) =>
      `密码登录 ${onOff(body?.['passwordAuthEnabled'])}，密钥登录 ${onOff(body?.['keyAuthEnabled'])}`,
  },
  [`PUT ${SSH_MOUNT}/port`]: {
    category: 'security',
    action: '修改 SSH 监听端口',
    target: 'sshd',
    summarize: ({ body }) => {
      const port = body?.['port']
      return typeof port === 'number' || typeof port === 'string' ? `端口 ${String(port)}` : null
    },
  },
  [`PUT ${SSH_MOUNT}/root-login-policy`]: {
    category: 'security',
    action: '修改 Root 登录策略',
    target: 'sshd',
    summarize: ({ body }) => rootLoginLabel(body?.['policy']),
  },
  // 体是明文密码：**不声明 summarize**，请求体因此永不被读取。
  [`POST ${SSH_MOUNT}/root-password`]: {
    category: 'security',
    action: '重置 Root 密码',
    target: 'root',
  },
  [`POST ${SSH_MOUNT}/root-key`]: {
    category: 'security',
    action: '生成 Root 密钥',
    target: 'root',
  },
  [`POST ${SSH_MOUNT}/keys`]: {
    category: 'security',
    action: '创建登录密钥',
    // 账号只在请求体里（路径无参数）；本端点同时声明了 summarize，因此体是可读的。
    target: ({ body }) => {
      const userId = text(body, 'userId')
      return userId === null ? null : `账号 ${userId}`
    },
    summarize: ({ body }) => {
      const name = text(body, 'name')
      return name === null ? null : `名称 ${name}`
    },
  },
  [`DELETE ${SSH_MOUNT}/keys/:id`]: {
    category: 'security',
    action: '删除登录密钥',
    target: ({ params }) => param(params, 'id'),
  },

  // 安全区：防火墙
  [`PUT ${FIREWALL_MOUNT}/toggles`]: {
    category: 'security',
    action: '修改防火墙开关',
    summarize: ({ body }) =>
      `防火墙 ${onOff(body?.['firewallEnabled'])}，禁 Ping ${onOff(body?.['pingBlocked'])}`,
  },
  [`POST ${FIREWALL_MOUNT}/rules`]: {
    category: 'security',
    action: '新增端口规则',
    summarize: ({ body }) => ruleSummary(body),
  },
  [`PUT ${FIREWALL_MOUNT}/rules/:id`]: {
    category: 'security',
    action: '修改端口规则',
    target: ({ params }) => param(params, 'id'),
    summarize: ({ body }) => ruleSummary(body),
  },
  [`DELETE ${FIREWALL_MOUNT}/rules/:id`]: {
    category: 'security',
    action: '删除端口规则',
    target: ({ params }) => param(params, 'id'),
  },
  [`POST ${FIREWALL_MOUNT}/rules/import`]: {
    category: 'security',
    action: '导入端口规则',
    summarize: ({ body }) => {
      const rules = body?.['rules']
      return Array.isArray(rules) ? `共 ${rules.length} 条` : null
    },
  },
  [`POST ${FIREWALL_MOUNT}/sync`]: {
    category: 'security',
    action: '从系统同步防火墙规则',
  },
  [`POST ${FIREWALL_MOUNT}/ip-rules`]: {
    category: 'security',
    action: '新增 IP 规则',
    summarize: ({ body }) => ipRuleSummary(body),
  },
  [`PUT ${FIREWALL_MOUNT}/ip-rules/:id`]: {
    category: 'security',
    action: '修改 IP 规则',
    target: ({ params }) => param(params, 'id'),
    summarize: ({ body }) => ipRuleSummary(body),
  },
  [`DELETE ${FIREWALL_MOUNT}/ip-rules/:id`]: {
    category: 'security',
    action: '删除 IP 规则',
    target: ({ params }) => param(params, 'id'),
  },
  [`POST ${FIREWALL_MOUNT}/forwards`]: {
    category: 'security',
    action: '新增端口转发',
    summarize: ({ body }) => forwardSummary(body),
  },
  [`PUT ${FIREWALL_MOUNT}/forwards/:id`]: {
    category: 'security',
    action: '修改端口转发',
    target: ({ params }) => param(params, 'id'),
    summarize: ({ body }) => forwardSummary(body),
  },
  [`DELETE ${FIREWALL_MOUNT}/forwards/:id`]: {
    category: 'security',
    action: '删除端口转发',
    target: ({ params }) => param(params, 'id'),
  },
  [`POST ${FIREWALL_MOUNT}/scan/toggle`]: {
    category: 'security',
    action: '启停防扫描',
    summarize: ({ body }) => (body?.['enabled'] === true ? '已开启' : '已关闭'),
  },
  [`PUT ${FIREWALL_MOUNT}/scan/config`]: {
    category: 'security',
    action: '修改防扫描配置',
    summarize: ({ body }) => {
      const window = body?.['windowSeconds']
      const hits = body?.['hitCount']
      const ban = body?.['banSeconds']
      if (typeof window !== 'number' || typeof hits !== 'number' || typeof ban !== 'number') return null
      return `窗口 ${window}s，命中 ${hits} 次，封禁 ${ban}s`
    },
  },
  [`POST ${FIREWALL_MOUNT}/scan/unblock`]: {
    category: 'security',
    action: '解除 IP 封禁',
    summarize: ({ body }) => {
      const ip = text(body, 'ip')
      return ip === null ? null : `IP ${ip}`
    },
  },

  // 安全区：系统账号（两个含密码的端点不声明 summarize，见文件头）
  [`POST ${USERS_MOUNT}`]: {
    category: 'security',
    action: '创建系统账号',
  },
  [`PUT ${USERS_MOUNT}/:id`]: {
    category: 'security',
    action: '修改系统账号',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `账号 ${id}`
    },
  },
  [`DELETE ${USERS_MOUNT}/:id`]: {
    category: 'security',
    action: '删除系统账号',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `账号 ${id}`
    },
  },
  [`POST ${USERS_MOUNT}/sync`]: {
    category: 'security',
    action: '从系统同步账号清单',
  },

  // 文件管理
  [`POST ${FILES_MOUNT}/copy`]: {
    category: 'files',
    action: '复制文件',
    summarize: ({ body }) => {
      const src = text(body, 'srcPath')
      const dest = text(body, 'destDirPath')
      return src === null || dest === null ? null : `${src} → ${dest}`
    },
  },
  [`POST ${FILES_MOUNT}/move`]: {
    category: 'files',
    action: '移动文件',
    summarize: ({ body }) => {
      const src = text(body, 'srcPath')
      const dest = text(body, 'destDirPath')
      return src === null || dest === null ? null : `${src} → ${dest}`
    },
  },
  [`POST ${FILES_MOUNT}/rename`]: {
    category: 'files',
    action: '重命名',
    summarize: ({ body }) => {
      const path = text(body, 'path')
      const newName = text(body, 'newName')
      return path === null || newName === null ? null : `${path} → ${newName}`
    },
  },
  [`POST ${FILES_MOUNT}/compress`]: {
    category: 'files',
    action: '压缩文件',
    summarize: ({ body }) => text(body, 'path'),
  },
  [`POST ${FILES_MOUNT}/chmod`]: {
    category: 'files',
    action: '修改权限',
    summarize: ({ body }) => {
      const path = text(body, 'path')
      const mode = text(body, 'mode')
      const owner = text(body, 'owner')
      if (path === null || mode === null || owner === null) return null
      return `${path} ${mode} ${owner}${body?.['recursive'] === true ? '（递归）' : ''}`
    },
  },

  // 容器管理（GET /containers/:id/terminal 为 WebSocket 升级，不经写端点采集；
  // 打开会话在 dockerRoutes 升级前显式 recordPanelOperation，与终端片 /ws 同构）
  [`POST ${DOCKER_MOUNT}/containers`]: {
    category: 'containers',
    action: '创建容器',
    target: ({ body }) => {
      const name = text(body, 'name')
      return name === null ? '新容器' : name
    },
    summarize: ({ body }) => {
      const imageId = text(body, 'imageId')
      return imageId === null ? null : `镜像 ${imageId}`
    },
  },
  [`POST ${DOCKER_MOUNT}/containers/:id/start`]: {
    category: 'containers',
    action: '启动容器',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `容器 ${id}`
    },
  },
  [`POST ${DOCKER_MOUNT}/containers/:id/stop`]: {
    category: 'containers',
    action: '停止容器',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `容器 ${id}`
    },
  },
  [`POST ${DOCKER_MOUNT}/containers/:id/restart`]: {
    category: 'containers',
    action: '重启容器',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `容器 ${id}`
    },
  },
  [`DELETE ${DOCKER_MOUNT}/containers/:id`]: {
    category: 'containers',
    action: '删除容器',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `容器 ${id}`
    },
  },
  [`POST ${DOCKER_MOUNT}/images/pull`]: {
    category: 'containers',
    action: '拉取镜像',
    summarize: ({ body }) => {
      const name = text(body, 'name')
      const tag = text(body, 'tag')
      return name === null || tag === null ? null : `${name}:${tag}`
    },
  },
  [`POST ${DOCKER_MOUNT}/images/pull/stream`]: {
    category: 'containers',
    action: '发起镜像拉取',
    summarize: ({ body }) => {
      const name = text(body, 'name')
      const tag = text(body, 'tag')
      return name === null || tag === null ? null : `${name}:${tag}`
    },
  },
  [`DELETE ${DOCKER_MOUNT}/images/:id`]: {
    category: 'containers',
    action: '删除镜像',
    target: ({ params }) => {
      const id = param(params, 'id')
      return id === null ? null : `镜像 ${id}`
    },
  },

  [`POST ${DATABASE_MOUNT}`]: {
    category: 'database',
    action: '创建或接管数据库',
    target: ({ body }) => text(body, 'name'),
    summarize: ({ body }) => {
      const engine = text(body, 'engine')
      const version = text(body, 'versionTag')
      return engine && version ? `${engine}:${version}` : null
    },
  },
  [`POST ${DATABASE_MOUNT}/:id/reveal`]: {
    category: 'database', action: '读取普通账号凭证',
    target: ({ params }) => param(params, 'id'),
  },
  [`DELETE ${DATABASE_MOUNT}/:id`]: {
    category: 'database', action: '删除逻辑库或清空 Redis DB 0',
    target: ({ params }) => param(params, 'id'),
  },
  [`DELETE ${DATABASE_MOUNT}/:id/container`]: {
    category: 'database', action: '删除数据库容器及专属卷',
    target: ({ params }) => param(params, 'id'),
  },
  [`POST ${DATABASE_MOUNT}/:id/reconcile`]: {
    category: 'database', action: '重新核对数据库', target: ({ params }) => param(params, 'id'),
  },
  [`DELETE ${DATABASE_MOUNT}/:id/registration`]: {
    category: 'database', action: '移除待处理接管登记', target: ({ params }) => param(params, 'id'),
  },
  [`POST ${DATABASE_MOUNT}/sqlite`]: {
    category: 'database', action: '新建 SQLite 文件', target: ({ body }) => text(body, 'name'),
    summarize: () => null,
  },
  [`POST ${DATABASE_MOUNT}/sqlite/import`]: {
    category: 'database', action: '导入 SQLite 文件',
  },
  [`DELETE ${DATABASE_MOUNT}/sqlite/:id`]: {
    category: 'database', action: '删除 SQLite 文件', target: ({ params }) => param(params, 'id'),
  },
  [`POST ${DATABASE_MOUNT}/sqlite/:id/reconcile`]: {
    category: 'database', action: '重新核对 SQLite 文件', target: ({ params }) => param(params, 'id'),
  },
  [`DELETE ${DATABASE_MOUNT}/sqlite/:id/registration`]: {
    category: 'database', action: '清理待处理 SQLite 文件', target: ({ params }) => param(params, 'id'),
  },

  // 网站创建和访问配置会携带私钥；不声明 summarize/体 target，审计采集器便不会读取请求体。
  [`POST ${WEBSITES_MOUNT}`]: {
    category: 'websites',
    action: '创建网站项目',
  },
  [`PUT ${WEBSITES_MOUNT}/:id`]: {
    category: 'websites', action: '修改网站项目设置',
    target: ({ params }) => param(params, 'id'),
  },
  [`PUT ${WEBSITES_MOUNT}/:id/access`]: {
    category: 'websites', action: '调整网站访问配置',
    target: ({ params }) => param(params, 'id'),
  },
  [`POST ${WEBSITES_MOUNT}/:id/running`]: {
    category: 'websites', action: '启停网站项目',
    target: ({ params }) => param(params, 'id'),
    summarize: ({ body }) => (body?.['running'] === true ? '已启动' : '已停止'),
  },
  [`POST ${WEBSITES_MOUNT}/proxy/reconcile`]: {
    category: 'websites', action: '重新下发反向代理配置',
  },
  [`DELETE ${WEBSITES_MOUNT}/:id`]: {
    category: 'websites', action: '删除网站项目',
    target: ({ params }) => param(params, 'id'),
  },

  // 日志管理：清空是写端点，因此清空动作本身也留痕（「想抹掉痕迹」只会留下「抹掉痕迹」这条痕迹）。
  [`POST ${LOGS_MOUNT}/runtime/clear`]: {
    category: 'logs',
    action: '清空运行日志',
  },
  [`POST ${LOGS_MOUNT}/operation/clear`]: {
    category: 'logs',
    action: '清空操作日志',
  },

  // 宿主依赖安装：一步一个写请求。目标只取路径里的步骤名，不读请求体。
  [`POST ${PLATFORM_MOUNT}/dependencies/setup/docker/:step`]: {
    category: 'containers',
    action: '安装 Docker',
    target: ({ params }) => setupStepTarget('Docker', params.step),
  },
  [`POST ${PLATFORM_MOUNT}/dependencies/setup/caddy/:step`]: {
    category: 'websites',
    action: '安装 Caddy',
    target: ({ params }) => setupStepTarget('Caddy', params.step),
  },

  // 登录鉴权：登录体含密码——**不声明 summarize**（采集中间件因此在 clone 之前就跳过
  // 请求体，密码结构性地不进任何日志）；不声明 target（单用户语义下用户名也无信息量，
  // 记录为 null）。登出在鉴权豁免清单内（幂等可达），操作审计照常包住：无会话的登出
  // 也记一条 success。
  [`POST ${AUTH_MOUNT}/login`]: { category: 'auth', action: '登录面板' },
  [`POST ${AUTH_MOUNT}/logout`]: { category: 'auth', action: '退出登录' },
  // 设置页端点：改密体含三个密码字段——**不声明 summarize**（与 login 同纪律，请求体
  // 结构性地不进日志）；退出其他会话无请求体，同样无可摘要。
  [`POST ${AUTH_MOUNT}/password`]: { category: 'auth', action: '修改面板密码' },
  [`POST ${AUTH_MOUNT}/sessions/logout-others`]: { category: 'auth', action: '退出其他会话' },
}

/**
 * 从路由模板与具体路径还原路径参数（纯函数）：
 * `('/api/security/ssh/keys/:id', '/api/security/ssh/keys/k-2')` → `{ id: 'k-2' }`。
 *
 * 只按段对齐取 `:name` 段：模板里没有参数、或具体路径的段数与模板不符（尾斜杠、
 * 通配路由）时给不出值，返回的对象里就没有那个键——调用方按「取不到 → null」处理，
 * 不在这里编造。c.req.path 是百分号解码过的，因此这里的取值已经是解码后的字面量。
 */
export function extractPathParams(routeTemplate: string, concretePath: string): Record<string, string> {
  const template = splitPathSegments(routeTemplate)
  const concrete = splitPathSegments(concretePath)
  const params: Record<string, string> = {}
  for (const [index, segment] of template.entries()) {
    if (!segment.startsWith(':')) continue
    const value = concrete[index]
    if (value === undefined) continue
    params[segment.slice(1)] = value
  }
  return params
}

/** 路径切段：忽略首尾斜杠带来的空段（`/a/b/` 与 `/a/b` 同形）。 */
function splitPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

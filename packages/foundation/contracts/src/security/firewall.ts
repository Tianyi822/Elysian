/*
 * 防火墙域类型与词典。按承载操作系统呈现规则：演示态存内存；
 * Docker 运行时由服务端真实执行 ufw（Ubuntu 官方防火墙工具）实现同一契约。
 * 同一端口按地址族分 v4/v6 两行登记，与主机防火墙的真实呈现一致。
 * 规则分三类：端口规则（协议+端口）、IP 规则（纯来源封禁，无端口）、端口转发（DNAT）。
 */

/**
 * 面板对外端口：工作台自身的访问通道，防火墙规则配置的禁区（转发 DNAT、防扫描
 * 监控都必须拒绝它），启用防火墙时自动补的保底放行规则也是它。此值是唯一权威：
 * apps/web/vite.config.ts 的 server.port 与 docker-compose.yml 的端口发布必须同值。
 */
export const PANEL_PORT = 48100

export type FirewallProtocol = 'tcp' | 'udp'

export const FIREWALL_PROTOCOLS = [
  'tcp',
  'udp',
] as const satisfies readonly FirewallProtocol[]

export type FirewallRuleStatus = 'normal' | 'unused'

export const FIREWALL_RULE_STATUSES = [
  'normal',
  'unused',
] as const satisfies readonly FirewallRuleStatus[]

export const FIREWALL_RULE_STATUS_LABELS: Record<FirewallRuleStatus, string> = {
  normal: '正常',
  unused: '未使用',
}

/** limit 是 ufw 的限连动作：放行但限制新建速率，界面呈现为独立的「限连」策略。 */
export type FirewallPolicy = 'allow' | 'deny' | 'limit'

export const FIREWALL_POLICIES = [
  'allow',
  'deny',
  'limit',
] as const satisfies readonly FirewallPolicy[]

export const FIREWALL_POLICY_LABELS: Record<FirewallPolicy, string> = {
  allow: '放行',
  deny: '拒绝',
  limit: '限连',
}

export type FirewallDirection = 'inbound' | 'outbound'

export const FIREWALL_DIRECTIONS = [
  'inbound',
  'outbound',
] as const satisfies readonly FirewallDirection[]

export const FIREWALL_DIRECTION_LABELS: Record<FirewallDirection, string> = {
  inbound: '入站',
  outbound: '出站',
}

export type FirewallAddressFamily = 'ipv4' | 'ipv6'

export const FIREWALL_ADDRESS_FAMILIES = [
  'ipv4',
  'ipv6',
] as const satisfies readonly FirewallAddressFamily[]

export type FirewallRule = {
  id: string
  protocol: FirewallProtocol
  /** 端口段的起始端口；单端口规则 portTo 为 null。 */
  port: number
  /** 端口段的结束端口；单端口规则为 null。 */
  portTo: number | null
  family: FirewallAddressFamily
  status: FirewallRuleStatus
  policy: FirewallPolicy
  direction: FirewallDirection
  /** 规则来源，如「所有IP」。 */
  source: string
  /** 备注为空时界面显示 —。 */
  note: string | null
  /** 最近一次变更时间（ISO）；持久化账本里有记录则带出，否则界面显示 —。 */
  updatedAt: string | null
}

/** IP 规则：不指定端口、只按来源地址放行或封禁（`ufw allow from` / `ufw deny from`）。 */
export type FirewallIpRule = {
  id: string
  /** 来源地址或网段，如 203.0.113.9、10.0.0.0/8、fd00::/8。 */
  source: string
  family: FirewallAddressFamily
  policy: FirewallPolicy
  /** 备注为空时界面显示 —。 */
  note: string | null
  updatedAt: string | null
}

export type FirewallIpRuleInput = {
  policy: FirewallPolicy
  source: string
  note: string | null
}

/** 端口转发：外部端口的入站连接 DNAT 到内部地址（ufw before.rules 的 *nat PREROUTING 段）。 */
export type FirewallForwardRule = {
  id: string
  protocol: FirewallProtocol
  /** 外部端口段的起始端口；单端口为 null 结尾。 */
  port: number
  portTo: number | null
  /** 转发目标地址（IPv4）。 */
  targetHost: string
  targetPort: number
  note: string | null
  updatedAt: string | null
}

export type FirewallForwardInput = {
  protocol: FirewallProtocol
  port: number
  portTo?: number
  targetHost: string
  targetPort: number
  note: string | null
}

/** 防火墙级开关与默认策略。真实态总开关来自 ufw status、禁 ping 来自 before.rules 的 echo-request 行、默认策略来自 ufw status verbose。 */
export type FirewallToggles = {
  firewallEnabled: boolean
  pingBlocked: boolean
  /** 入站默认策略（ufw Default incoming）；ufw 未激活时不打印 Default 行，取值为 null。 */
  defaultIncoming: FirewallPolicy | null
  /** 出站默认策略（ufw Default outgoing）；ufw 未激活时不打印 Default 行，取值为 null。 */
  defaultOutgoing: FirewallPolicy | null
}

/** 新建或修改端口规则的输入。状态不由表单决定：真实态按监听套接字派生，演示态新建即未使用；
 * 方向缺省为入站；portTo 存在时表示端口段（port 为起始端口）。 */
export type FirewallRuleInput = {
  protocol: FirewallProtocol
  port: number
  /** 端口段结束端口；缺省表示单端口。 */
  portTo?: number
  family: FirewallAddressFamily
  policy: FirewallPolicy
  direction?: FirewallDirection
  source: string
  note: string | null
}

/** 端口的显示文案：端口段以 ufw 的冒号形式呈现，v6 行在端口后带地址族标注。 */
export function formatFirewallPort(rule: Pick<FirewallRule, 'port' | 'portTo' | 'family'>): string {
  const range = rule.portTo === null ? `${rule.port}` : `${rule.port}:${rule.portTo}`
  return rule.family === 'ipv6' ? `${range} (ipv6)` : `${range}`
}

/*
 * 端口自动开放：网站直连项目与任意主机访问的数据库把宿主端口发布到 0.0.0.0，
 * 创建（及网站切换为直连）时面板在防火墙页管理的同一份 ufw 里幂等补一条
 * 入站 TCP 放行规则。结果随创建响应带回前端，拼进完成通知。
 */
export type FirewallPortSync = {
  /** opened=本次新写入并已复核；skipped=已有等价放行规则或防火墙片不可用，无需动作；failed=写入未生效，需要用户到安全页处理。 */
  state: 'opened' | 'skipped' | 'failed'
  port: number
  /** skipped/failed 时的中文说明；opened 为 null。 */
  detail: string | null
}

/*
 * 端口防扫描：真实实现基于内核 xt_recent 的双名单 jail——监控端口的 TCP 新连接按源 IP
 * 记入跟踪名单，判定窗口内超过阈值即把该 IP 记入封锁名单并在封禁期内直接丢弃；
 * 封锁名单读 /proc/net/xt_recent，解封写回该文件；统计读 iptables 规则包计数。
 * 配置（监控端口、窗口、阈值、封禁时长）持久化在规则文本里，随 ufw reload 生效。
 */

/** 防扫描配置。 */
export type FirewallScanConfig = {
  /** 监控的 TCP 新连接端口列表。 */
  ports: readonly number[]
  /** 判定窗口（秒）：窗口内新连接达到阈值即封锁。 */
  windowSeconds: number
  /** 判定阈值（次）。 */
  hitCount: number
  /** 封禁时长（秒）：封锁名单内条目的存活期。 */
  banSeconds: number
}

/** 防扫描默认配置：扫描高发端口、60 秒窗口 8 次阈值、1 小时封禁。 */
export const DEFAULT_SCAN_CONFIG: FirewallScanConfig = {
  ports: [22, 23, 3306, 3389, 5900, 6379],
  windowSeconds: 60,
  hitCount: 8,
  banSeconds: 3600,
}

export type FirewallScanStats = {
  /** 历史封锁过的 IP 总数。 */
  totalBlockedIps: number
  /** 历史连接失败总数。 */
  totalFailedConnections: number
  /** 当前处于封锁中的 IP 数。 */
  currentBlockedIps: number
  /** 当前统计窗口内的连接失败次数。 */
  currentFailedConnections: number
}

export type FirewallBlockedIp = {
  ip: string
  blockedAt: string
}

export type FirewallScanProtection = {
  enabled: boolean
  /** 当前生效的配置；演示态返回默认配置。 */
  config: FirewallScanConfig
  stats: FirewallScanStats
  blocked: readonly FirewallBlockedIp[]
}

/** 批量导入的結果：新增的规则（含生成的 id 与状态）与因重复被跳过的数量。 */
export type FirewallImportResult = {
  added: readonly FirewallRule[]
  skipped: number
}

/**
 * 防火墙区适配接口。演示态由 mock 实现；Docker 运行时由 HTTP adapter 接通容器内 ufw，
 * server 侧服务层与 web 侧 adapter 共用这一接口定义，页面不改。
 */
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

/*
 * 防火墙域类型与词典。本期只做端口规则的演示呈现：
 * 真实防火墙动作（启停、放行/拒绝）属于系统级变更，由未来接入的执行层筛选与执行，
 * 这里的类型只描述界面需要呈现的事实。
 * 同一端口按地址族分 v4/v6 两行登记，与主机防火墙的真实呈现一致。
 */

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

export type FirewallPolicy = 'allow' | 'deny'

export const FIREWALL_POLICIES = [
  'allow',
  'deny',
] as const satisfies readonly FirewallPolicy[]

export const FIREWALL_POLICY_LABELS: Record<FirewallPolicy, string> = {
  allow: '放行',
  deny: '拒绝',
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
  port: number
  family: FirewallAddressFamily
  status: FirewallRuleStatus
  policy: FirewallPolicy
  direction: FirewallDirection
  /** 规则来源，如「所有IP」。 */
  source: string
  /** 备注为空时界面显示 —。 */
  note: string | null
  /** 最近一次变更时间（ISO）；本会话内没有变更过的规则缺省，界面显示 —。 */
  updatedAt: string | null
}

/** 防火墙级开关：总开关与禁 ping。演示态存内存，不触碰任何真实防火墙。 */
export type FirewallToggles = {
  firewallEnabled: boolean
  pingBlocked: boolean
}

/** 新建或修改端口规则的输入。状态不由表单决定：新建即未使用，由演示引擎按需演进；
 * 方向缺省为入站，批量导入可以带出站方向。 */
export type FirewallRuleInput = {
  protocol: FirewallProtocol
  port: number
  family: FirewallAddressFamily
  policy: FirewallPolicy
  direction?: FirewallDirection
  source: string
  note: string | null
}

/** 端口的显示文案：v6 行在端口后带地址族标注。 */
export function formatFirewallPort(rule: Pick<FirewallRule, 'port' | 'family'>): string {
  return rule.family === 'ipv6' ? `${rule.port} (ipv6)` : `${rule.port}`
}

/*
 * 端口防扫描：演示数据呈现主机防扫描模块的事实——历史累计值很大（历史上拦过很多），
 * 当前封锁为空（重启后清空），列表展示当前被封的 IP，每行可解封。
 */
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
  stats: FirewallScanStats
  blocked: readonly FirewallBlockedIp[]
}

/** 批量导入的結果：新增的规则（含生成的 id 与状态）与因重复被跳过的数量。 */
export type FirewallImportResult = {
  added: readonly FirewallRule[]
  skipped: number
}

import type {
  FirewallAddressFamily,
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallPolicy,
  FirewallProtocol,
  FirewallRule,
  FirewallRuleInput,
} from '@elysian/contracts'
import { FIREWALL_PROTOCOLS } from '@elysian/contracts'
import { assertNoteSafe } from './noteValidation'

/*
 * ufw 命令输出与规则规范形态的纯解析。形状全部取自容器内 ufw 0.36.2 的真实输出：
 *
 *   ufw allow 22/tcp
 *   ufw allow 22/tcp comment '测试备注 note'
 *   ufw allow out 25/udp
 *   ufw deny 23/tcp
 *   ufw limit 2222/tcp
 *   ufw allow from 192.168.1.0/24 to any port 2049 proto tcp
 *   ufw deny from 203.0.113.9
 *
 * 规则分两类：端口规则（协议+端口）与 IP 规则（纯来源、无端口）。
 * 规则的唯一身份是规范指纹（动作/方向/协议/端口/来源），界面行的 id 再叠加地址族后缀；
 * 删除按指纹还原 ufw 参数，因此从 ufw 读回的任何规则都能被精确增删——
 * 包括运维在命令行手敲的规则，面板对它们同样可见、可删。
 */

export type UfwAction = 'allow' | 'deny' | 'limit' | 'reject'

export type UfwRuleSpec = {
  action: UfwAction
  direction: 'in' | 'out'
  /** 端口或端口段（'1000:2000'）。 */
  port: string
  proto: FirewallProtocol
  /** 'any' 或地址/网段。 */
  from: string
}

/** IP 规则规范：只有来源，没有端口（`ufw deny from 203.0.113.9`）。出站方向按来源过滤无意义，只解析入站。 */
export type UfwIpSpec = {
  action: UfwAction
  direction: 'in'
  from: string
}

export type ParsedUfwLine =
  | { kind: 'port'; spec: UfwRuleSpec; comment: string | null }
  | { kind: 'ip'; spec: UfwIpSpec; comment: string | null }

export type PortUfwLine = Extract<ParsedUfwLine, { kind: 'port' }>
export type IpUfwLine = Extract<ParsedUfwLine, { kind: 'ip' }>

/** 界面行的 id：规范指纹 + 地址族后缀。 */
export function ruleIdOf(spec: UfwRuleSpec, family: FirewallAddressFamily): string {
  return `${canonicalId(spec)}.${family}`
}

export function canonicalId(spec: UfwRuleSpec): string {
  const from = encodeURIComponent(spec.from)
  return `ufw-${spec.action}-${spec.direction}-${spec.proto}-${spec.port}-${from}`
}

export function ipCanonicalId(spec: UfwIpSpec): string {
  return `ufwip-${spec.action}-from-${encodeURIComponent(spec.from)}`
}

export function ipRuleIdOf(spec: UfwIpSpec): string {
  return `${ipCanonicalId(spec)}.${familyOfAddress(spec.from)}`
}

/** 从界面行 id 取回端口规则规范指纹与地址族；不认识的 id 返回 null。 */
export function parseRuleId(ruleId: string): { spec: UfwRuleSpec; family: FirewallAddressFamily } | null {
  const match = /^(ufw-[a-z]+-(?:in|out)-(?:tcp|udp)-.+)\.(ipv4|ipv6)$/.exec(ruleId)
  if (!match) return null
  const spec = specFromCanonical(match[1] ?? '')
  if (!spec) return null
  return { spec, family: match[2] as FirewallAddressFamily }
}

/** 从界面行 id 取回 IP 规则规范与地址族；不认识的 id 返回 null。 */
export function parseIpRuleId(ruleId: string): { spec: UfwIpSpec; family: FirewallAddressFamily } | null {
  const match = /^(ufwip-[a-z]+-from-.+)\.(ipv4|ipv6)$/.exec(ruleId)
  if (!match) return null
  const parts = (match[1] ?? '').split('-')
  const action = parts[1]
  // 前缀是 ufwip-<action>-from- 三段，其余整段是来源（IPv4 含点号，IPv6 含冒号）。
  const from = decodeURIComponent(parts.slice(3).join('-'))
  if (!isUfwAction(action) || !from) return null
  return { spec: { action, direction: 'in', from }, family: match[2] as FirewallAddressFamily }
}

function specFromCanonical(canonical: string): UfwRuleSpec | null {
  const parts = canonical.split('-')
  if (parts.length < 6) return null
  const action = parts[1]
  const direction = parts[2]
  const proto = parts[3]
  const port = parts[4]
  const from = decodeURIComponent(parts.slice(5).join('-'))
  if (
    !isUfwAction(action) ||
    (direction !== 'in' && direction !== 'out') ||
    !isFirewallProtocol(proto) ||
    !/^\d{1,5}(?::\d{1,5})?$/.test(port ?? '')
  ) {
    return null
  }
  return { action, direction, proto, port: port ?? '', from }
}

function isUfwAction(value: string | undefined): value is UfwAction {
  return value === 'allow' || value === 'deny' || value === 'limit' || value === 'reject'
}

function isFirewallProtocol(value: string | undefined): value is FirewallProtocol {
  return (FIREWALL_PROTOCOLS as readonly string[]).includes(value ?? '')
}

/** 地址族按地址形态判定：含冒号视为 v6。 */
export function familyOfAddress(address: string): FirewallAddressFamily {
  return address.includes(':') ? 'ipv6' : 'ipv4'
}

/**
 * 解析 `ufw show added` 输出。端口规则与 IP 规则都返回；
 * 读不懂的行（目的地址非 any 的规则、出站来源规则等）不返回——它们没有界面对应物。
 */
export function parseShowAdded(stdout: string): readonly ParsedUfwLine[] {
  const parsed: ParsedUfwLine[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('ufw ') || line === '(None)') continue
    const rule = parseShowAddedLine(line)
    if (rule) parsed.push(rule)
  }
  return parsed
}

export function parseShowAddedLine(line: string): ParsedUfwLine | null {
  const withComment = /^ufw\s+(.*)\s+comment\s+'(.*)'$/.exec(line)
  const body = withComment?.[1] ?? line.slice(4)
  const comment = withComment?.[2] ?? null

  const tokens = (body ?? '').split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  let index = 0
  const action = tokens[0]
  if (!isUfwAction(action)) return null
  index += 1

  let direction: 'in' | 'out' = 'in'
  if (tokens[index] === 'in' || tokens[index] === 'out') {
    direction = tokens[index] as 'in' | 'out'
    index += 1
  }

  const rest = tokens.slice(index)
  if (rest.length === 0) return null

  // 短形式：22/tcp 或 1000:2000/udp。
  const shortForm = /^(\d{1,5}(?::\d{1,5})?)\/(tcp|udp)$/.exec(rest[0] ?? '')
  if (shortForm && rest.length === 1) {
    return {
      kind: 'port',
      spec: { action, direction, port: shortForm[1] ?? '', proto: shortForm[2] as FirewallProtocol, from: 'any' },
      comment,
    }
  }

  // 完整形式：from <src> [to any] [port <p>] [proto <proto>]。
  if (rest[0] !== 'from') return null
  const from = rest[1]
  if (!from) return null

  // 出站方向的来源规则（out from）在 ufw 语义里按本地源过滤，界面对应物是出站端口规则，跳过。
  if (direction === 'out') return null

  let port: string | undefined
  let proto: string | undefined
  let hasTo = false
  for (let i = 2; i < rest.length; i += 2) {
    const key = rest[i]
    const value = rest[i + 1]
    if (key === 'to') {
      // 目的地址非 any 的规则无法用界面呈现与删除。
      if (!value || value !== 'any') return null
      hasTo = true
    } else if (key === 'port' && value) {
      port = value
    } else if (key === 'proto' && value) {
      proto = value
    } else {
      return null
    }
  }

  // 无端口即 IP 规则（`ufw deny from 203.0.113.9`）；to any 显式出现与否不影响语义。
  void hasTo
  if (!port) {
    return { kind: 'ip', spec: { action, direction: 'in', from }, comment }
  }
  if (!proto || !/^\d{1,5}(?::\d{1,5})?$/.test(port) || !isFirewallProtocol(proto)) {
    return null
  }
  return { kind: 'port', spec: { action, direction, port, proto, from }, comment }
}

/**
 * `ufw status verbose` → 激活状态与默认策略（`Default: deny (incoming), allow (outgoing)`）。
 * 只有 `Status:` 行是必需的：ufw 未激活时整个输出就只有 `Status: inactive` 一行，
 * 不打印 Logging/Default——此时默认策略是「未知」，不能替系统编一个策略出来。
 */
export function parseStatusVerbose(stdout: string): {
  active: boolean
  defaultIncoming: FirewallPolicy | null
  defaultOutgoing: FirewallPolicy | null
} {
  const statusMatch = /^Status:\s*(\S+)/m.exec(stdout)
  if (!statusMatch) throw new Error('ufw status 输出无效：缺少 Status 行')
  const defaultMatch = /^Default:\s*(\S+)\s+\(incoming\),\s*(\S+)\s+\(outgoing\)/m.exec(stdout)
  return {
    active: statusMatch[1] === 'active',
    defaultIncoming: defaultMatch ? policyOf(defaultMatch[1] as UfwAction) : null,
    defaultOutgoing: defaultMatch ? policyOf(defaultMatch[2] as UfwAction) : null,
  }
}

/** /etc/default/ufw → 是否启用 IPv6 双栈。 */
export function parseIpv6Enabled(defaultUfw: string): boolean {
  const match = /^IPV6=(yes|no)$/m.exec(defaultUfw)
  return match?.[1] !== 'no'
}

/** 规范指纹还原成 ufw 删除参数（comment 不参与规则身份）。 */
export function specToArgs(spec: UfwRuleSpec): readonly string[] {
  const args: string[] = [spec.action]
  if (spec.direction === 'out') args.push('out')
  if (spec.from === 'any') {
    args.push(`${spec.port}/${spec.proto}`)
  } else {
    args.push('from', spec.from, 'to', 'any', 'port', spec.port, 'proto', spec.proto)
  }
  return args
}

export function ipSpecToArgs(spec: UfwIpSpec): readonly string[] {
  return [spec.action, 'from', spec.from]
}

export const SOURCE_ALL_IPS = '所有IP'

/** 校验界面输入并映射为 ufw 规范；不合法抛中文错误，不进 shell。 */
export function specFromInput(input: FirewallRuleInput): UfwRuleSpec {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`端口无效：${input.port}（应为 1–65535 的整数）`)
  }
  if (input.portTo !== undefined) {
    if (!Number.isInteger(input.portTo) || input.portTo < 1 || input.portTo > 65535) {
      throw new Error(`端口段结束无效：${input.portTo}（应为 1–65535 的整数）`)
    }
    if (input.portTo < input.port) {
      throw new Error(`端口段无效：结束端口 ${input.portTo} 小于起始端口 ${input.port}`)
    }
  }
  if (!isFirewallProtocol(input.protocol)) {
    throw new Error(`协议无效：${String(input.protocol)}`)
  }
  if (!['allow', 'deny', 'limit'].includes(input.policy)) {
    throw new Error(`策略无效：${String(input.policy)}`)
  }
  const source = input.source.trim()
  if (source !== SOURCE_ALL_IPS && !isValidFirewallAddress(source)) {
    throw new Error(`来源无效：${source}（应为「${SOURCE_ALL_IPS}」或合法 IP/网段）`)
  }
  // 备注以单引号包进 ufw comment 参数：换行/回车/控制字符与单引号都会写坏规则
  assertNoteSafe(input.note, 'ufw')
  return {
    action: input.policy,
    direction: input.direction === 'outbound' ? 'out' : 'in',
    port: input.portTo !== undefined ? `${input.port}:${input.portTo}` : String(input.port),
    proto: input.protocol,
    from: source === SOURCE_ALL_IPS ? 'any' : source,
  }
}

/** IP 规则输入校验：来源必须是具体地址或网段，不允许「所有IP」（那是拒绝/放行全量流量，语义由默认策略承担）。 */
export function ipSpecFromInput(input: FirewallIpRuleInput): UfwIpSpec {
  if (!['allow', 'deny', 'limit'].includes(input.policy)) {
    throw new Error(`策略无效：${String(input.policy)}`)
  }
  const source = input.source.trim()
  if (!isValidFirewallAddress(source) || source === 'any') {
    throw new Error(`来源无效：${source}（应为合法 IP 或网段）`)
  }
  // 备注同样写进 ufw comment 参数，与端口规则共用一套备注校验
  assertNoteSafe(input.note, 'ufw')
  return { action: input.policy, direction: 'in', from: source }
}

/** 接受 IPv4/IPv6 地址或 CIDR 网段。 */
export function isValidFirewallAddress(value: string): boolean {
  if (value.includes(':')) {
    return /^[0-9a-fA-F:]+(?:\/\d{1,3})?$/.test(value)
  }
  const cidr = /^([\d.]+)(?:\/(\d{1,2}))?$/.exec(value)
  if (!cidr) return false
  const octets = (cidr[1] ?? '').split('.')
  if (octets.length !== 4) return false
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false
  if (cidr[2] !== undefined && Number(cidr[2]) > 32) return false
  return true
}

export type RuleRowContext = {
  /** /etc/default/ufw 的 IPV6 取值决定 any 规则是否派生双行。 */
  ipv6Enabled: boolean
  /** ss 解析出的监听键集合（`tcp:22`）。 */
  listeners: ReadonlySet<string>
  /** 规则最近变更时间（规范指纹 → ISO 时间）。 */
  updatedAtMap: ReadonlyMap<string, string>
}

/** 一条 ufw 规范展开成界面行；来源为 any 且启用 IPv6 时派生 v4/v6 两行。 */
export function ruleRowsFromSpec(spec: UfwRuleSpec, comment: string | null, context: RuleRowContext): readonly FirewallRule[] {
  const families = rowFamiliesOf(spec, context.ipv6Enabled)
  const start = displayPortOf(spec)
  const end = portToOf(spec)
  const key = `${spec.proto}:${start}`
  const status = context.listeners.has(key) ? 'normal' : 'unused'
  const updatedAt = context.updatedAtMap.get(canonicalId(spec)) ?? null
  const rangeNote = end !== null ? `端口段 ${spec.port}` : null
  const note = rangeNote
    ? comment
      ? `${rangeNote}；${comment}`
      : rangeNote
    : comment

  return families.map((family) => ({
    id: ruleIdOf(spec, family),
    protocol: spec.proto,
    port: start,
    portTo: end,
    family,
    status,
    policy: policyOf(spec.action),
    direction: spec.direction === 'out' ? 'outbound' : 'inbound',
    source: spec.from === 'any' ? SOURCE_ALL_IPS : spec.from,
    note,
    updatedAt,
  }))
}

/** IP 规则规范展开成界面行：地址族由来源地址形态决定，单行。 */
export function ipRuleRowFromSpec(spec: UfwIpSpec, comment: string | null, context: RuleRowContext): FirewallIpRule {
  return {
    id: ipRuleIdOf(spec),
    source: spec.from,
    family: familyOfAddress(spec.from),
    policy: policyOf(spec.action),
    note: comment,
    updatedAt: context.updatedAtMap.get(ipCanonicalId(spec)) ?? null,
  }
}

function rowFamiliesOf(spec: UfwRuleSpec, ipv6Enabled: boolean): readonly FirewallAddressFamily[] {
  if (spec.from !== 'any') {
    return spec.from.includes(':') ? ['ipv6'] : ['ipv4']
  }
  return ipv6Enabled ? ['ipv4', 'ipv6'] : ['ipv4']
}

/** 端口段用起始端口参与监听匹配与呈现，备注里保留完整端口段。 */
export function displayPortOf(spec: UfwRuleSpec): number {
  return Number.parseInt(spec.port.split(':')[0] ?? '0', 10)
}

/** 端口段的结束端口；单端口返回 null。 */
export function portToOf(spec: UfwRuleSpec): number | null {
  const end = spec.port.split(':')[1]
  return end === undefined ? null : Number.parseInt(end, 10)
}

function policyOf(action: UfwAction): FirewallPolicy {
  if (action === 'deny' || action === 'reject') return 'deny'
  if (action === 'limit') return 'limit'
  return 'allow'
}

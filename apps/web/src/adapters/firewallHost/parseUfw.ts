import type {
  FirewallAddressFamily,
  FirewallPolicy,
  FirewallProtocol,
  FirewallRule,
  FirewallRuleInput,
} from '@elysian/contracts'
import { FIREWALL_PROTOCOLS } from '@elysian/contracts'

/*
 * ufw 命令输出与规则规范形态的纯解析。形状全部取自容器内 ufw 0.36.2 的真实输出：
 *
 *   ufw allow 22/tcp
 *   ufw allow 22/tcp comment '测试备注 note'
 *   ufw allow out 25/udp
 *   ufw deny 23/tcp
 *   ufw limit 2222/tcp
 *   ufw allow from 192.168.1.0/24 to any port 2049 proto tcp
 *
 * 规则的唯一身份是规范指纹（动作/方向/协议/端口/来源），界面行的 id 再叠加地址族后缀；
 * 删除按指纹还原 ufw 参数，因此从 ufw 读回的任何规则都能被精确增删。
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

export type ParsedUfwLine = { spec: UfwRuleSpec; comment: string | null }

/** 界面行的 id：规范指纹 + 地址族后缀。 */
export function ruleIdOf(spec: UfwRuleSpec, family: FirewallAddressFamily): string {
  return `${canonicalId(spec)}.${family}`
}

export function canonicalId(spec: UfwRuleSpec): string {
  const from = encodeURIComponent(spec.from)
  return `ufw-${spec.action}-${spec.direction}-${spec.proto}-${spec.port}-${from}`
}

/** 从界面行 id 取回规范指纹与地址族；不认识的 id 返回 null。 */
export function parseRuleId(ruleId: string): { spec: UfwRuleSpec; family: FirewallAddressFamily } | null {
  const match = /^(ufw-[a-z]+-(?:in|out)-(?:tcp|udp)-.+)\.(ipv4|ipv6)$/.exec(ruleId)
  if (!match) return null
  const spec = specFromCanonical(match[1] ?? '')
  if (!spec) return null
  return { spec, family: match[2] as FirewallAddressFamily }
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

/**
 * 解析 `ufw show added` 输出。端口规则之外（无端口的来源封禁等）与读不懂的行返回不了，
 * 它们属于「IP 规则」，界面上该类目已是待接入占位。
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
      spec: { action, direction, port: shortForm[1] ?? '', proto: shortForm[2] as FirewallProtocol, from: 'any' },
      comment,
    }
  }

  // 完整形式：from <src> [to any] [port <p>] [proto <proto>]。
  if (rest[0] !== 'from') return null
  const from = rest[1]
  if (!from) return null
  let port: string | undefined
  let proto: string | undefined
  for (let i = 2; i < rest.length; i += 2) {
    const key = rest[i]
    const value = rest[i + 1]
    if (key === 'to') {
      // 目的地址非 any 的规则无法用界面呈现与删除。
      if (!value || value !== 'any') return null
    } else if (key === 'port' && value) {
      port = value
    } else if (key === 'proto' && value) {
      proto = value
    } else {
      return null
    }
  }
  if (!from || !port || !proto || !/^\d{1,5}(?::\d{1,5})?$/.test(port) || !isFirewallProtocol(proto)) {
    return null
  }
  return { spec: { action, direction, port, proto, from }, comment }
}

/** `ufw status verbose` → 防火墙是否启用。 */
export function parseStatusVerbose(stdout: string): { active: boolean } {
  const match = /^Status:\s*(\S+)/m.exec(stdout)
  if (!match) throw new Error('ufw status 输出无效：缺少 Status 行')
  return { active: match[1] === 'active' }
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

export const SOURCE_ALL_IPS = '所有IP'

/** 校验界面输入并映射为 ufw 规范；不合法抛中文错误，不进 shell。 */
export function specFromInput(input: FirewallRuleInput): UfwRuleSpec {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`端口无效：${input.port}（应为 1–65535 的整数）`)
  }
  if (!isFirewallProtocol(input.protocol)) {
    throw new Error(`协议无效：${String(input.protocol)}`)
  }
  if (input.policy !== 'allow' && input.policy !== 'deny') {
    throw new Error(`策略无效：${String(input.policy)}`)
  }
  const source = input.source.trim()
  if (source !== SOURCE_ALL_IPS && !isValidFirewallAddress(source)) {
    throw new Error(`来源无效：${source}（应为「${SOURCE_ALL_IPS}」或合法 IP/网段）`)
  }
  if (input.note && input.note.includes("'")) {
    throw new Error('备注不能包含单引号')
  }
  return {
    action: input.policy,
    direction: input.direction === 'outbound' ? 'out' : 'in',
    port: String(input.port),
    proto: input.protocol,
    from: source === SOURCE_ALL_IPS ? 'any' : source,
  }
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
  /** 本会话内经面板变更过的规则（规范指纹 → ISO 时间）。 */
  updatedAtMap: ReadonlyMap<string, string>
}

/** 一条 ufw 规范展开成界面行；来源为 any 且启用 IPv6 时派生 v4/v6 两行。 */
export function ruleRowsFromSpec(spec: UfwRuleSpec, comment: string | null, context: RuleRowContext): readonly FirewallRule[] {
  const families = rowFamiliesOf(spec, context.ipv6Enabled)
  const key = `${spec.proto}:${displayPortOf(spec)}`
  const status = context.listeners.has(key) ? 'normal' : 'unused'
  const updatedAt = context.updatedAtMap.get(canonicalId(spec)) ?? null
  const rangeNote = spec.port.includes(':') ? `端口段 ${spec.port}` : null
  const note = rangeNote
    ? comment
      ? `${rangeNote}；${comment}`
      : rangeNote
    : comment

  return families.map((family) => ({
    id: ruleIdOf(spec, family),
    protocol: spec.proto,
    port: displayPortOf(spec),
    family,
    status,
    policy: policyOf(spec.action),
    direction: spec.direction === 'out' ? 'outbound' : 'inbound',
    source: spec.from === 'any' ? SOURCE_ALL_IPS : spec.from,
    note,
    updatedAt,
  }))
}

function rowFamiliesOf(spec: UfwRuleSpec, ipv6Enabled: boolean): readonly FirewallAddressFamily[] {
  if (spec.from !== 'any') {
    return spec.from.includes(':') ? ['ipv6'] : ['ipv4']
  }
  return ipv6Enabled ? ['ipv4', 'ipv6'] : ['ipv4']
}

/** 端口段在界面用起始端口呈现，备注里保留完整端口段。 */
export function displayPortOf(spec: UfwRuleSpec): number {
  return Number.parseInt(spec.port.split(':')[0] ?? '0', 10)
}

function policyOf(action: UfwAction): FirewallPolicy {
  return action === 'deny' || action === 'reject' ? 'deny' : 'allow'
}

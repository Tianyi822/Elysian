import type { FirewallForwardInput, FirewallForwardRule } from '@elysian/contracts'
import { isValidFirewallAddress } from './parseUfw'

/*
 * 端口转发：ufw 官方支持的姿势是在 /etc/ufw/before.rules 顶部维护 *nat 表的 PREROUTING DNAT 规则。
 * 这里用标记段管理一段独立的 *nat 块（自有 COMMIT），放在文件最前，filter 表原有内容不动：
 *
 *   ### ELYSIAN 端口转发（自动管理，勿手工编辑）###
 *   *nat
 *   :PREROUTING - [0:0]
 *   -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.0.0.5:80 -m comment --comment "ELYSIAN-FWD 备注"
 *   COMMIT
 *   ### ELYSIAN 端口转发（自动管理，勿手工编辑）###
 *
 * 内核态由服务层精确维护，不走 ufw reload：ufw 以 --noflush 应用 before.rules，
 * 每次 reload 都会把 nat 段再追加一份，内核里就会出现重复的 DNAT 规则。
 * 因此每条转发都带 `ELYSIAN-FWD` comment 标记，应用时先按标记删净、再按段重建，
 * 既不重复，也不碰别人的 nat 规则（例如 Docker 自己的 MASQUERADE）。
 *
 * 转发生效还需要内核 ip_forward=1，由服务层按需确保。DNAT 目标只支持 IPv4，v6 转发不做。
 */

const FORWARD_MARKER = '### ELYSIAN 端口转发（自动管理，勿手工编辑）###'
const FORWARD_FILTER_MARKER = '### ELYSIAN 端口转发放行（自动管理，勿手工编辑）###'

/** 内核里属于本面板的 nat 规则标记（comment 前缀）。 */
export const FORWARD_COMMENT_PREFIX = 'ELYSIAN-FWD'

/** iptables comment 上限 256 字符，留出前缀与余量。 */
const COMMENT_MAX = 200

export const IP_FORWARD_PATH = '/proc/sys/net/ipv4/ip_forward'

export type ForwardSpec = {
  protocol: 'tcp' | 'udp'
  /** 外部端口或端口段（'1000:2000'）。 */
  port: string
  targetHost: string
  targetPort: number
  note: string | null
}

export function forwardIdOf(spec: ForwardSpec): string {
  return `fwd-${spec.protocol}-${spec.port}-${encodeURIComponent(spec.targetHost)}-${spec.targetPort}`
}

export function parseForwardId(ruleId: string): ForwardSpec | null {
  const match = /^fwd-(tcp|udp)-(\d{1,5}(?::\d{1,5})?)-(.+)-(\d{1,5})$/.exec(ruleId)
  if (!match) return null
  const [, proto, port, host, tport] = match
  return {
    protocol: proto as 'tcp' | 'udp',
    port: port ?? '',
    targetHost: decodeURIComponent(host ?? ''),
    targetPort: Number.parseInt(tport ?? '0', 10),
    note: null,
  }
}

/** 规则 comment：固定标记 + 用户备注（截断到 iptables 允许的长度）。 */
export function forwardCommentOf(note: string | null): string {
  const text = note ? `${FORWARD_COMMENT_PREFIX} ${note}` : FORWARD_COMMENT_PREFIX
  return text.slice(0, COMMENT_MAX)
}

/** 从 comment 还原用户备注；非本面板标记的返回 null。 */
export function noteFromForwardComment(comment: string): string | null {
  if (!comment.startsWith(FORWARD_COMMENT_PREFIX)) return null
  const rest = comment.slice(FORWARD_COMMENT_PREFIX.length).trim()
  return rest || null
}

/** 一条转发的 DNAT 规则参数（PREROUTING）。 */
export function natRuleArgsOf(spec: ForwardSpec): readonly string[] {
  return [
    '-p',
    spec.protocol,
    '--dport',
    spec.port,
    '-m',
    'comment',
    '--comment',
    forwardCommentOf(spec.note),
    '-j',
    'DNAT',
    '--to-destination',
    `${spec.targetHost}:${spec.targetPort}`,
  ]
}

/**
 * 一条转发的源地址伪装规则参数（POSTROUTING）。与 DNAT 成对：只做 DNAT 时，
 * 目标会直接把应答发回客户端而绕过本机，形成非对称路由、连接建不起来；
 * MASQUERADE 让转发流量看起来来自本机，应答原路返回。容器网络里目标与客户端
 * 常在同一网桥，这一条是转发真正可用的前提。
 */
export function postRoutingArgsOf(spec: ForwardSpec): readonly string[] {
  return [
    '-d',
    spec.targetHost,
    '-p',
    spec.protocol,
    '--dport',
    String(spec.targetPort),
    '-m',
    'comment',
    '--comment',
    forwardCommentOf(spec.note),
    '-j',
    'MASQUERADE',
  ]
}

/** 一行 DNAT 规则文本（写进 before.rules 的形式）。comment 用双引号：iptables-restore 只认双引号。 */
function ruleLineOf(spec: ForwardSpec): string {
  return `-A PREROUTING -p ${spec.protocol} --dport ${spec.port} -m comment --comment "${forwardCommentOf(spec.note)}" -j DNAT --to-destination ${spec.targetHost}:${spec.targetPort}`
}

/** 一行 MASQUERADE 规则文本（POSTROUTING）。 */
function postRoutingLineOf(spec: ForwardSpec): string {
  return `-A POSTROUTING -d ${spec.targetHost} -p ${spec.protocol} --dport ${spec.targetPort} -m comment --comment "${forwardCommentOf(spec.note)}" -j MASQUERADE`
}

/** 从 before.rules 的一行解析回规范；非本段规则返回 null。 */
function parseRuleLine(line: string): ForwardSpec | null {
  const match = /^-A PREROUTING -p (tcp|udp) --dport (\d{1,5}(?::\d{1,5})?) -m comment --comment "([^"]*)" -j DNAT --to-destination ([\d.]+):(\d{1,5})$/.exec(line)
  if (!match) return null
  const note = noteFromForwardComment(match[3] ?? '')
  if (note === null && match[3] !== FORWARD_COMMENT_PREFIX) return null
  return {
    protocol: match[1] as 'tcp' | 'udp',
    port: match[2] ?? '',
    targetHost: match[4] ?? '',
    targetPort: Number.parseInt(match[5] ?? '0', 10),
    note,
  }
}

/** 解析整个 before.rules 里的转发段为规范列表；无段返回空。 */
export function parseForwardSection(beforeRules: string): readonly ForwardSpec[] {
  const section = extractSection(beforeRules)
  if (!section) return []
  const specs: ForwardSpec[] = []
  for (const line of section) {
    const spec = parseRuleLine(line)
    if (spec) specs.push(spec)
  }
  return specs
}

/**
 * 用给定规范列表重写转发段：段放在文件最前（ufw 官方文档的 nat 位置）。
 * specs 为空等价于移除段。
 */
export function setForwardSection(beforeRules: string, specs: readonly ForwardSpec[]): string {
  const without = removeForwardSection(beforeRules)
  if (specs.length === 0) return without
  const block = [
    FORWARD_MARKER,
    '*nat',
    ':PREROUTING - [0:0]',
    ':POSTROUTING - [0:0]',
    ...specs.map(ruleLineOf),
    ...specs.map(postRoutingLineOf),
    'COMMIT',
    FORWARD_MARKER,
  ].join('\n')
  return `${block}\n${without.replace(/^\n+/, '')}`
}

function extractSection(beforeRules: string): readonly string[] | null {
  const lines = beforeRules.split('\n')
  const start = lines.findIndex((line) => line.trim() === FORWARD_MARKER)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === FORWARD_MARKER)
  if (end === -1) return null
  return lines.slice(start + 1, end)
}

function removeForwardSection(beforeRules: string): string {
  return removeMarkedSection(beforeRules, FORWARD_MARKER)
}

function removeMarkedSection(text: string, marker: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === marker) {
      inside = !inside
      continue
    }
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

/*
 * ufw 的默认转发策略是 DROP（/etc/default/ufw 的 DEFAULT_FORWARD_POLICY）：DNAT 只改目的地址，
 * 改完的包还要过 FORWARD 链，不放行就永远到不了目标。这里为本面板的每条转发在
 * `ufw-before-forward` 里精确放行对应的目标与端口（DNAT 后的目的端口即目标端口），
 * 不动全局转发策略，别的转发流量照旧受默认策略约束。
 */

/** 转发对应的 ufw-before-forward 放行行（filter 表内）。 */
export function forwardFilterLinesOf(specs: readonly ForwardSpec[]): readonly string[] {
  return specs.map(
    (spec) =>
      `-A ufw-before-forward -p ${spec.protocol} -d ${spec.targetHost} --dport ${spec.targetPort} -m comment --comment "${forwardCommentOf(spec.note)}" -j ACCEPT`,
  )
}

/** 重写转发放行段（插在 filter 表的 COMMIT 之前）；specs 为空则移除段。 */
export function setForwardFilterSection(beforeRules: string, specs: readonly ForwardSpec[]): string {
  const without = removeMarkedSection(beforeRules, FORWARD_FILTER_MARKER)
  if (specs.length === 0) return without

  const lines = without.split('\n')
  const filterStart = lines.findIndex((line) => line.trim() === '*filter')
  if (filterStart === -1) {
    throw new Error('before.rules 格式无效：找不到 filter 表')
  }
  const commitIndex = lines.findIndex((line, index) => index > filterStart && line.trim() === 'COMMIT')
  if (commitIndex === -1) {
    throw new Error('before.rules 格式无效：找不到 filter 表的 COMMIT 行')
  }
  lines.splice(commitIndex, 0, FORWARD_FILTER_MARKER, ...forwardFilterLinesOf(specs), FORWARD_FILTER_MARKER)
  return lines.join('\n')
}

/**
 * 从 `iptables -t nat -L PREROUTING -n --line-numbers` 输出取本面板规则的行号（升序）。
 * comment 在列表输出里以块注释形式呈现：行号 + target/prot 等列，末尾带着
 * comment 文本 `ELYSIAN-FWD ...`（形如注释包起来的标记），据它认出本面板的规则。
 */
export function parseOurNatRuleNumbers(listing: string): readonly number[] {
  const numbers: number[] = []
  for (const line of listing.split('\n')) {
    if (!line.includes(`/* ${FORWARD_COMMENT_PREFIX}`)) continue
    const match = /^\s*(\d+)\s/.exec(line)
    const num = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN
    if (Number.isFinite(num)) numbers.push(num)
  }
  return numbers.sort((a, b) => a - b)
}

/** 校验转发输入并映射为规范；不合法抛中文错误。 */
export function specFromForwardInput(input: FirewallForwardInput): ForwardSpec {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`外部端口无效：${input.port}（应为 1–65535 的整数）`)
  }
  if (input.portTo !== undefined) {
    if (!Number.isInteger(input.portTo) || input.portTo < 1 || input.portTo > 65535) {
      throw new Error(`外部端口段结束无效：${input.portTo}（应为 1–65535 的整数）`)
    }
    if (input.portTo < input.port) {
      throw new Error(`端口段无效：结束端口 ${input.portTo} 小于起始端口 ${input.port}`)
    }
  }
  if (input.protocol !== 'tcp' && input.protocol !== 'udp') {
    throw new Error(`协议无效：${String(input.protocol)}`)
  }
  if (!isValidFirewallAddress(input.targetHost) || input.targetHost.includes(':')) {
    throw new Error(`目标地址无效：${input.targetHost}（应为合法 IPv4 地址）`)
  }
  if (!Number.isInteger(input.targetPort) || input.targetPort < 1 || input.targetPort > 65535) {
    throw new Error(`目标端口无效：${input.targetPort}（应为 1–65535 的整数）`)
  }
  if (input.note && input.note.includes('"')) {
    // comment 以双引号包进规则文本，备注里的双引号会破坏规则
    throw new Error('备注不能包含双引号')
  }
  return {
    protocol: input.protocol,
    port: input.portTo !== undefined ? `${input.port}:${input.portTo}` : String(input.port),
    targetHost: input.targetHost,
    targetPort: input.targetPort,
    note: input.note?.trim() || null,
  }
}

/** 转发规范展开为界面行。 */
export function forwardRowFromSpec(spec: ForwardSpec, updatedAt: string | null): FirewallForwardRule {
  const start = Number.parseInt(spec.port.split(':')[0] ?? '0', 10)
  const endText = spec.port.split(':')[1]
  return {
    id: forwardIdOf(spec),
    protocol: spec.protocol,
    port: start,
    portTo: endText === undefined ? null : Number.parseInt(endText, 10),
    targetHost: spec.targetHost,
    targetPort: spec.targetPort,
    note: spec.note,
    updatedAt,
  }
}

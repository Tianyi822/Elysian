import { DEFAULT_SCAN_CONFIG, type FirewallScanConfig } from '@elysian/contracts'
import { invalidRequest } from '../endpointGuard/guard'
import { isValidFirewallAddress } from './parseUfw'
import { PANEL_PORT } from './panelPort'

/*
 * 端口防扫描的规则段与内核数据解析。机制是内核 xt_recent 的双名单 jail：
 *
 *   1. 监控端口的 TCP 新连接按源 IP 记入跟踪名单（--set）；
 *   2. 判定窗口内达到阈值 → 把源 IP 记入封锁名单并丢弃该包（--rcheck --hitcount + --set + DROP）；
 *   3. 已在封锁名单且未过封禁期 → 直接丢弃（--rcheck --seconds <ban> + DROP）。
 *
 * 封锁名单读 /proc/net/xt_recent/ELYSIAN_SCAN_BANNED{,6}，解封即向该文件写「-IP」；
 * 拦截计数读 iptables/ip6tables 规则包计数。v4/v6 各一套独立名单与规则，
 * 规则段分别注入 before.rules 与 before6.rules 的 filter 表，随 ufw reload 生效。
 * 开关状态与配置（端口、窗口、阈值、封禁时长）都以规则段文本为准——配置就持久化在规则里。
 */

const SCAN_MARKER = '### ELYSIAN 端口防扫描（自动管理，勿手工编辑）###'

/** v4/v6 的链名、跟踪与封锁名单名（内核 recent 名单按名字隔离，v6 用独立名字避免同名列冲突）。 */
export const SCAN_TABLES = {
  v4: { chain: 'ufw-before-input', track: 'ELYSIAN_SCAN', banned: 'ELYSIAN_SCAN_BANNED' },
  v6: { chain: 'ufw6-before-input', track: 'ELYSIAN_SCAN6', banned: 'ELYSIAN_SCAN_BANNED6' },
} as const

export const SCAN_BANNED_RECENT_PATH = `/proc/net/xt_recent/${SCAN_TABLES.v4.banned}`
export const SCAN_BANNED6_RECENT_PATH = `/proc/net/xt_recent/${SCAN_TABLES.v6.banned}`

/**
 * 校验防扫描配置；不合法抛中文错误。这些都是请求体本身的问题，抛 invalidRequest 让端点按 400
 * 返回。判据是纯函数、不依赖开关状态，因此调用方可以先校验请求再判前置状态：面板端口这条
 * 保底判据在「防扫描未启用」时同样拦得住。
 */
export function validateScanConfig(config: FirewallScanConfig): FirewallScanConfig {
  if (config.ports.length === 0 || config.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw invalidRequest('监控端口无效：应为 1–65535 的端口列表')
  }
  // DROP 规则挂在 ufw-before-input 链里，先于保底放行匹配：监控面板端口会把面板
  // 客户端 IP 封进黑名单，且封禁后连解封端点本身都不可达。
  if (config.ports.includes(PANEL_PORT)) {
    throw invalidRequest(`面板端口不允许加入防扫描监控：${PANEL_PORT} 是工作台自身的访问通道`)
  }
  if (config.ports.length > 15) {
    throw invalidRequest(`监控端口过多：${config.ports.length} 个（最多 15 个端口，内核 multiport 匹配上限）`)
  }
  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds < 10 || config.windowSeconds > 3600) {
    throw invalidRequest(`判定窗口无效：${config.windowSeconds}（应为 10–3600 秒）`)
  }
  if (!Number.isInteger(config.hitCount) || config.hitCount < 3 || config.hitCount > 1000) {
    throw invalidRequest(`阈值无效：${config.hitCount}（应为 3–1000 次）`)
  }
  if (!Number.isInteger(config.banSeconds) || config.banSeconds < 60 || config.banSeconds > 86400) {
    throw invalidRequest(`封禁时长无效：${config.banSeconds}（应为 60–86400 秒）`)
  }
  return { ...config, ports: [...config.ports].sort((a, b) => a - b) }
}

function sectionLines(config: FirewallScanConfig, family: 'v4' | 'v6'): readonly string[] {
  const tables = SCAN_TABLES[family]
  const ports = config.ports.join(',')
  return [
    `-A ${tables.chain} -p tcp -m multiport --dports ${ports} -m conntrack --ctstate NEW -m recent --name ${tables.banned} --rcheck --seconds ${config.banSeconds} -j DROP`,
    `-A ${tables.chain} -p tcp -m multiport --dports ${ports} -m conntrack --ctstate NEW -m recent --name ${tables.track} --rcheck --seconds ${config.windowSeconds} --hitcount ${config.hitCount} -m recent --name ${tables.banned} --set -j DROP`,
    `-A ${tables.chain} -p tcp -m multiport --dports ${ports} -m conntrack --ctstate NEW -m recent --name ${tables.track} --set`,
  ]
}

/** 完整的规则段文本（含首尾标记注释）。 */
export function scanSectionLines(config: FirewallScanConfig = DEFAULT_SCAN_CONFIG): readonly string[] {
  const valid = validateScanConfig(config)
  return [SCAN_MARKER, ...sectionLines(valid, 'v4'), SCAN_MARKER]
}

export type ScanSectionState = {
  enabled: boolean
  config: FirewallScanConfig
}

/** 防扫描是否启用：规则文件里存在规则段；配置从规则文本解析回，缺省回落默认配置。 */
export function parseScanSection(beforeRules: string): ScanSectionState {
  if (countMarkers(beforeRules) < 2) return { enabled: false, config: { ...DEFAULT_SCAN_CONFIG, ports: [...DEFAULT_SCAN_CONFIG.ports] } }

  const configMatch = /--dports ([\d,]+).*?--rcheck --seconds (\d+) --hitcount (\d+)/.exec(beforeRules)
  const banMatch = /--name ELYSIAN_SCAN_BANNED6? --rcheck --seconds (\d+)/.exec(beforeRules)
  const ports = (configMatch?.[1] ?? '')
    .split(',')
    .map((port) => Number.parseInt(port, 10))
    .filter((port) => Number.isFinite(port))
  return {
    enabled: true,
    config: {
      ports: ports.length > 0 ? ports : [...DEFAULT_SCAN_CONFIG.ports],
      windowSeconds: Number.parseInt(configMatch?.[2] ?? '', 10) || DEFAULT_SCAN_CONFIG.windowSeconds,
      hitCount: Number.parseInt(configMatch?.[3] ?? '', 10) || DEFAULT_SCAN_CONFIG.hitCount,
      banSeconds: Number.parseInt(banMatch?.[1] ?? '', 10) || DEFAULT_SCAN_CONFIG.banSeconds,
    },
  }
}

/** 启用/停用并落配置：插进 filter 表的 COMMIT 之前（转发段的 *nat 块另有 COMMIT，不能锚错表）。 */
export function setScanSection(
  beforeRules: string,
  enabled: boolean,
  config: FirewallScanConfig = DEFAULT_SCAN_CONFIG,
  family: 'v4' | 'v6' = 'v4',
): string {
  const withoutSection = removeScanSection(beforeRules)
  if (!enabled) return withoutSection

  const valid = validateScanConfig(config)
  const lines = withoutSection.split('\n')
  const commitIndex = findFilterCommitIndex(lines)
  if (commitIndex === -1) {
    throw new Error('before.rules 格式无效：找不到 filter 表的 COMMIT 行')
  }
  lines.splice(commitIndex, 0, SCAN_MARKER, ...sectionLines(valid, family), SCAN_MARKER)
  return lines.join('\n')
}

/** filter 表块的结束 COMMIT：从 `*filter` 行往后找第一个 COMMIT。 */
function findFilterCommitIndex(lines: readonly string[]): number {
  const filterStart = lines.findIndex((line) => line.trim() === '*filter')
  if (filterStart === -1) return -1
  for (let i = filterStart + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === 'COMMIT') return i
  }
  return -1
}

function removeScanSection(beforeRules: string): string {
  const lines = beforeRules.split('\n')
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === SCAN_MARKER) {
      inside = !inside
      continue
    }
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

function countMarkers(beforeRules: string): number {
  return beforeRules.split('\n').filter((line) => line.trim() === SCAN_MARKER).length
}

/**
 * 解析 /proc/net/xt_recent/<banned> 的封锁名单，行形如：
 * `src=203.0.113.9 ttl: 64 last_seen: 5123456 oldest_pkt: 1 newest_pkt: 5123456`
 */
export function parseRecentList(recentText: string): readonly string[] {
  const ips: string[] = []
  for (const line of recentText.split('\n')) {
    const match = /^src=(\S+)/.exec(line.trim())
    if (match?.[1]) ips.push(match[1])
  }
  return ips
}

/** 解封参数校验：必须是合法 IP（内核 recent 名单不接受网段）。 */
export function validateUnblockIp(ip: string): string {
  const trimmed = ip.trim()
  if (!isValidFirewallAddress(trimmed) || trimmed.includes('/')) {
    throw new Error(`IP 无效：${ip}（应为合法 IP，不含网段）`)
  }
  return trimmed
}

/**
 * 从 `iptables -L <chain> -nvx` 输出解析防扫描 DROP 规则的累计拦截包数（双 DROP 规则求和：
 * 封禁期丢弃 + 触发阈值那一次丢弃）。传入的输出里只含 ELYSIAN 名字的规则行。
 */
export function parseDropCounter(listOutput: string): number {
  let total = 0
  for (const line of listOutput.split('\n')) {
    if (!line.includes('ELYSIAN_SCAN') || !line.includes('DROP')) continue
    const columns = line.trim().split(/\s+/)
    const pkts = Number.parseInt(columns[0] ?? '', 10)
    if (Number.isFinite(pkts)) total += pkts
  }
  return total
}

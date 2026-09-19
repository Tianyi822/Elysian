import { SCAN_HIT_COUNT, SCAN_MONITOR_PORTS, SCAN_WINDOW_SECONDS } from '@elysian/contracts'
import { isValidFirewallAddress } from './parseUfw'

/*
 * 端口防扫描的规则段与内核数据解析。机制是内核 xt_recent：
 * before.rules 里注入一段自定义规则，监控端口的 TCP 新连接按源 IP 记入 recent 列表，
 * 窗口内超过阈值直接 DROP；封锁名单读 /proc/net/xt_recent/ELYSIAN_SCAN，
 * 解封即向该文件写「-IP」，拦截计数读 iptables 规则自带的包计数器。
 * 开关状态以 before.rules 里规则段的存在为准（与禁 ping 同一模式），随 ufw reload 生效。
 */

export const SCAN_CHAIN_NAME = 'ELYSIAN_SCAN'

/** 规则串里的监控端口列表即契约的监控端口。 */
export const SCAN_PORTS = SCAN_MONITOR_PORTS

export const SCAN_RECENT_PATH = `/proc/net/xt_recent/${SCAN_CHAIN_NAME}`

const SCAN_MARKER = '### ELYSIAN 端口防扫描（自动管理，勿手工编辑）###'

const SCAN_RULE_LINES = [
  `-A ufw-before-input -p tcp -m multiport --dports ${SCAN_PORTS} -m conntrack --ctstate NEW -m recent --name ${SCAN_CHAIN_NAME} --set`,
  `-A ufw-before-input -p tcp -m multiport --dports ${SCAN_PORTS} -m conntrack --ctstate NEW -m recent --name ${SCAN_CHAIN_NAME} --rcheck --seconds ${SCAN_WINDOW_SECONDS} --hitcount ${SCAN_HIT_COUNT} -j DROP`,
]

/** 完整的规则段文本（含首尾标记注释）。 */
export function scanSectionLines(): readonly string[] {
  return [SCAN_MARKER, ...SCAN_RULE_LINES, SCAN_MARKER]
}

/** 防扫描是否启用：before.rules 里存在规则段。 */
export function parseScanEnabled(beforeRules: string): boolean {
  return countMarkers(beforeRules) >= 2
}

/** 启用/停用：在最后一个 COMMIT 前插入或移除规则段，其余行原样保留。 */
export function setScanEnabled(beforeRules: string, enabled: boolean): string {
  const withoutSection = removeScanSection(beforeRules)
  if (!enabled) return withoutSection

  const lines = withoutSection.split('\n')
  const commitIndex = findLastCommitIndex(lines)
  if (commitIndex === -1) {
    throw new Error('before.rules 格式无效：找不到 COMMIT 行')
  }
  lines.splice(commitIndex, 0, ...scanSectionLines())
  return lines.join('\n')
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

function findLastCommitIndex(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? '').trim() === 'COMMIT') return i
  }
  return -1
}

/**
 * 解析 /proc/net/xt_recent/ELYSIAN_SCAN 的封锁名单，行形如：
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
 * 从 `iptables -L ufw-before-input -nvx` 输出解析防扫描 DROP 规则的累计拦截包数。
 * 行形如：`  128  7680 DROP     tcp  --  *  *  0.0.0.0/0  0.0.0.0/0  ... name ELYSIAN_SCAN ...`
 */
export function parseDropCounter(listOutput: string): number {
  for (const line of listOutput.split('\n')) {
    if (!line.includes(SCAN_CHAIN_NAME) || !line.includes('DROP')) continue
    const columns = line.trim().split(/\s+/)
    const pkts = Number.parseInt(columns[0] ?? '', 10)
    if (Number.isFinite(pkts)) return pkts
  }
  return 0
}

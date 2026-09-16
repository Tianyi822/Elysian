import type {
  FirewallImportResult,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import { FIREWALL_ADDRESS_FAMILIES } from '@elysian/contracts'

/*
 * 防火墙演示数据集。种子行手工固定（时间取自真实样例），确定性可复现；
 * 会话内的增删改落在这份内存数据上，刷新回到种子状态。
 * v4/v6 两行成对登记；「时间 —」的行 updatedAt 为 null，表示本会话没有变更过。
 */

/** 种子规则导出给导入/导出的测试当夹具。 */
export const SEED_RULES: readonly FirewallRule[] = [
  { id: 'fw-2234-ipv4', protocol: 'tcp', port: 2234, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: '博客后端', updatedAt: '2025-07-06T23:35:56' },
  { id: 'fw-2234-ipv6', protocol: 'tcp', port: 2234, family: 'ipv6', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: '博客后端', updatedAt: '2025-07-06T23:35:56' },
  { id: 'fw-2233-ipv4', protocol: 'tcp', port: 2233, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: '2025-06-30T14:18:55' },
  { id: 'fw-2233-ipv6', protocol: 'tcp', port: 2233, family: 'ipv6', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: '2025-06-30T14:18:55' },
  { id: 'fw-40223-ipv4', protocol: 'tcp', port: 40223, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'frps', updatedAt: '2025-06-10T22:26:46' },
  { id: 'fw-40223-ipv6', protocol: 'tcp', port: 40223, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'frps', updatedAt: '2025-06-10T22:26:46' },
  { id: 'fw-26755-ipv4', protocol: 'tcp', port: 26755, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'frps', updatedAt: '2025-06-10T22:26:36' },
  { id: 'fw-26755-ipv6', protocol: 'tcp', port: 26755, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'frps', updatedAt: '2025-06-10T22:26:36' },
  { id: 'fw-12443-ipv4', protocol: 'tcp', port: 12443, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:43' },
  { id: 'fw-12443-ipv6', protocol: 'tcp', port: 12443, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:43' },
  { id: 'fw-12080-ipv4', protocol: 'tcp', port: 12080, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:30' },
  { id: 'fw-12080-ipv6', protocol: 'tcp', port: 12080, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:30' },
  { id: 'fw-3478-ipv4', protocol: 'tcp', port: 3478, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:12' },
  { id: 'fw-3478-ipv6', protocol: 'tcp', port: 3478, family: 'ipv6', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'derper', updatedAt: '2025-06-10T21:56:12' },
  { id: 'fw-21-ipv4', protocol: 'tcp', port: 21, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'FTP协议默认端口', updatedAt: '2025-05-23T21:57:47' },
  { id: 'fw-21-ipv6', protocol: 'tcp', port: 21, family: 'ipv6', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'FTP协议默认端口', updatedAt: '2025-05-23T21:57:47' },
  { id: 'fw-22633-ipv4', protocol: 'tcp', port: 22633, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: null },
  { id: 'fw-73-ipv4', protocol: 'tcp', port: 73, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: null },
  { id: 'fw-22633-ipv6', protocol: 'tcp', port: 22633, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: null },
  { id: 'fw-73-ipv6', protocol: 'tcp', port: 73, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: null, updatedAt: null },
  // 以下为演示补充：udp 与拒绝策略在真实防火墙里同样常见，补齐界面两种取值的呈现。
  { id: 'fw-53-ipv4', protocol: 'udp', port: 53, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'DNS 解析', updatedAt: '2025-04-02T09:12:04' },
  { id: 'fw-53-ipv6', protocol: 'udp', port: 53, family: 'ipv6', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'DNS 解析', updatedAt: '2025-04-02T09:12:04' },
  { id: 'fw-23-ipv4', protocol: 'tcp', port: 23, family: 'ipv4', status: 'unused', policy: 'deny', direction: 'inbound', source: '所有IP', note: 'Telnet 默认拒绝', updatedAt: '2025-03-18T17:40:29' },
  { id: 'fw-51820-ipv4', protocol: 'udp', port: 51820, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'WireGuard', updatedAt: '2025-02-11T11:05:51' },
  { id: 'fw-80-ipv4', protocol: 'tcp', port: 80, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'Web 服务', updatedAt: '2025-01-26T08:47:15' },
  { id: 'fw-6379-ipv4', protocol: 'tcp', port: 6379, family: 'ipv4', status: 'normal', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'Redis', updatedAt: '2025-01-26T08:46:58' },
  { id: 'fw-1194-ipv4', protocol: 'udp', port: 1194, family: 'ipv4', status: 'unused', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'OpenVPN', updatedAt: '2024-12-09T15:22:33' },
]

const SEED_TOGGLES: FirewallToggles = {
  firewallEnabled: true,
  pingBlocked: true,
}

/*
 * 防扫描演示数据：历史累计值取真实运维样例（拦过 340 个 IP、16.8 万次失败连接），
 * 当前封锁为空——演示机重启后封锁表清空，但历史统计保留。
 */
const SEED_SCAN: FirewallScanProtection = {
  enabled: true,
  stats: {
    totalBlockedIps: 340,
    totalFailedConnections: 168694,
    currentBlockedIps: 0,
    currentFailedConnections: 0,
  },
  blocked: [],
}

let rules: FirewallRule[] = SEED_RULES.map((rule) => ({ ...rule }))
let toggles: FirewallToggles = { ...SEED_TOGGLES }
let scan: FirewallScanProtection = {
  enabled: SEED_SCAN.enabled,
  stats: { ...SEED_SCAN.stats },
  blocked: SEED_SCAN.blocked.map((entry) => ({ ...entry })),
}

export function getFirewallRules(): readonly FirewallRule[] {
  return rules.map((rule) => ({ ...rule }))
}

export function getFirewallToggles(): FirewallToggles {
  return { ...toggles }
}

export function setFirewallToggles(next: FirewallToggles): FirewallToggles {
  toggles = { ...next }
  return { ...toggles }
}

/** 同端口同协议同地址族视为已存在，与真实防火墙的规则唯一性一致。 */
export function findDuplicateFirewallRule(
  input: FirewallRuleInput,
  exceptRuleId?: string,
): FirewallRule | undefined {
  return rules.find(
    (rule) =>
      rule.id !== exceptRuleId &&
      rule.protocol === input.protocol &&
      rule.port === input.port &&
      rule.family === input.family,
  )
}

export function addFirewallRule(input: FirewallRuleInput, updatedAt: string): FirewallRule {
  const rule: FirewallRule = {
    id: `fw-${input.protocol}-${input.port}-${input.family}`,
    status: 'unused',
    direction: 'inbound',
    updatedAt,
    ...input,
  }
  rules = [...rules, rule]
  return { ...rule }
}

export function updateFirewallRule(
  ruleId: string,
  input: FirewallRuleInput,
  updatedAt: string,
): FirewallRule {
  const existing = rules.find((rule) => rule.id === ruleId)
  if (!existing) throw new Error(`未找到端口规则 ${ruleId}`)
  const next: FirewallRule = { ...existing, ...input, updatedAt }
  rules = rules.map((rule) => (rule.id === ruleId ? next : rule))
  return { ...next }
}

export function removeFirewallRule(ruleId: string): void {
  const existing = rules.find((rule) => rule.id === ruleId)
  if (!existing) throw new Error(`未找到端口规则 ${ruleId}`)
  rules = rules.filter((rule) => rule.id !== ruleId)
}

/** 批量导入：与既有规则及批内互相去重，同协议同端口同地址族视为重复。 */
export function importFirewallRules(
  inputs: readonly FirewallRuleInput[],
  updatedAt: string,
): FirewallImportResult {
  const seen = new Set(rules.map((rule) => `${rule.protocol}:${rule.port}:${rule.family}`))
  const added: FirewallRule[] = []
  let skipped = 0
  for (const input of inputs) {
    const key = `${input.protocol}:${input.port}:${input.family}`
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    const rule = addFirewallRule(input, updatedAt)
    added.push(rule)
  }
  return { added: added.map((rule) => ({ ...rule })), skipped }
}

export function getScanProtection(): FirewallScanProtection {
  return {
    enabled: scan.enabled,
    stats: { ...scan.stats },
    blocked: scan.blocked.map((entry) => ({ ...entry })),
  }
}

export function setScanProtection(enabled: boolean): FirewallScanProtection {
  scan = { ...scan, enabled }
  return getScanProtection()
}

export function unblockScanIp(ip: string): FirewallScanProtection {
  const exists = scan.blocked.some((entry) => entry.ip === ip)
  if (!exists) throw new Error(`IP ${ip} 不在封锁列表中`)
  scan = {
    ...scan,
    stats: { ...scan.stats, currentBlockedIps: scan.stats.currentBlockedIps - 1 },
    blocked: scan.blocked.filter((entry) => entry.ip !== ip),
  }
  return getScanProtection()
}

/** 全量地址族，供表单选择。 */
export const FIREWALL_FAMILY_OPTIONS = FIREWALL_ADDRESS_FAMILIES

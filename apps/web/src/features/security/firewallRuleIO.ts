import type { FirewallDirection, FirewallRule, FirewallRuleInput } from '@elysian/contracts'
import {
  FIREWALL_ADDRESS_FAMILIES,
  FIREWALL_POLICIES,
  FIREWALL_PROTOCOLS,
} from '@elysian/contracts'

/*
 * 端口规则的导入/导出：全部在浏览器本地完成——导入只读取用户选择的文件、
 * 导出只生成一个本地下载，不发任何网络请求，也不触碰真实防火墙。
 * 导出的 JSON 即导入的格式，往返一致。
 */

export type FirewallExportDirection = FirewallDirection | 'all'

export const FIREWALL_EXPORT_DIRECTIONS: readonly { value: FirewallExportDirection; label: string }[] = [
  { value: 'all', label: '所有方向' },
  { value: 'inbound', label: '入站' },
  { value: 'outbound', label: '出站' },
]

export type FirewallExportPayload = {
  kind: 'elysian-firewall-rules'
  exportedAt: string
  direction: FirewallExportDirection
  rules: readonly FirewallRule[]
}

export function filterRulesByDirection(
  rules: readonly FirewallRule[],
  direction: FirewallExportDirection,
): readonly FirewallRule[] {
  return direction === 'all' ? rules : rules.filter((rule) => rule.direction === direction)
}

export function buildExportPayload(
  rules: readonly FirewallRule[],
  direction: FirewallExportDirection,
  exportedAt: string,
): FirewallExportPayload {
  return { kind: 'elysian-firewall-rules', exportedAt, direction, rules: filterRulesByDirection(rules, direction) }
}

export function buildExportFilename(direction: FirewallExportDirection, exportedAt: string): string {
  const day = exportedAt.slice(0, 10).replaceAll('-', '')
  return `elysian-firewall-${direction}-${day}.json`
}

export type FirewallImportParseResult = {
  rules: readonly FirewallRuleInput[]
  invalid: number
}

/**
 * 解析导入的 JSON 文本。接受导出格式（{ rules: [...] }）或裸数组；
 * 单条不合法的跳过并计数，不让一条坏数据拖垮整批。
 */
export function parseFirewallRulesJson(text: string): FirewallImportParseResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['rules'])
      ? parsed['rules']
      : null
  if (!entries) return null

  const rules: FirewallRuleInput[] = []
  let invalid = 0
  for (const entry of entries) {
    const rule = toRuleInput(entry)
    if (rule) rules.push(rule)
    else invalid += 1
  }
  return { rules, invalid }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRuleInput(entry: unknown): FirewallRuleInput | null {
  if (!isRecord(entry)) return null
  const { protocol, port, family, policy, direction, source, note } = entry
  // includes() 收窄不了字面量联合类型，用 Set.has 判定后再断言；取值集合由本文件选项决定。
  const PROTOCOLS: ReadonlySet<string> = new Set(FIREWALL_PROTOCOLS)
  const FAMILIES: ReadonlySet<string> = new Set(FIREWALL_ADDRESS_FAMILIES)
  const POLICIES: ReadonlySet<string> = new Set(FIREWALL_POLICIES)
  const DIRECTIONS: ReadonlySet<string> = new Set(['inbound', 'outbound'])
  if (typeof protocol !== 'string' || !PROTOCOLS.has(protocol)) return null
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof family !== 'string' || !FAMILIES.has(family)) return null
  if (typeof policy !== 'string' || !POLICIES.has(policy)) return null
  if (direction !== undefined && (typeof direction !== 'string' || !DIRECTIONS.has(direction))) return null
  const input: FirewallRuleInput = {
    protocol: protocol as FirewallRuleInput['protocol'],
    port,
    family: family as FirewallRuleInput['family'],
    policy: policy as FirewallRuleInput['policy'],
    source: typeof source === 'string' && source.trim() ? source.trim() : '所有IP',
    note: typeof note === 'string' && note.trim() ? note.trim() : null,
  }
  if (typeof direction === 'string') input.direction = direction as FirewallDirection
  return input
}

/** 生成本地下载（Blob + 临时链接），不经过网络。 */
export function downloadJson(filename: string, payload: FirewallExportPayload): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

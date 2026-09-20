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
  /** 每条不合法条目的位置与原因：整批先校验、逐条标出，而不是静默跳过或整体失败。 */
  problems: readonly FirewallImportProblem[]
}

/** 导入文件里一条不合法条目：序号从 1 计，指向条目在文件里的位置。 */
export type FirewallImportProblem = {
  index: number
  reason: string
}

/** 被拒条目拼成一句中文清单：逐条给出「第几条、为什么」，供界面原样呈现。 */
export function formatFirewallImportProblems(problems: readonly FirewallImportProblem[]): string {
  return problems.map((problem) => `第 ${problem.index} 条：${problem.reason}`).join('；')
}

/**
 * 解析导入的 JSON 文本。接受导出格式（{ rules: [...] }）或裸数组；
 * 单条不合法的拒收并逐条给出原因，不让一条坏数据拖垮整批。
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
  const problems: FirewallImportProblem[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const outcome = toRuleInput(entries[index])
    if ('rule' in outcome) rules.push(outcome.rule)
    else problems.push({ index: index + 1, reason: outcome.problem })
  }
  return { rules, invalid: problems.length, problems }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/*
 * 备注禁区与服务端 ufw 场景（adapters/firewallHost/noteValidation 的 assertNoteSafe）同一判据：
 * 控制字符会写坏按行解析的规则回读，单引号会截断 ufw 的 comment 参数。导入与表单都在
 * 浏览器侧先挡一次，坏备注不进服务端循环；文案与服务端抛出的中文错误逐字一致。
 */
const UNSAFE_NOTE_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/

/** 端口规则备注不合法时返回与服务端一致的中文错误，合法返回 undefined。 */
export function firewallRuleNoteProblem(note: string): string | undefined {
  if (!note) return undefined
  if (UNSAFE_NOTE_CHARS.test(note)) return '备注不能包含换行或控制字符'
  if (note.includes("'")) return '备注不能包含单引号'
  return undefined
}

/** 单条导入条目的解析结果：合法给规则，不合法给中文原因。 */
type RuleParseOutcome = { rule: FirewallRuleInput } | { problem: string }

const STRUCTURAL_PROBLEM = '协议、端口、地址族、策略或方向不合法'

function toRuleInput(entry: unknown): RuleParseOutcome {
  if (!isRecord(entry)) return { problem: '条目不是 JSON 对象' }
  const { protocol, port, family, policy, direction, source, note } = entry
  // includes() 收窄不了字面量联合类型，用 Set.has 判定后再断言；取值集合由本文件选项决定。
  const PROTOCOLS: ReadonlySet<string> = new Set(FIREWALL_PROTOCOLS)
  const FAMILIES: ReadonlySet<string> = new Set(FIREWALL_ADDRESS_FAMILIES)
  const POLICIES: ReadonlySet<string> = new Set(FIREWALL_POLICIES)
  const DIRECTIONS: ReadonlySet<string> = new Set(['inbound', 'outbound'])
  if (typeof protocol !== 'string' || !PROTOCOLS.has(protocol)) return { problem: STRUCTURAL_PROBLEM }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { problem: STRUCTURAL_PROBLEM }
  }
  if (typeof family !== 'string' || !FAMILIES.has(family)) return { problem: STRUCTURAL_PROBLEM }
  if (typeof policy !== 'string' || !POLICIES.has(policy)) return { problem: STRUCTURAL_PROBLEM }
  if (direction !== undefined && (typeof direction !== 'string' || !DIRECTIONS.has(direction))) {
    return { problem: STRUCTURAL_PROBLEM }
  }
  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : null
  const noteProblem = trimmedNote ? firewallRuleNoteProblem(trimmedNote) : undefined
  if (noteProblem) return { problem: noteProblem }
  const input: FirewallRuleInput = {
    protocol: protocol as FirewallRuleInput['protocol'],
    port,
    family: family as FirewallRuleInput['family'],
    policy: policy as FirewallRuleInput['policy'],
    source: typeof source === 'string' && source.trim() ? source.trim() : '所有IP',
    note: trimmedNote,
  }
  if (typeof direction === 'string') input.direction = direction as FirewallDirection
  return { rule: input }
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

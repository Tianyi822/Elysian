import type {
  FirewallForwardRule,
  FirewallImportResult,
  FirewallIpRule,
  FirewallPortSync,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import {
  FIREWALL_ADDRESS_FAMILIES,
  FIREWALL_DIRECTIONS,
  FIREWALL_POLICIES,
  FIREWALL_PROTOCOLS,
  FIREWALL_RULE_STATUSES,
} from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'
import { reportUnauthorized } from './unauthorized'

/*
 * 浏览器侧同源防火墙查询（Docker 运行时）。系统采样、ufw 命令仅存在于
 * dev/preview 的 Node 中间件，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 resourceHistoryAdapter 一致。
 */

type FirewallOverview = {
  toggles: FirewallToggles
  rules: readonly FirewallRule[]
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('防火墙响应格式无效')
  }
  return value as Record<string, unknown>
}

function parsePolicy(value: unknown): FirewallToggles['defaultIncoming'] {
  if (value === null || value === undefined) return null
  return value === 'allow' ? 'allow' : value === 'limit' ? 'limit' : 'deny'
}

function parseTogglesRow(togglesRow: Record<string, unknown>): FirewallToggles {
  if (typeof togglesRow.firewallEnabled !== 'boolean' || typeof togglesRow.pingBlocked !== 'boolean') {
    throw new Error('防火墙开关响应无效')
  }
  return {
    firewallEnabled: togglesRow.firewallEnabled,
    pingBlocked: togglesRow.pingBlocked,
    defaultIncoming: parsePolicy(togglesRow.defaultIncoming),
    defaultOutgoing: parsePolicy(togglesRow.defaultOutgoing),
  }
}

/** 校验 GET / 响应：开关与规则数组（数组内逐条校验，形状漂移不整批进 store）。 */
export function parseFirewallOverviewResponse(body: unknown): FirewallOverview {
  const row = asObject(body)
  const toggles = parseTogglesRow(asObject(row.toggles))
  if (!Array.isArray(row.rules)) {
    throw new Error('防火墙规则响应无效：应为数组')
  }
  return { toggles, rules: row.rules.map((rule) => parseFirewallRule(rule)) }
}

function parseTogglesResponse(body: unknown): FirewallToggles {
  return parseTogglesRow(asObject(asObject(body).toggles))
}

/** 枚举字段校验：取值必须落在契约常量表里，漂移即拒。 */
function isEnumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** 可空字符串字段：允许 string 或 null，其它类型即拒。 */
function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

/** 端口规则逐字段校验。 */
/** 校验端口自动开放结果（创建网站/数据库响应里的可空字段）；null 表示本次未联动。 */
export function parseFirewallPortSync(value: unknown): FirewallPortSync | null {
  if (value === null) return null
  const row = asObject(value)
  if (
    (row.state !== 'opened' && row.state !== 'skipped' && row.state !== 'failed') ||
    typeof row.port !== 'number' ||
    (row.detail !== null && typeof row.detail !== 'string')
  ) {
    throw new Error('防火墙端口开放结果响应无效')
  }
  return { state: row.state, port: row.port, detail: row.detail as string | null }
}

export function parseFirewallRule(value: unknown): FirewallRule {
  const row = asObject(value)
  if (
    typeof row.id !== 'string' ||
    !isEnumValue(FIREWALL_PROTOCOLS, row.protocol) ||
    typeof row.port !== 'number' ||
    (typeof row.portTo !== 'number' && row.portTo !== null) ||
    !isEnumValue(FIREWALL_ADDRESS_FAMILIES, row.family) ||
    !isEnumValue(FIREWALL_RULE_STATUSES, row.status) ||
    !isEnumValue(FIREWALL_POLICIES, row.policy) ||
    !isEnumValue(FIREWALL_DIRECTIONS, row.direction) ||
    typeof row.source !== 'string' ||
    !isNullableString(row.note) ||
    !isNullableString(row.updatedAt)
  ) {
    throw new Error('防火墙端口规则响应无效')
  }
  return row as unknown as FirewallRule
}

/** IP 规则逐字段校验。 */
export function parseFirewallIpRule(value: unknown): FirewallIpRule {
  const row = asObject(value)
  if (
    typeof row.id !== 'string' ||
    typeof row.source !== 'string' ||
    !isEnumValue(FIREWALL_ADDRESS_FAMILIES, row.family) ||
    !isEnumValue(FIREWALL_POLICIES, row.policy) ||
    !isNullableString(row.note) ||
    !isNullableString(row.updatedAt)
  ) {
    throw new Error('防火墙 IP 规则响应无效')
  }
  return row as unknown as FirewallIpRule
}

/** 端口转发逐字段校验。 */
export function parseFirewallForwardRule(value: unknown): FirewallForwardRule {
  const row = asObject(value)
  if (
    typeof row.id !== 'string' ||
    !isEnumValue(FIREWALL_PROTOCOLS, row.protocol) ||
    typeof row.port !== 'number' ||
    (typeof row.portTo !== 'number' && row.portTo !== null) ||
    typeof row.targetHost !== 'string' ||
    typeof row.targetPort !== 'number' ||
    !isNullableString(row.note) ||
    !isNullableString(row.updatedAt)
  ) {
    throw new Error('防火墙端口转发响应无效')
  }
  return row as unknown as FirewallForwardRule
}

/** 校验 POST/PUT /rules 响应：单条端口规则。 */
export function parseRuleResponse(body: unknown): FirewallRule {
  return parseFirewallRule(asObject(asObject(body).rule))
}

/** 校验 POST/PUT /ip-rules 响应：单条 IP 规则。 */
export function parseIpRuleResponse(body: unknown): FirewallIpRule {
  return parseFirewallIpRule(asObject(asObject(body).rule))
}

/** 校验 POST/PUT /forwards 响应：单条端口转发。 */
export function parseForwardResponse(body: unknown): FirewallForwardRule {
  return parseFirewallForwardRule(asObject(asObject(body).rule))
}

/** 校验 GET /ip-rules 响应：规则数组。 */
export function parseIpRulesResponse(body: unknown): readonly FirewallIpRule[] {
  const rules = asObject(body).rules
  if (!Array.isArray(rules)) {
    throw new Error('防火墙 IP 规则列表响应无效：应为数组')
  }
  return rules.map((rule) => parseFirewallIpRule(rule))
}

/** 校验 GET /forwards 响应：转发数组。 */
export function parseForwardRulesResponse(body: unknown): readonly FirewallForwardRule[] {
  const rules = asObject(body).rules
  if (!Array.isArray(rules)) {
    throw new Error('防火墙端口转发列表响应无效：应为数组')
  }
  return rules.map((rule) => parseFirewallForwardRule(rule))
}

/** 校验 GET /scan 及防扫描写动作的响应：开关、配置、统计与封锁名单逐字段核对。 */
export function parseScanResponse(body: unknown): FirewallScanProtection {
  const row = asObject(body)
  if (typeof row.enabled !== 'boolean') {
    throw new Error('防火墙防扫描开关响应无效')
  }
  const configRow = asObject(row.config)
  if (
    !Array.isArray(configRow.ports) ||
    configRow.ports.some((port) => typeof port !== 'number') ||
    typeof configRow.windowSeconds !== 'number' ||
    typeof configRow.hitCount !== 'number' ||
    typeof configRow.banSeconds !== 'number'
  ) {
    throw new Error('防火墙防扫描配置响应无效')
  }
  const config = configRow as unknown as FirewallScanConfig
  const statsRow = asObject(row.stats)
  if (
    typeof statsRow.totalBlockedIps !== 'number' ||
    typeof statsRow.totalFailedConnections !== 'number' ||
    typeof statsRow.currentBlockedIps !== 'number' ||
    typeof statsRow.currentFailedConnections !== 'number'
  ) {
    throw new Error('防火墙防扫描统计响应无效')
  }
  if (!Array.isArray(row.blocked)) {
    throw new Error('防火墙防扫描封锁列表响应无效：应为数组')
  }
  const blocked = row.blocked.map((entry) => {
    const item = asObject(entry)
    if (typeof item.ip !== 'string' || typeof item.blockedAt !== 'string') {
      throw new Error('防火墙防扫描封锁条目响应无效')
    }
    return { ip: item.ip, blockedAt: item.blockedAt }
  })
  return {
    enabled: row.enabled,
    config,
    stats: statsRow as unknown as FirewallScanProtection['stats'],
    blocked,
  }
}

async function requestJson(baseUrl: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(baseUrl, init)
  } catch {
    throw new Error('防火墙请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `防火墙请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('防火墙响应不是有效 JSON')
  }
}

function ruleInputBody(input: FirewallRuleInput): string {
  return JSON.stringify(input)
}

/** Docker 运行时的防火墙 adapter：全部动作落到 /api/security/firewall/*。 */
export function createHttpFirewallAdapter(baseUrl = '/api/security/firewall'): FirewallAdapter {
  return {
    async list() {
      const overview = parseFirewallOverviewResponse(await requestJson(baseUrl))
      return overview.rules
    },

    async toggles() {
      return parseFirewallOverviewResponse(await requestJson(baseUrl)).toggles
    },

    async setToggles(toggles) {
      return parseTogglesResponse(
        await requestJson(`${baseUrl}/toggles`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toggles),
        }),
      )
    },

    async create(input) {
      return parseRuleResponse(
        await requestJson(`${baseUrl}/rules`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ruleInputBody(input),
        }),
      )
    },

    async update(ruleId, input) {
      return parseRuleResponse(
        await requestJson(`${baseUrl}/rules/${encodeURIComponent(ruleId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: ruleInputBody(input),
        }),
      )
    },

    async remove(ruleId) {
      await requestJson(`${baseUrl}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
    },

    async importRules(inputs) {
      const body = await requestJson(`${baseUrl}/rules/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: inputs }),
      })
      const row = asObject(body)
      if (!Array.isArray(row.added)) {
        throw new Error('防火墙导入结果响应无效：应为数组')
      }
      return {
        added: row.added.map((rule) => parseFirewallRule(rule)),
        skipped: typeof row.skipped === 'number' ? row.skipped : 0,
      } satisfies FirewallImportResult
    },

    async listIpRules() {
      return parseIpRulesResponse(await requestJson(`${baseUrl}/ip-rules`))
    },

    async createIpRule(input) {
      return parseIpRuleResponse(
        await requestJson(`${baseUrl}/ip-rules`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async updateIpRule(ruleId, input) {
      return parseIpRuleResponse(
        await requestJson(`${baseUrl}/ip-rules/${encodeURIComponent(ruleId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async removeIpRule(ruleId) {
      await requestJson(`${baseUrl}/ip-rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
    },

    async listForwards() {
      return parseForwardRulesResponse(await requestJson(`${baseUrl}/forwards`))
    },

    async createForward(input) {
      return parseForwardResponse(
        await requestJson(`${baseUrl}/forwards`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async updateForward(ruleId, input) {
      return parseForwardResponse(
        await requestJson(`${baseUrl}/forwards/${encodeURIComponent(ruleId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async removeForward(ruleId) {
      await requestJson(`${baseUrl}/forwards/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
    },

    async scanProtection() {
      return parseScanResponse(await requestJson(`${baseUrl}/scan`))
    },

    async setScanProtection(enabled) {
      return parseScanResponse(
        await requestJson(`${baseUrl}/scan/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
      )
    },

    async setScanConfig(config: FirewallScanConfig) {
      return parseScanResponse(
        await requestJson(`${baseUrl}/scan/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        }),
      )
    },

    async unblockIp(ip) {
      return parseScanResponse(
        await requestJson(`${baseUrl}/scan/unblock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ip }),
        }),
      )
    },

    async syncFromSystem() {
      const body = await requestJson(`${baseUrl}/sync`, { method: 'POST' })
      const row = asObject(body)
      return { total: typeof row.total === 'number' ? row.total : 0 }
    },
  }
}

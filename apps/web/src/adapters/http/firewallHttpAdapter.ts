import type {
  FirewallForwardRule,
  FirewallImportResult,
  FirewallIpRule,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'

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

/** 校验 GET / 响应：开关与规则数组。 */
export function parseFirewallOverviewResponse(body: unknown): FirewallOverview {
  const row = asObject(body)
  const toggles = parseTogglesRow(asObject(row.toggles))
  if (!Array.isArray(row.rules)) {
    throw new Error('防火墙规则响应无效：应为数组')
  }
  return { toggles, rules: row.rules as readonly FirewallRule[] }
}

function parseTogglesResponse(body: unknown): FirewallToggles {
  return parseTogglesRow(asObject(asObject(body).toggles))
}

function parseRuleResponse(body: unknown): FirewallRule {
  return asObject(asObject(body).rule) as unknown as FirewallRule
}

function parseScanResponse(body: unknown): FirewallScanProtection {
  return body as FirewallScanProtection
}

async function requestJson(baseUrl: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(baseUrl, init)
  } catch {
    throw new Error('防火墙请求网络失败')
  }
  if (!response.ok) {
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
      return {
        added: (Array.isArray(row.added) ? row.added : []) as unknown as readonly FirewallRule[],
        skipped: typeof row.skipped === 'number' ? row.skipped : 0,
      } satisfies FirewallImportResult
    },

    async listIpRules() {
      const body = await requestJson(`${baseUrl}/ip-rules`)
      const rules = asObject(body).rules
      return (Array.isArray(rules) ? rules : []) as unknown as readonly FirewallIpRule[]
    },

    async createIpRule(input) {
      return asObject(asObject(await requestJson(`${baseUrl}/ip-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })).rule) as unknown as FirewallIpRule
    },

    async updateIpRule(ruleId, input) {
      return asObject(asObject(await requestJson(`${baseUrl}/ip-rules/${encodeURIComponent(ruleId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })).rule) as unknown as FirewallIpRule
    },

    async removeIpRule(ruleId) {
      await requestJson(`${baseUrl}/ip-rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
    },

    async listForwards() {
      const body = await requestJson(`${baseUrl}/forwards`)
      const rules = asObject(body).rules
      return (Array.isArray(rules) ? rules : []) as unknown as readonly FirewallForwardRule[]
    },

    async createForward(input) {
      return asObject(asObject(await requestJson(`${baseUrl}/forwards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })).rule) as unknown as FirewallForwardRule
    },

    async updateForward(ruleId, input) {
      return asObject(asObject(await requestJson(`${baseUrl}/forwards/${encodeURIComponent(ruleId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })).rule) as unknown as FirewallForwardRule
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

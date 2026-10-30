import { withRequestDeadline } from './requestDeadline'
import type {
  SshAuthMethods,
  SshAuthSettings,
  SshKeyMaterial,
  SshLoginCounts,
  SshLoginKey,
  SshLoginRecord,
  SshLoginStats,
  SshOverview,
  SshPasswordResetResult,
  SshPasswordStrength,
  SshRootAuth,
  SshRootLoginPolicy,
  SshServiceStatus,
} from '@elysian/contracts'
import {
  SSH_PASSWORD_STRENGTHS,
  SSH_ROOT_LOGIN_POLICIES,
  SSH_SERVICE_STATUSES,
} from '@elysian/contracts'
import type { SshAdapter, SshKeyAccount } from '../../contracts/adapters'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

/*
 * 浏览器侧同源 SSH 管理（Docker 运行时）。sshd、ssh-keygen、chpasswd 与 getent
 * 只存在于 dev/preview 的 Node 中间件，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 firewallHttpAdapter 一致。
 */

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('SSH 响应格式无效')
  }
  return value as Record<string, unknown>
}

function parseLoginCounts(windowLabel: string, value: unknown): SshLoginCounts {
  // 窗口级窄化：对象校验失败也按窗口报错，比通用的「格式无效」更能定位问题。
  if (!value || typeof value !== 'object') {
    throw new Error(`SSH 登录统计响应无效：${windowLabel}`)
  }
  const row = value as Record<string, unknown>
  if (typeof row.succeeded !== 'number' || typeof row.failed !== 'number') {
    throw new Error(`SSH 登录统计响应无效：${windowLabel}`)
  }
  return { succeeded: row.succeeded, failed: row.failed }
}

function parseLoginStats(value: unknown): SshLoginStats {
  const row = asObject(value)
  return {
    today: parseLoginCounts('今日', row.today),
    yesterday: parseLoginCounts('昨日', row.yesterday),
    last7Days: parseLoginCounts('近 7 天', row.last7Days),
  }
}

/** 校验 GET /overview 与 PUT /service-enabled 响应：开关、状态、上次变更与三窗口统计。 */
export function parseSshOverviewResponse(body: unknown): SshOverview {
  const row = asObject(body)
  if (typeof row.enabled !== 'boolean') {
    throw new Error('SSH 服务开关响应无效')
  }
  const status = row.status
  if (typeof status !== 'string' || !SSH_SERVICE_STATUSES.includes(status as SshServiceStatus)) {
    throw new Error('SSH 服务状态响应无效')
  }
  const changedAt = row.changedAt
  if (typeof changedAt !== 'string' && changedAt !== null) {
    throw new Error('SSH 上次变更时间响应无效')
  }
  return {
    enabled: row.enabled,
    status: status as SshServiceStatus,
    changedAt,
    stats: parseLoginStats(row.stats),
    ...(row.runtimeMode === undefined ? {} : { runtimeMode: parseRuntimeMode(row.runtimeMode) }),
    ...(row.logInfo === undefined ? {} : { logInfo: parseLogInfo(row.logInfo) }),
  }
}

function parseRuntimeMode(value: unknown): NonNullable<SshOverview['runtimeMode']> {
  if (value !== 'bare-metal' && value !== 'docker' && value !== 'local-demo') throw new Error('SSH 运行模式响应无效')
  return value
}
function parseLogInfo(value: unknown): NonNullable<SshOverview['logInfo']> {
  const row = asObject(value)
  if ((row.status !== 'ready' && row.status !== 'partial' && row.status !== 'unavailable') ||
      (row.warning !== null && typeof row.warning !== 'string')) throw new Error('SSH 日志状态响应无效')
  return { status: row.status, warning: row.warning }
}
function parseFirewallPort(value: unknown): NonNullable<SshAuthSettings['firewallPort']> {
  const row = asObject(value)
  if ((row.state !== 'opened' && row.state !== 'skipped' && row.state !== 'failed') || typeof row.port !== 'number' || (row.detail !== null && typeof row.detail !== 'string')) throw new Error('SSH 防火墙联动响应无效')
  return { state: row.state, port: row.port, detail: row.detail }
}

/** 校验 GET /settings、PUT /auth-methods 与 PUT /port 响应：登录方式开关与监听端口。 */
export function parseSshSettingsResponse(body: unknown): SshAuthSettings {
  const row = asObject(body)
  if (
    typeof row.passwordAuthEnabled !== 'boolean' ||
    typeof row.keyAuthEnabled !== 'boolean' ||
    typeof row.port !== 'number'
  ) {
    throw new Error('SSH 登录设置响应无效')
  }
  return {
    passwordAuthEnabled: row.passwordAuthEnabled,
    keyAuthEnabled: row.keyAuthEnabled,
    port: row.port,
    ...(row.firewallPort === undefined ? {} : { firewallPort: parseFirewallPort(row.firewallPort) }),
  }
}

/** 密钥材料的公共部分：私钥只在创建响应里出现，这里容忍缺失。 */
function parseKeyMaterial(value: unknown): SshKeyMaterial {
  const row = asObject(value)
  if (
    typeof row.algorithm !== 'string' ||
    typeof row.fingerprint !== 'string' ||
    typeof row.createdAt !== 'string' ||
    typeof row.publicKey !== 'string'
  ) {
    throw new Error('SSH 密钥材料响应无效')
  }
  return {
    algorithm: row.algorithm,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    publicKey: row.publicKey,
    privateKey: typeof row.privateKey === 'string' ? row.privateKey : undefined,
  }
}

/** 校验 GET /root-auth 与 PUT /root-login-policy 响应：策略、密钥材料与密码重置时间。 */
export function parseSshRootAuthResponse(body: unknown): SshRootAuth {
  const row = asObject(body)
  const policy = row.policy
  if (typeof policy !== 'string' || !SSH_ROOT_LOGIN_POLICIES.includes(policy as SshRootLoginPolicy)) {
    throw new Error('SSH Root 登录策略响应无效')
  }
  const passwordResetAt = row.passwordResetAt
  if (typeof passwordResetAt !== 'string' && passwordResetAt !== null) {
    throw new Error('SSH Root 密码重置时间响应无效')
  }
  return {
    policy: policy as SshRootLoginPolicy,
    key: row.key === null ? null : parseKeyMaterial(row.key),
    passwordResetAt,
  }
}

/** 校验 POST /root-password 响应：重置后的凭据快照与强度档位。 */
export function parseSshPasswordResetResponse(body: unknown): SshPasswordResetResult {
  const row = asObject(body)
  const strength = row.strength
  if (
    typeof strength !== 'string' ||
    !SSH_PASSWORD_STRENGTHS.includes(strength as SshPasswordStrength)
  ) {
    throw new Error('SSH 密码强度响应无效')
  }
  return { auth: parseSshRootAuthResponse(row.auth), strength: strength as SshPasswordStrength }
}

function parseSshLoginKey(value: unknown): SshLoginKey {
  const row = asObject(value)
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.userId !== 'string') {
    throw new Error('SSH 密钥条目响应无效')
  }
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    ...parseKeyMaterial(row),
  }
}

/** 校验 GET /keys 响应：密钥数组（列表不带私钥）。 */
export function parseSshKeyListResponse(body: unknown): readonly SshLoginKey[] {
  const keys = asObject(body).keys
  if (!Array.isArray(keys)) {
    throw new Error('SSH 密钥列表响应无效：应为数组')
  }
  return keys.map((key) => parseSshLoginKey(key))
}

/** 校验 POST /keys 响应：创建出的那把密钥（私钥仅此一次携带）。 */
export function parseSshKeyResponse(body: unknown): SshLoginKey {
  return parseSshLoginKey(asObject(asObject(body).key))
}

/** 校验 GET /key-accounts 响应：密钥可归属的账号清单。 */
export function parseSshKeyAccountsResponse(body: unknown): readonly SshKeyAccount[] {
  const accounts = asObject(body).accounts
  if (!Array.isArray(accounts)) {
    throw new Error('SSH 归属账号响应无效：应为数组')
  }
  return accounts.map((account) => {
    const row = asObject(account)
    if (typeof row.id !== 'string' || typeof row.name !== 'string') {
      throw new Error('SSH 归属账号条目响应无效')
    }
    return { id: row.id, name: row.name }
  })
}

/** 校验 GET /login-records 响应：按时间倒序的登录事实。 */
export function parseSshLoginRecordsResponse(body: unknown): readonly SshLoginRecord[] {
  const records = asObject(body).records
  if (!Array.isArray(records)) {
    throw new Error('SSH 登录记录响应无效：应为数组')
  }
  return records.map((record) => {
    const row = asObject(record)
    if (
      typeof row.id !== 'string' ||
      typeof row.ip !== 'string' ||
      typeof row.port !== 'number' ||
      typeof row.at !== 'string' ||
      typeof row.user !== 'string' ||
      (row.result !== 'succeeded' && row.result !== 'failed')
    ) {
      throw new Error('SSH 登录记录条目响应无效')
    }
    return {
      id: row.id,
      ip: row.ip,
      port: row.port,
      at: row.at,
      user: row.user,
      result: row.result,
    }
  })
}

function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  return withRequestDeadline(init, (bounded) => readJson(url, bounded))
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchWithSession(url, init)
  } catch {
    throw new Error('SSH 请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `SSH 请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('SSH 响应不是有效 JSON')
  }
}

/** Docker 运行时的 SSH adapter：全部动作落到 /api/security/ssh/*。 */
export function createHttpSshAdapter(baseUrl = '/api/security/ssh'): SshAdapter {
  return {
    async overview() {
      return parseSshOverviewResponse(await requestJson(`${baseUrl}/overview`))
    },

    async settings() {
      return parseSshSettingsResponse(await requestJson(`${baseUrl}/settings`))
    },

    async rootAuth() {
      return parseSshRootAuthResponse(await requestJson(`${baseUrl}/root-auth`))
    },

    async setServiceEnabled(enabled) {
      return parseSshOverviewResponse(
        await requestJson(`${baseUrl}/service-enabled`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
      )
    },

    async setAuthMethods(methods: SshAuthMethods) {
      return parseSshSettingsResponse(
        await requestJson(`${baseUrl}/auth-methods`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(methods),
        }),
      )
    },

    async setPort(port) {
      return parseSshSettingsResponse(
        await requestJson(`${baseUrl}/port`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
        }),
      )
    },

    async saveRootLoginPolicy(policy) {
      return parseSshRootAuthResponse(
        await requestJson(`${baseUrl}/root-login-policy`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ policy }),
        }),
      )
    },

    async resetRootPassword(password) {
      return parseSshPasswordResetResponse(
        await requestJson(`${baseUrl}/root-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        }),
      )
    },

    async createRootKey() {
      return parseSshRootAuthResponse(
        await requestJson(`${baseUrl}/root-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
    },

    async listKeys() {
      return parseSshKeyListResponse(await requestJson(`${baseUrl}/keys`))
    },

    async keyAccounts() {
      return parseSshKeyAccountsResponse(await requestJson(`${baseUrl}/key-accounts`))
    },

    async listLoginRecords() {
      return parseSshLoginRecordsResponse(await requestJson(`${baseUrl}/login-records`))
    },

    async createKey(input) {
      return parseSshKeyResponse(
        await requestJson(`${baseUrl}/keys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async removeKey(keyId) {
      await requestJson(`${baseUrl}/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' })
    },
  }
}

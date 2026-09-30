import type { HostUser, HostUserLoginMethod, HostUserStatus } from '@elysian/contracts'
import { HOST_USER_LOGIN_METHODS, HOST_USER_STATUSES } from '@elysian/contracts'
import type { UserAdapter } from '../../contracts/adapters'
import { reportUnauthorized } from './unauthorized'

/*
 * 浏览器侧同源主机账号管理（Docker 运行时）。useradd/usermod/userdel/gpasswd/chpasswd
 * 只存在于 dev/preview 的 Node 中间件，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 sshHttpAdapter 一致。createdAt 在真实实现里恒为 null（/etc/passwd 不记
 * 账号创建时间），契约允许 string|null，两种都放行。
 */

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('主机账号响应格式无效')
  }
  return value as Record<string, unknown>
}

/** 校验单个账号条目：六字段齐全，登录方式与状态限契约枚举，note 与 createdAt 容忍 null。 */
export function parseHostUser(value: unknown): HostUser {
  const row = asObject(value)
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.isAdmin !== 'boolean') {
    throw new Error('主机账号条目响应无效')
  }
  const loginMethod = row.loginMethod
  if (
    typeof loginMethod !== 'string' ||
    !HOST_USER_LOGIN_METHODS.includes(loginMethod as HostUserLoginMethod)
  ) {
    throw new Error('主机账号登录方式响应无效')
  }
  const status = row.status
  if (typeof status !== 'string' || !HOST_USER_STATUSES.includes(status as HostUserStatus)) {
    throw new Error('主机账号状态响应无效')
  }
  const note = row.note
  if (typeof note !== 'string' && note !== null) {
    throw new Error('主机账号备注响应无效')
  }
  const createdAt = row.createdAt
  if (typeof createdAt !== 'string' && createdAt !== null) {
    throw new Error('主机账号创建时间响应无效')
  }
  return {
    id: row.id,
    name: row.name,
    isAdmin: row.isAdmin,
    loginMethod: loginMethod as HostUserLoginMethod,
    status: status as HostUserStatus,
    note,
    createdAt,
  }
}

/** 校验 GET / 响应：账号数组（真实实现按名字升序，createdAt 恒为 null）。 */
export function parseHostUserListResponse(body: unknown): readonly HostUser[] {
  const users = asObject(body).users
  if (!Array.isArray(users)) {
    throw new Error('主机账号列表响应无效：应为数组')
  }
  return users.map((user) => parseHostUser(user))
}

/** 校验 POST / 与 PUT /:id 响应：写操作完成后回读出的那一个账号。 */
export function parseHostUserResponse(body: unknown): HostUser {
  return parseHostUser(asObject(asObject(body).user))
}

/** 校验 DELETE /:id 响应：只确认删除落盘，不携带账号数据。 */
export function parseHostUserRemoveResponse(body: unknown): void {
  if (asObject(body).ok !== true) {
    throw new Error('主机账号删除响应无效')
  }
}

/** 校验 POST /sync 响应：同步后的账号总数。 */
export function parseHostUserSyncResponse(body: unknown): { total: number } {
  const total = asObject(body).total
  if (typeof total !== 'number') {
    throw new Error('主机账号同步响应无效')
  }
  return { total }
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('主机账号请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `主机账号请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('主机账号响应不是有效 JSON')
  }
}

/**
 * Docker 运行时的主机账号 adapter：全部动作落到 /api/security/users/*。
 * 密码只随请求体（JSON）下发，绝不进 URL；id（即用户名）统一 encodeURIComponent。
 */
export function createHttpUsersAdapter(baseUrl = '/api/security/users'): UserAdapter {
  return {
    async list() {
      return parseHostUserListResponse(await requestJson(`${baseUrl}/`))
    },

    async create(input) {
      return parseHostUserResponse(
        await requestJson(`${baseUrl}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async update(userId, input) {
      return parseHostUserResponse(
        await requestJson(`${baseUrl}/${encodeURIComponent(userId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async remove(userId) {
      parseHostUserRemoveResponse(
        await requestJson(`${baseUrl}/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
      )
    },

    async syncFromSystem() {
      return parseHostUserSyncResponse(
        await requestJson(`${baseUrl}/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      )
    },
  }
}

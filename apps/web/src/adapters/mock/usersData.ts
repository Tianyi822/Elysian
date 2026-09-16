import type { HostUser, HostUserInput } from '@elysian/contracts'
import { isValidHostUserName } from '@elysian/contracts'

/*
 * 主机账号演示数据集：几个按用途命名的系统账号，权限与分组沿用 Linux 的模型。
 * 种子值手工固定，按创建时间倒序排列（与列表的口径一致）；会话内的增删改落在这份内存数据上，
 * 刷新回到种子状态。
 */

export const SEED_HOST_USERS: readonly HostUser[] = [
  {
    id: 'user-deploy',
    name: 'deploy',
    isAdmin: true,
    loginMethod: 'key',
    status: 'active',
    note: '发布流程自动化使用',
    createdAt: '2025-06-20T10:12:00+08:00',
  },
  {
    id: 'user-monitor',
    name: 'monitor',
    isAdmin: false,
    loginMethod: 'key',
    status: 'active',
    note: '抓取指标与告警脚本',
    createdAt: '2025-05-05T09:30:00+08:00',
  },
  {
    id: 'user-lisi',
    name: 'lisi',
    isAdmin: false,
    loginMethod: 'password-or-key',
    status: 'active',
    note: null,
    createdAt: '2025-04-02T14:05:31+08:00',
  },
  {
    id: 'user-wangwu',
    name: 'wangwu',
    isAdmin: false,
    loginMethod: 'key',
    status: 'active',
    note: '运维值班账号',
    createdAt: '2025-03-12T09:20:14+08:00',
  },
  {
    id: 'user-zhangsan',
    name: 'zhangsan',
    isAdmin: false,
    loginMethod: 'password',
    status: 'disabled',
    note: '已离职，待清理',
    createdAt: '2025-02-18T10:41:07+08:00',
  },
  {
    id: 'user-ops',
    name: 'ops',
    isAdmin: true,
    loginMethod: 'key',
    status: 'active',
    note: 'CI 发布使用',
    createdAt: '2025-01-06T08:15:00+08:00',
  },
  {
    id: 'user-backup',
    name: 'backup',
    isAdmin: false,
    // 账号正常但不允许登录：只跑备份脚本，与「账号已停用」是两回事。
    loginMethod: 'none',
    status: 'active',
    note: '只跑备份脚本，不允许登录',
    createdAt: '2024-12-20T17:33:52+08:00',
  },
  {
    id: 'user-audit',
    name: 'audit',
    isAdmin: false,
    // 登录方式仍是密钥，但账号已停用——拦住它的是状态，不是认证方式。
    loginMethod: 'key',
    status: 'disabled',
    note: '外部审计账号，已停用',
    createdAt: '2024-10-15T16:40:00+08:00',
  },
]

let users: HostUser[] = SEED_HOST_USERS.map((user) => ({ ...user }))

/** 把演示数据推回种子状态。演示数据只在内存里，「重置演示数据」与测试隔离都经这里。 */
export function resetHostUsers(): void {
  users = SEED_HOST_USERS.map((user) => ({ ...user }))
}

export function getHostUsers(): readonly HostUser[] {
  return users.map((user) => ({ ...user }))
}

export function findHostUserByName(name: string): HostUser | undefined {
  return users.find((user) => user.name === name)
}

export function findHostUserById(userId: string): HostUser | undefined {
  return users.find((user) => user.id === userId)
}

/** 新账号插到最前：列表按创建时间倒序，刚建的账号就该在第一条。 */
export function addHostUser(name: string, input: HostUserInput, createdAt: string): HostUser {
  const user: HostUser = { id: `user-${name}`, name, createdAt, ...input }
  users = [user, ...users]
  return { ...user }
}

export function updateHostUser(userId: string, input: HostUserInput): HostUser {
  const existing = users.find((user) => user.id === userId)
  if (!existing) throw new Error(`未找到主机账号 ${userId}`)
  const next: HostUser = { ...existing, ...input }
  users = users.map((user) => (user.id === userId ? next : user))
  return { ...next }
}

export function removeHostUser(userId: string): void {
  const existing = users.find((user) => user.id === userId)
  if (!existing) throw new Error(`未找到主机账号 ${userId}`)
  users = users.filter((user) => user.id !== userId)
}

export { isValidHostUserName }

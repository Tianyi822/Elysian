/*
 * 主机账号域类型与词典。这些是这台机器上的系统账号（/etc/passwd 那一层），
 * 权限与分组沿用 Linux 自己的模型：主组与用户名同名，是否属于管理员组决定能不能提权，
 * 首版不另造枚举分组。root 不在这里——它的登录策略在 SSH 管理页签的 Root 设置里单独管。
 */

export type HostUserStatus = 'active' | 'disabled'

export const HOST_USER_STATUSES = [
  'active',
  'disabled',
] as const satisfies readonly HostUserStatus[]

export const HOST_USER_STATUS_LABELS: Record<HostUserStatus, string> = {
  active: '正常',
  disabled: '已停用',
}

/** 单个账号允许的认证方式。 */
export type HostUserLoginMethod = 'password' | 'key' | 'password-or-key' | 'none'

export const HOST_USER_LOGIN_METHODS = [
  'password',
  'key',
  'password-or-key',
  'none',
] as const satisfies readonly HostUserLoginMethod[]

export const HOST_USER_LOGIN_METHOD_LABELS: Record<HostUserLoginMethod, string> = {
  password: '密码',
  key: '密钥',
  'password-or-key': '密码或密钥',
  none: '禁止登录',
}

/**
 * 主机账号。状态与登录方式是两个层面的事实：状态说这个账号还能不能使用，
 * 登录方式说允许用哪种方式认证。账号停用后，无论登录方式如何都登录不了。
 */
export type HostUser = {
  id: string
  /** 用户名，同时是主组名——Linux 不指定 -g 时就是这么建的。 */
  name: string
  /** 是否属于管理员组，决定能不能提权。 */
  isAdmin: boolean
  loginMethod: HostUserLoginMethod
  status: HostUserStatus
  /** 备注为空时界面显示 —。 */
  note: string | null
  /** 创建时间（ISO）。 */
  createdAt: string
}

/** 新建或修改账号的输入。用户名只在创建时确定：Linux 里改名等于新建再迁移，首版不做。 */
export type HostUserInput = {
  loginMethod: HostUserLoginMethod
  status: HostUserStatus
  isAdmin: boolean
  note: string | null
}

export const HOST_USER_NAME_MAX_LENGTH = 32

/**
 * 用户名判据：沿用 Linux 的取名习惯——小写字母或下划线开头，
 * 其余为小写字母、数字、下划线或连字符，最长 32 个字符。
 * 表单与 mock 侧共用同一判据，不在两处各写一遍。
 */
export function isValidHostUserName(name: string): boolean {
  return name.length <= HOST_USER_NAME_MAX_LENGTH && /^[a-z_][a-z0-9_-]*$/.test(name)
}

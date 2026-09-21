/*
 * SSH 域类型与词典。本期只做本机 SSH 服务的演示呈现：
 * 服务启停、登录方式、监听端口、Root 登录策略与 Root 凭据都属于系统级变更，
 * 由未来接入的执行层筛选与执行，这里的类型只描述界面需要呈现的事实。
 * Root 登录策略的取值沿用 sshd_config 的 PermitRootLogin；界面文案只取本文件的中文标签表。
 */

export type SshServiceStatus = 'running' | 'stopped'

export const SSH_SERVICE_STATUSES = [
  'running',
  'stopped',
] as const satisfies readonly SshServiceStatus[]

export const SSH_SERVICE_STATUS_LABELS: Record<SshServiceStatus, string> = {
  running: '运行中',
  stopped: '已停止',
}

/** 一次登录统计：成功与失败各计一次。 */
export type SshLoginCounts = {
  succeeded: number
  failed: number
}

/**
 * 登录统计的三个窗口。服务未启用时界面不给统计——没有服务就没有登录记录，
 * 空态由界面按 `SshOverview.enabled` 决定，而不是把统计置成一份零值。
 */
export type SshLoginStats = {
  today: SshLoginCounts
  yesterday: SshLoginCounts
  last7Days: SshLoginCounts
}

export type SshLoginWindow = keyof SshLoginStats

/** 统计窗口清单，界面按此顺序渲染三行。 */
export const SSH_LOGIN_WINDOWS = [
  'today',
  'yesterday',
  'last7Days',
] as const satisfies readonly SshLoginWindow[]

export const SSH_LOGIN_WINDOW_LABELS: Record<SshLoginWindow, string> = {
  today: '今日',
  yesterday: '昨日',
  last7Days: '近 7 天',
}

/** 一次登录的结果。 */
export type SshLoginResult = 'succeeded' | 'failed'

export const SSH_LOGIN_RESULTS = [
  'succeeded',
  'failed',
] as const satisfies readonly SshLoginResult[]

export const SSH_LOGIN_RESULT_LABELS: Record<SshLoginResult, string> = {
  succeeded: '成功',
  failed: '失败',
}

/**
 * 一条 SSH 登录记录：谁、从哪个地址的哪个端口、什么时候、结果如何。
 * 端口是客户端的源端口，不是服务端的监听端口——排查爆破时先看来源地址与端口，再看账号。
 */
export type SshLoginRecord = {
  id: string
  /** 来源 IP。 */
  ip: string
  /** 客户端源端口。 */
  port: number
  /** 登录时间（ISO）。 */
  at: string
  /** 登录使用的账号。 */
  user: string
  result: SshLoginResult
}

/** 服务概况：开关、状态、上次启停时间与登录统计。 */
export type SshOverview = {
  enabled: boolean
  status: SshServiceStatus
  /** 上次启停时间（ISO）；从未由面板启停过时为 null，界面显示 —。 */
  changedAt: string | null
  stats: SshLoginStats
}

/** 登录方式开关。 */
export type SshAuthMethods = {
  passwordAuthEnabled: boolean
  keyAuthEnabled: boolean
}

/** 登录方式与监听端口。 */
export type SshAuthSettings = SshAuthMethods & {
  port: number
}

export const SSH_DEFAULT_PORT = 22

/** 端口是否可用：整数且落在 1-65535。表单与 mock 侧共用同一判据，不在两处各写一遍。 */
export function isValidSshPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Root 登录策略。 */
export type SshRootLoginPolicy = 'no' | 'prohibit-password' | 'forced-commands-only' | 'yes'

export const SSH_ROOT_LOGIN_POLICIES = [
  'no',
  'prohibit-password',
  'forced-commands-only',
  'yes',
] as const satisfies readonly SshRootLoginPolicy[]

export const SSH_ROOT_LOGIN_POLICY_LABELS: Record<SshRootLoginPolicy, string> = {
  no: '禁止 Root 登录',
  'prohibit-password': '只能密钥登录',
  'forced-commands-only': '仅允许指定命令',
  yes: '允许密码登录',
}

/** 一份密钥材料的公共部分：算法、指纹、生成时间与公钥文本。 */
export type SshKeyMaterial = {
  /** 密钥类型与长度，如 ssh-ed25519 256。 */
  algorithm: string
  /** SHA256 指纹。 */
  fingerprint: string
  /** 生成时间（ISO）。 */
  createdAt: string
  /** 单行公钥文本：创建时随密钥落在本机授权文件里，界面不展示也不提供复制。 */
  publicKey: string
  /**
   * 私钥文本：仅在创建/生成响应里一次性携带，列表与查看不返回——真实私钥只此一次下发，之后不再可取。
   * mock 演示侧同样只在创建/生成响应携带演示材料；依赖本字段的代码必须容忍 undefined。
   */
  privateKey?: string
}

/** Root 密钥：主机 root 账号那一把。 */
export type SshRootKey = SshKeyMaterial

/**
 * 登录密钥：用户自建、可自定义名称的密钥对，多条并存，用于登录本机。
 * 它与 Root 密钥分开管理——Root 密钥是主机自带的、按账号看的；登录密钥按人/按用途命名的。
 * 每把密钥归属一个主机账号：公钥写进那个账号的 authorized_keys，界面按 userId 去账号数据集现取账号名。
 */
export type SshLoginKey = SshKeyMaterial & {
  id: string
  name: string
  /** 归属账号的 id；账号被删除时它的密钥一并失效。 */
  userId: string
}

export const SSH_KEY_NAME_MAX_LENGTH = 32

/** 密钥名称是否可用：去空白后非空且不超上限。表单与 mock 侧共用同一判据，不在两处各写一遍。 */
export function isValidSshKeyName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= SSH_KEY_NAME_MAX_LENGTH
}

export type SshRootAuth = {
  policy: SshRootLoginPolicy
  /**
   * Root 的授权密钥材料，取自 root 账号 authorized_keys 的第一行；
   * 那里没有任何公钥时为 null，表示尚未生成，界面显示「尚未生成」而不是编造材料。
   */
  key: SshRootKey | null
  /** 上次重置 Root 密码的时间（ISO）；本会话内没重置过时为 null，界面显示 —。 */
  passwordResetAt: string | null
}

/** 密码强度三档。 */
export type SshPasswordStrength = 'weak' | 'medium' | 'strong'

export const SSH_PASSWORD_STRENGTHS = [
  'weak',
  'medium',
  'strong',
] as const satisfies readonly SshPasswordStrength[]

export const SSH_PASSWORD_STRENGTH_LABELS: Record<SshPasswordStrength, string> = {
  weak: '弱',
  medium: '中',
  strong: '强',
}

/**
 * 演示级的弱密码判定：长度与字符类别两条尺子，确定性、无随机。
 * 它只用来在重置 Root 密码时挡住明显过弱的取值；真实的强度策略与阈值属于 harness 层，接入期与策略一起定。
 * 界面用它做即时反馈，mock 侧用同一次判定拒绝弱密码，两侧不会出现两种口径。
 */
export function evaluateSshPasswordStrength(password: string): SshPasswordStrength {
  const classes = characterClassCount(password)
  if (password.length >= 12 && classes >= 3) return 'strong'
  if (password.length >= 8 && classes >= 2) return 'medium'
  return 'weak'
}

/** 小写、大写、数字、符号四类的命中数。 */
function characterClassCount(password: string): number {
  let classes = 0
  if (/[a-z]/.test(password)) classes += 1
  if (/[A-Z]/.test(password)) classes += 1
  if (/[0-9]/.test(password)) classes += 1
  if (/[^A-Za-z0-9]/.test(password)) classes += 1
  return classes
}

/** 重置 Root 密码的结果：重置后的凭据快照，以及本次判定的强度。判定为弱密码时 mock 侧直接拒绝，不会走到这里。 */
export type SshPasswordResetResult = {
  auth: SshRootAuth
  strength: SshPasswordStrength
}

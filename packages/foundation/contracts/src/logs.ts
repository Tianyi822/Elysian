/*
 * 日志域类型与词典。本期只做平台运行日志与平台登录日志的演示呈现：
 * 真实日志属于主机与服务的事实，由未来接入的采集层提供，
 * 这里的类型只描述界面需要呈现的事实。
 */

export type LoginLogStatus = 'success' | 'failure'

export const LOGIN_LOG_STATUSES = [
  'success',
  'failure',
] as const satisfies readonly LoginLogStatus[]

export const LOGIN_LOG_STATUS_LABELS: Record<LoginLogStatus, string> = {
  success: '登录成功',
  failure: '登录失败',
}

export type LoginLogEntry = {
  id: string
  /** 登录来源 IP，如 114.139.238.152。 */
  ip: string
  /** IP 归属地，如「中国电信 中国 贵州 贵阳」。 */
  location: string
  /** 登录客户端的 User-Agent 原文，表格里整串截断展示。 */
  userAgent: string
  status: LoginLogStatus
  /** 登录时间（ISO，不带时区偏移，与仓库其他种子时间同一写法）。 */
  time: string
}

/** 平台运行日志快照：整份日志文本与它的 UTF-8 字节大小。 */
export type RuntimeLogSnapshot = {
  /** 日志原文，按 \n 分行，行内自带时间戳与级别标记。 */
  content: string
  /** 字节大小，界面据此展示「日志大小」。 */
  sizeBytes: number
}

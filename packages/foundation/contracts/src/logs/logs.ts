/*
 * 登录日志的类型与词典。登录日志本期仍是 mock（面板还没有登录功能），形状保持演示态。
 * 平台真的落盘的两类日志——运行日志与操作日志——在 ./platformLogs.ts，不在这里。
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

/*
 * 登录日志的类型与词典。
 * Docker 运行时由服务端在每次 POST /api/auth/login 之后写入
 * ~/.Elysian/logs/platform/login/，界面经 GET /api/logs/login 读同一份文件。
 * 它不是 PlatformLogCategory：不进「日志大小」合计，也不能从界面清空
 * （保留由服务端按窗口与总量巡检）。宿主机本地开发仍读内存种子。
 * 运行日志与操作日志的类型在 ./platformLogs.ts。
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
  /** 登录来源 IP。真实记录是 TCP 对端；演示种子是样例公网地址。 */
  ip: string
  /**
   * IP 归属地。真实记录只标「本机」「内网」或「未知」（不查询外部地址库）；
   * 演示种子仍是运营商归属地样例。
   */
  location: string
  /** 登录客户端的 User-Agent 原文，表格里整串截断展示。 */
  userAgent: string
  status: LoginLogStatus
  /** 登录时间。真实记录是带 Z 的 ISO；演示种子不带时区偏移。 */
  time: string
}

/** 登录日志列表响应。条目时间倒序（新 → 旧）。 */
export type LoginLogListReport = {
  entries: readonly LoginLogEntry[]
  /** 因条数上限或读取字节预算未读全（更旧的内容还在磁盘上）。 */
  truncated: boolean
  /** 无法解析而被跳过的行数（正常为 0）。 */
  skippedLines: number
  /** 读取失败而被整份跳过的文件数（正常为 0）。 */
  skippedFiles: number
}

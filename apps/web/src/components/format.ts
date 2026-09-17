/**
 * 时间格式化统一走固定时区，保证在任何机器上渲染结果一致，测试也不受本地时区影响。
 */
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso))
}

/** 只到日的日期（`2026-12-20`），用于到期时间这类不含时刻的字段。 */
const DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function formatDate(iso: string): string {
  return DATE_FORMATTER.format(new Date(iso))
}

/**
 * 精确到秒、带年份的登录时间，形态与 sshd 日志一致（`2026-09-07 14:10:53`）。
 * 用的是连字符形态的固定写法：登录记录按时间排查时需要秒与年份，
 * 而 zh-CN 在年月日之间用斜杠，跟日志里的时间对不上。
 */
const LOGIN_TIME_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatLoginTime(iso: string): string {
  return LOGIN_TIME_FORMATTER.format(new Date(iso))
}

/** 运行时长：3 天 1 小时 / 2 小时 / 40 分钟；未启动为 —。 */
export function formatUptime(startedAt: string | undefined, now: Date): string {
  if (!startedAt) return '—'
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时`
  return `${minutes} 分钟`
}

/** 日志体积：字节格式化成 KB/MB，保留两位小数，形态与参照产品的「13.41 KB」一致。 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

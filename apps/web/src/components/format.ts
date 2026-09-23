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

/**
 * 登录来源的显示文案：回环地址（sshd 视角的本机自连，如容器内联调产生的 ::1/127.0.0.1）
 * 统一显示「本机」，原始地址留在悬停提示里；其余地址原样呈现，不虚构来源。
 */
export function formatLoginIp(ip: string): string {
  return ip === '::1' || ip === '127.0.0.1' ? '本机' : ip
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

/*
 * 日志体积不在这里格式化：唯一口径是契约的 formatLogBytes（工具栏「日志大小」、
 * 清空确认与保留说明三处共用）。留两套写法会让同一屏出现 13.39 KB 与 13.40 KB。
 */

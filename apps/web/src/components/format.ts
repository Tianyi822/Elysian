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

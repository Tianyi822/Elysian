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

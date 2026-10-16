import { LOG_ENTRY_FETCH_LIMIT } from '@elysian/contracts'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'

export function useLogReportNotifications(label: string, report: {
  ready: boolean
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  olderError?: string
  failedWrites?: number
  trimmedBySize?: boolean
}) {
  const details = []
  if (report.truncated) details.push(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条`)
  if (report.skippedLines > 0) details.push(`有 ${report.skippedLines} 行无法解析，已跳过`)
  if (report.skippedFiles > 0) details.push(`有 ${report.skippedFiles} 个日志文件读取失败，已跳过`)
  if (report.trimmedBySize) details.push('日志已超出量上限，较早的记录被自动清理')
  useFeedbackNotification(report.ready && details.length ? `${label}：${details.join('；')}` : undefined,
    report.skippedLines > 0 || report.skippedFiles > 0 ? 'warning' : 'info', { replace: true })
  useFeedbackNotification(report.ready && report.failedWrites ? `${label}：有 ${report.failedWrites} 条日志未能写入磁盘（服务端写盘失败）` : undefined, 'danger', { replace: true })
  useFeedbackNotification(report.olderError ? `${label}：更早的记录加载失败：${report.olderError}` : undefined)
}

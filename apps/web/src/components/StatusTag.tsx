export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'border-line bg-surface text-fg-muted',
  info: 'border-info/40 bg-info/10 text-info',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/40 bg-danger/10 text-danger',
}

/**
 * 状态标签。文字与颜色同时表达，不依赖颜色单独表达，
 * 颜色取自令牌层的语义色调。
 */
export function StatusTag({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${TONE_CLASSES[tone]}`}>
      {label}
    </span>
  )
}

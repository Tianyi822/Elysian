import { SEVERITY_LABELS } from '@elysian/contracts'
import type { IncidentStatus, Severity } from '@elysian/contracts'

/**
 * 严重等级与状态的视觉表达。两者都同时给出文字与颜色，不依赖颜色单独表达，
 * 颜色取自令牌层的四档严重等级令牌。
 */

const SEVERITY_TONE: Record<Severity, string> = {
  sev1: 'border-sev1-line bg-sev1 text-sev1-fg',
  sev2: 'border-sev2-line bg-sev2 text-sev2-fg',
  sev3: 'border-sev3-line bg-sev3 text-sev3-fg',
  sev4: 'border-sev4-line bg-sev4 text-sev4-fg',
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${SEVERITY_TONE[severity]}`}
    >
      {SEVERITY_LABELS[severity]}
    </span>
  )
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'border-line bg-surface text-fg-muted',
  info: 'border-info/40 bg-info/10 text-info',
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/40 bg-danger/10 text-danger',
}

export function StatusTag({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${TONE_CLASSES[tone]}`}>
      {label}
    </span>
  )
}

/** 事故状态到色调的映射，界面各处保持一致，避免同一状态在不同页面颜色不同。 */
export const INCIDENT_STATUS_TONE: Record<IncidentStatus, StatusTone> = {
  open: 'warning',
  analyzing: 'info',
  'awaiting-approval': 'warning',
  mitigating: 'info',
  resolved: 'success',
  closed: 'neutral',
}

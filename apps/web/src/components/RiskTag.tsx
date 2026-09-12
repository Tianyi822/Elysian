import { RISK_LEVEL_LABELS } from '@elysian/contracts'
import type { RiskLevel } from '@elysian/contracts'

/**
 * 风险等级标签。刻意带上「风险」前缀，避免与事故严重等级在同一屏里被看成一回事——
 * 两者是独立枚举，视觉上也必须能区分。
 */
const RISK_TONE: Record<RiskLevel, string> = {
  low: 'border-risk-low-line bg-risk-low text-risk-low-fg',
  medium: 'border-risk-medium-line bg-risk-medium text-risk-medium-fg',
  high: 'border-risk-high-line bg-risk-high text-risk-high-fg',
  critical: 'border-risk-critical-line bg-risk-critical text-risk-critical-fg',
}

export function RiskTag({ level }: { level: RiskLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${RISK_TONE[level]}`}
    >
      风险 {RISK_LEVEL_LABELS[level]}
    </span>
  )
}

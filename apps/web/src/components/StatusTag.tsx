import { Badge, type BadgeTone } from './easyui/Badge'

export type StatusTone = BadgeTone

/**
 * 状态标签。文字与颜色同时表达，不依赖颜色单独表达，
 * 颜色取自令牌层的语义色调。
 */
export function StatusTag({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return (
    <Badge tone={tone} dot animateChanges={false} className="status-tag shrink-0">
      {label}
    </Badge>
  )
}

import { FlaskConical } from 'lucide-react'

/**
 * 常驻演示标识。它出现在每个页面上，用来划清「演示数据」与「真实基础设施」的边界，
 * 因此不做成可关闭的提示条。
 */
export function MockDataBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">
      <FlaskConical aria-hidden size={13} />
      演示数据·未连接真实基础设施
    </span>
  )
}

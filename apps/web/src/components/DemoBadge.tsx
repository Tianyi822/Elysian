export function DemoBadge({
  as: Tag = 'span',
  className = 'text-sm text-fg-muted',
}: { as?: 'span' | 'p' | 'div'; className?: string }) {
  return <Tag role="status" className={className}>演示数据</Tag>
}

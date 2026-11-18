import clsx from 'clsx'
import { Button } from '../../components/Button'

export function LogLoadOlder({ hasMore, busy, error, onLoad, className }: {
  hasMore: boolean
  busy: boolean
  error?: string
  onLoad(): void
  className?: string
}) {
  const errorNotice = error ? (
    <p role="status" className={clsx(!hasMore && className, 'text-xs text-danger')}>
      更早的记录加载失败
    </p>
  ) : null

  if (!hasMore) return errorNotice

  return (
    <div className={clsx(className, 'flex flex-col items-start gap-2')}>
      <p className="text-xs text-fg-muted">还有更早的记录</p>
      <Button variant="outline" type="button" disabled={busy} onClick={onLoad}
        className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
      >
        {busy ? '加载中…' : '加载更早的记录'}
      </Button>
      {errorNotice}
    </div>
  )
}

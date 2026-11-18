import clsx from 'clsx'
import { Button } from '../Button'

export function StaleDataBanner({ error, onRetry, className }: {
  error: string
  onRetry: () => void
  className?: string
}) {
  return (
    <p role="alert" className={clsx(className, 'text-xs text-danger')}>
      刷新失败：{error}。已保留上次读取结果。
      <Button variant="link" type="button" className="ml-2 underline" onClick={onRetry}>重试</Button>
    </p>
  )
}

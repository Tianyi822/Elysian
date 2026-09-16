import { Inbox, Loader2, Lock, TriangleAlert } from '../icons'
import type { ReactNode } from 'react'

/**
 * 四种页面级状态。每个页面都必须能展示这四种状态，所以它们统一在这里，
 * 不允许各页面自造一套。
 */

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 rounded border border-line bg-surface p-6 text-sm text-fg-muted"
    >
      <Loader2 aria-hidden size={16} className="animate-spin" />
      {label}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded border border-line bg-surface p-6 text-center">
      <Inbox aria-hidden size={20} className="text-fg-subtle" />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-prose text-xs text-fg-muted">{description}</p> : null}
      {action}
    </div>
  )
}

export function ErrorState({
  title = '加载失败',
  description,
  onRetry,
  action,
}: {
  title?: string
  description?: string
  onRetry?: () => void
  /** 自定义恢复动作，提供时取代默认的重试按钮——有些错误重试没有意义（如路径不存在）。 */
  action?: ReactNode
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-1.5 rounded border border-danger/40 bg-surface p-6 text-center"
    >
      <TriangleAlert aria-hidden size={20} className="text-danger" />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-prose text-xs text-fg-muted">{description}</p> : null}
      {action
        ? action
        : onRetry
          ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 rounded-lg border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
              >
                重试
              </button>
            )
          : null}
    </div>
  )
}

export function NoPermissionState({
  title = '无访问权限',
  description = '当前账号没有查看这部分内容的权限。',
}: {
  title?: string
  description?: string
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded border border-line bg-surface p-6 text-center">
      <Lock aria-hidden size={20} className="text-fg-subtle" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-prose text-xs text-fg-muted">{description}</p>
    </div>
  )
}

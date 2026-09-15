import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy } from './icons'
import { useNotificationStore } from '../stores/notificationStore'

/** 复制成功后的反馈时长（毫秒）。 */
const FEEDBACK_MS = 1_500

/**
 * 复制按钮：把值写进剪贴板，成功后按钮文案短暂变成「已复制」。
 * 值本身不上屏，tooltip 说明复制的是什么；剪贴板被拒时走通知，不静默失败。
 */
export function CopyButton({
  label,
  value,
  tooltip,
  icon,
}: {
  label: string
  value: string
  tooltip: string
  icon?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      timerRef.current = window.setTimeout(() => setCopied(false), FEEDBACK_MS)
    } catch (error) {
      useNotificationStore.getState().notify({
        tone: 'danger',
        message: `复制失败：浏览器拒绝了剪贴板访问（${error instanceof Error ? error.message : '未知原因'}）`,
      })
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={tooltip}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {copied ? <Check aria-hidden size={13} /> : (icon ?? <Copy aria-hidden size={13} />)}
      {copied ? '已复制' : label}
    </button>
  )
}

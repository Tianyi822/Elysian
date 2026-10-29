import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy } from './icons'
import { useMessageStore } from '../stores/messageStore'
import { writeClipboardText } from '../utils/clipboardText'

/** 复制成功后的反馈时长（毫秒）。 */
const FEEDBACK_MS = 1_500

function notifyCopyFailed(error: unknown): void {
  useMessageStore.getState().notify({
    tone: 'danger',
    message: `复制失败：浏览器拒绝了剪贴板访问（${error instanceof Error ? error.message : '未知原因'}）`,
  })
}

/**
 * 复制到剪贴板并给出反馈的共用逻辑：
 * - `copied` 是行内反馈窗口（按钮短暂显示「已复制」）；
 * - 同时记录一条成功消息，供之后查看复制结果；
 * - 连点时清掉上一个定时器重新计时；失败记录消息，不静默；卸载时清定时器。
 */
export function useClipboardCopy(): {
  copied: boolean
  copy(value: string, label: string): Promise<void>
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const copy = async (value: string, label: string) => {
    try {
      await writeClipboardText(value)
      window.clearTimeout(timerRef.current)
      setCopied(true)
      timerRef.current = window.setTimeout(() => setCopied(false), FEEDBACK_MS)
      useMessageStore.getState().notify({ tone: 'success', message: `已复制${label}` })
    } catch (error) {
      notifyCopyFailed(error)
    }
  }

  return { copied, copy }
}

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
  const { copied, copy } = useClipboardCopy()

  return (
    <button
      type="button"
      onClick={() => void copy(value, label)}
      title={tooltip}
      className="action-button shrink-0 gap-1.5 border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {copied ? <Check aria-hidden size={13} /> : (icon ?? <Copy aria-hidden size={13} />)}
      {copied ? '已复制' : label}
    </button>
  )
}

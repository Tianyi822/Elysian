import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { Maximize2 } from '../../components/icons'

/**
 * 日志正文单元格：正文单行省略，鼠标悬停单元格或键盘聚焦时右侧浮现展开图标，
 * 点击在单元格下方弹出悬浮窗，显示完整正文与元信息。
 *
 * 三处刻意的选择：
 * - 展开图标用 `opacity-0` 而不是隐藏 DOM，所以它始终可聚焦、可被读屏发现；
 * - 单元格文本不写 `title`：原生提示会与悬浮窗抢同一块位置；
 * - 触发器是原生 button（Tooltip 套 Popover 套 button，与 MemoryMonitorBadge 同款），
 *   不用 IconButton——它不是 forwardRef、也不透传 rest props，Radix 经 Slot 传下来的
 *   ref 与 aria-* 会整份丢掉，点图标将没有任何反应。
 */
export function LogMessageCell({
  text,
  details,
  triggerLabel = '查看完整内容',
}: {
  /** 完整正文；省略只发生在视觉上，DOM 里始终是全文。 */
  text: string
  /** 悬浮窗里的元信息（时间、等级、来源等）。 */
  details?: ReactNode
  /** 展开按钮的可访问名与提示文案。 */
  triggerLabel?: string
}) {
  return (
    <td className="group/cell relative border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="block min-w-0 flex-1 truncate">{text}</span>
        <Popover.Root>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label={triggerLabel}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity hover:bg-surface-raised hover:text-fg focus-visible:opacity-100 group-hover/cell:opacity-100"
                >
                  <Maximize2 aria-hidden size={14} />
                </button>
              </Popover.Trigger>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={6}
                className="z-50 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
              >
                {triggerLabel}
                <Tooltip.Arrow className="fill-surface-raised" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              aria-label="完整日志内容"
              className="z-50 max-h-[calc(100vh-2rem)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-line bg-surface-raised p-3 text-xs shadow-lg"
            >
              {/* 正文：原样呈现（含空白），超长时在正文区内部滚动；tabIndex 兜底可聚焦。 */}
              <div
                tabIndex={-1}
                className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-fg"
              >
                {text}
              </div>
              {details}
              <div className="mt-2 flex justify-end border-t border-line pt-2">
                <CopyButton label="复制全文" value={text} tooltip="复制这条日志的完整内容" />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
    </td>
  )
}

import * as Popover from '@radix-ui/react-popover'
import type { ReactNode } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { Maximize2 } from '../../components/icons'
import { Button } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import { TOOLTIP_BODY_CLASS } from '../../components/tooltipStyles'

/**
 * 日志正文单元格：正文单行省略，鼠标悬停单元格或键盘聚焦时右侧浮现展开图标，
 * 点击在单元格下方弹出悬浮窗，显示完整正文与元信息。
 *
 * 三处刻意的选择：
 * - 展开图标用 `opacity-0` 而不是隐藏 DOM，所以它始终可聚焦、可被读屏发现；
 * - 单元格文本不写 `title`：原生提示会与悬浮窗抢同一块位置；
 * - IconButton 只提供提示，Popover 触发器继续把 ref 和 aria 属性传给原按钮。
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
    <div className="group/cell relative min-w-0 w-full">
      <div className="flex items-center gap-2">
        <span className="block min-w-0 flex-1 truncate">{text}</span>
        <Popover.Root>
          <IconButton asChild label={triggerLabel} tooltipClassName={`z-50 ${TOOLTIP_BODY_CLASS}`}>
            <Popover.Trigger asChild>
              <Button variant="ghost" size="icon"
                type="button"
                aria-label={triggerLabel}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity hover:bg-surface-raised hover:text-fg focus-visible:opacity-100 group-hover/cell:opacity-100"
              >
                <Maximize2 aria-hidden size={14} />
              </Button>
            </Popover.Trigger>
          </IconButton>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              aria-label="完整日志内容"
              className="z-50 max-h-[calc(100vh-2rem)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-control-line bg-surface-raised p-3 text-xs shadow-lg"
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
    </div>
  )
}

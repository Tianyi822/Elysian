import { TOOLTIP_CONTENT_CLASS } from './tooltipStyles'
import { RefreshCw } from './icons'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Button } from './Button'
import { cn } from './easyui/utils'

/** 区域刷新按钮：请求完成前旋转并禁用；旧内容原位保留，首次读取才显示加载态。 */

export function RefreshButton({
  onPress,
  busy = false,
  label = '刷新',
  disabled = false,
  className,
}: {
  onPress: () => void
  /** 刷新在途：图标旋转、按钮禁用、读屏播报忙。 */
  busy?: boolean
  label?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button size="icon" variant="outline" aria-label={label} aria-busy={busy || undefined} onClick={onPress}
          isLoading={busy} disabled={disabled}
          className={cn(className, 'size-8 shrink-0 rounded-full text-fg-muted hover:text-fg motion-reduce:[&_svg]:animate-none')}
          leftIcon={<RefreshCw size={14} aria-hidden />} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" sideOffset={6} className={TOOLTIP_CONTENT_CLASS}>
          {label}<Tooltip.Arrow className="fill-surface-raised" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

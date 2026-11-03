import { RefreshCw } from './icons'
import { IconButton } from './IconButton'
import type { Variant } from './IconButton'

/** 区域刷新按钮：请求完成前旋转并禁用；旧内容原位保留，首次读取才显示加载态。 */

export function RefreshButton({
  onPress,
  busy = false,
  label = '刷新',
  variant = 'solid',
  formControl = false,
  className,
}: {
  onPress: () => void
  /** 刷新在途：图标旋转、按钮禁用、读屏播报忙。 */
  busy?: boolean
  label?: string
  variant?: Variant
  formControl?: boolean
  className?: string
}) {
  return (
    <IconButton
      label={label}
      onPress={onPress}
      busy={busy}
      disabled={busy}
      variant={variant}
      formControl={formControl}
      className={className}
    >
      <RefreshCw aria-hidden size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : undefined} />
    </IconButton>
  )
}

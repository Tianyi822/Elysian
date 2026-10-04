import { RefreshCw } from './icons'
import { IconButton } from './IconButton'
import type { Variant } from './IconButton'

/**
 * 刷新接缝：一个旋转的图标按钮，加一层只属于被刷新组件自身的浅色遮罩。
 *
 * 两条规矩：
 * 1. 按钮在结果回来之前一直转，转停即内容已更新，不再另挂「正在刷新…」文字；
 * 2. 刷新不换整块内容——旧数据留在屏上透出，只由 BusyVeil 盖一层浅色遮罩示意进行中，
 *    因此任何刷新都不出现白屏。首次加载（还没有任何数据）仍走 LoadingState。
 */

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

/**
 * 组件级刷新遮罩。挂的这块内容必须是定位上下文（panel-surface 自带 relative，
 * 其余容器补一个 relative），遮罩只铺满它自己，不覆盖整页。
 */
export function BusyVeil({ busy }: { busy: boolean }) {
  if (!busy) return null
  return (
    <div className="busy-veil" aria-hidden>
      <span />
    </div>
  )
}

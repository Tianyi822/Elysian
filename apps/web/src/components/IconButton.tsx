import * as Tooltip from '@radix-ui/react-tooltip'
import type { FocusEventHandler, KeyboardEventHandler, PointerEventHandler, ReactNode } from 'react'

/**
 * 图标按钮。图标按钮必须带 tooltip，这是项目红线，所以统一从这个组件出，
 * 不允许在页面里直接写裸的图标按钮。
 *
 * solid：带边框与浅底的标准按钮；ghost：无边框无底色的弱化按钮，
 * 用于浮层卡片内的关闭等次要动作，悬停才浮现可点击感。
 * solid 的描边与底色不在这里写 utility：控件层 .icon-button-solid 用可继承的自定义属性
 * 给默认档，工具栏语境才能把它调到和同行按钮同一色阶（utility 在 utilities 层，赢不过它）。
 * danger-hover：ghost 专属，平时与 neutral 完全同色，悬停才转危险色——
 * 删除这类破坏性动作要克制，危险感留给悬停时刻，不常驻。
 */

type Tone = 'neutral' | 'danger' | 'danger-hover'
export type Variant = 'solid' | 'ghost'

const STYLES: Record<Variant, Record<Exclude<Tone, 'danger-hover'>, string>> = {
  solid: {
    neutral: 'size-7 text-fg-muted hover:text-fg',
    danger: 'size-7 text-danger hover:border-danger/50 hover:bg-danger/10',
  },
  ghost: {
    neutral: 'size-6 text-fg-subtle hover:bg-surface-raised hover:text-fg',
    danger: 'size-6 text-danger hover:bg-danger/10',
  },
}

const GHOST_DANGER_HOVER = 'size-6 text-fg-subtle hover:bg-danger/10 hover:text-danger'

function styleFor(variant: Variant, tone: Tone): string {
  if (tone === 'danger-hover') {
    // solid 不提供 hover-only-danger 形态，传了这个组合按 danger 处理。
    return variant === 'ghost' ? GHOST_DANGER_HOVER : STYLES.solid.danger
  }
  return STYLES[variant][tone]
}

export function IconButton({
  label,
  onPress,
  children,
  tone = 'neutral',
  variant = 'solid',
  tooltip = true,
  disabled = false,
  busy = false,
  formControl = false,
  className,
  onPointerDown,
  onKeyDown,
  onFocus,
  onBlur,
  tooltipSide,
}: {
  label: string
  onPress?: () => void
  children: ReactNode
  tone?: Tone
  variant?: Variant
  /** 视觉提示开关；aria-label 始终保留。按钮旁已有文字说明动作时可关掉。 */
  tooltip?: boolean
  /** 提示浮层出现的方位；缺省由 Radix 决定（通常在上方）。 */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** 忙碌中的动作禁用按钮；tooltip 与 aria-label 保持可及。 */
  disabled?: boolean
  /** 读屏播报「忙」：动作仍在途，与 disabled 分开表达——有些忙碌态并不禁止点击。 */
  busy?: boolean
  /** 与表单输入框同高，用在输入框同一行，避免图标按钮矮一截。 */
  formControl?: boolean
  className?: string
  onPointerDown?: PointerEventHandler<HTMLButtonElement>
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>
  onFocus?: FocusEventHandler<HTMLButtonElement>
  onBlur?: FocusEventHandler<HTMLButtonElement>
}) {
  const variantClass = formControl
    ? styleFor(variant, tone).replace(/\bsize-\d+\b/g, '').trim()
    : styleFor(variant, tone)
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      onClick={onPress}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      disabled={disabled}
      className={`icon-button inline-flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variant === 'solid' ? 'icon-button-solid' : ''} ${variantClass} ${formControl ? 'icon-button-form-control' : ''} ${className ?? ''}`}
    >
      {children}
    </button>
  )

  if (!tooltip) return button

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={tooltipSide}
          sideOffset={6}
          className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
        >
          {label}
          <Tooltip.Arrow className="fill-surface-raised" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

/**
 * 图标按钮。图标按钮必须带 tooltip，这是项目红线，所以统一从这个组件出，
 * 不允许在页面里直接写裸的图标按钮。
 *
 * solid：带边框与浅底的标准按钮；ghost：无边框无底色的弱化按钮，
 * 用于浮层卡片内的关闭等次要动作，悬停才浮现可点击感。
 * danger-hover：ghost 专属，平时与 neutral 完全同色，悬停才转危险色——
 * 删除这类破坏性动作要克制，危险感留给悬停时刻，不常驻。
 */

type Tone = 'neutral' | 'danger' | 'danger-hover'
type Variant = 'solid' | 'ghost'

const STYLES: Record<Variant, Record<Exclude<Tone, 'danger-hover'>, string>> = {
  solid: {
    neutral: 'size-7 border border-line bg-surface-raised text-fg-muted hover:text-fg',
    danger: 'size-7 border border-line bg-surface-raised text-danger hover:border-danger/50 hover:bg-danger/10',
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
}: {
  label: string
  onPress?: () => void
  children: ReactNode
  tone?: Tone
  variant?: Variant
  /** 视觉提示开关；aria-label 始终保留。按钮旁已有文字说明动作时可关掉。 */
  tooltip?: boolean
  /** 忙碌中的动作禁用按钮；tooltip 与 aria-label 保持可及。 */
  disabled?: boolean
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styleFor(variant, tone)}`}
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
          sideOffset={6}
          className="z-50 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg"
        >
          {label}
          <Tooltip.Arrow className="fill-surface-raised" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

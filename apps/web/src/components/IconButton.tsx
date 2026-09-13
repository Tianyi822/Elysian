import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

/**
 * 图标按钮。图标按钮必须带 tooltip，这是项目红线，所以统一从这个组件出，
 * 不允许在页面里直接写裸的图标按钮。
 *
 * solid：带边框与浅底的标准按钮；ghost：无边框无底色的弱化按钮，
 * 用于浮层卡片内的关闭等次要动作，悬停才浮现可点击感。
 */
const STYLES: Record<'solid' | 'ghost', Record<'neutral' | 'danger', string>> = {
  solid: {
    neutral: 'size-7 border border-line bg-surface-raised text-fg-muted hover:text-fg',
    danger: 'size-7 border border-line bg-surface-raised text-danger hover:border-danger/50 hover:bg-danger/10',
  },
  ghost: {
    neutral: 'size-6 text-fg-subtle hover:bg-surface-raised hover:text-fg',
    danger: 'size-6 text-danger hover:bg-danger/10',
  },
}

export function IconButton({
  label,
  onPress,
  children,
  tone = 'neutral',
  variant = 'solid',
}: {
  label: string
  onPress?: () => void
  children: ReactNode
  tone?: 'neutral' | 'danger'
  variant?: 'solid' | 'ghost'
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onPress}
          className={`inline-flex items-center justify-center rounded transition-colors ${STYLES[variant][tone]}`}
        >
          {children}
        </button>
      </Tooltip.Trigger>
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

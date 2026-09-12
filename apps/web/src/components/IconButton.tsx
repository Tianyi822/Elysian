import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

/**
 * 图标按钮。图标按钮必须带 tooltip，这是项目红线，所以统一从这个组件出，
 * 不允许在页面里直接写裸的图标按钮。
 */
export function IconButton({
  label,
  onPress,
  children,
  tone = 'neutral',
}: {
  label: string
  onPress?: () => void
  children: ReactNode
  tone?: 'neutral' | 'danger'
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onPress}
          className={[
            'inline-flex size-7 items-center justify-center rounded border border-line bg-surface-raised transition-colors',
            tone === 'danger'
              ? 'text-danger hover:border-danger/50 hover:bg-danger/10'
              : 'text-fg-muted hover:text-fg',
          ].join(' ')}
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

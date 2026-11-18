import { TOOLTIP_CONTENT_CLASS } from './tooltipStyles'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Button } from './Button'
import { Plus } from './icons'

/** 表格空间不足时收为图标，保留同一按钮、动作名称和键盘焦点。 */
export function TableCreateButton({ label, ariaLabel = label, onPress }: { label: string; ariaLabel?: string; onPress: () => void }) {
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>
      <Button variant="primary" type="button" aria-label={ariaLabel} onClick={onPress} className="dt-create-button shrink-0 whitespace-nowrap">
        <Plus aria-hidden size={16} className="dt-create-icon" />
        <span className="dt-create-label">{label}</span>
      </Button>
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content side="bottom" sideOffset={6} className={TOOLTIP_CONTENT_CLASS}>
        {ariaLabel}<Tooltip.Arrow className="fill-surface-raised" />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
}

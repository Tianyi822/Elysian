import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import { CircleHelp } from './icons'

/** 标题旁的点击说明，按现有浮层样式展示并保留键盘和焦点行为。 */
export function SectionHelp({ label, children }: { label: string; children: string }) {
  return <Popover.Root>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Popover.Trigger asChild>
          <button type="button" aria-label={label} className="inline-flex size-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
            <CircleHelp aria-hidden size={15} />
          </button>
        </Popover.Trigger>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">{label}</Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
    <Popover.Portal>
      <Popover.Content aria-label={label} sideOffset={8} align="start" className="z-[70] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-control-line bg-surface-raised p-3 text-xs leading-5 text-fg shadow-xl">
        {children}
        <Popover.Arrow className="fill-surface-raised" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

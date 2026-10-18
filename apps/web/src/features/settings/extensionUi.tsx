import { useId, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import * as Switch from '@radix-ui/react-switch'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreHorizontal, Search, X } from '../../components/icons'
import { ScrollArea } from '../../components/ScrollArea'

export const extensionIconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed'
export const extensionCell = 'border-b border-line px-3 py-3'

export function ExtensionDialog({ title, open, onClose, children, footer, wide = false }: { title: string; open: boolean; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
      <Dialog.Content aria-describedby={undefined} className={`fixed left-1/2 top-1/2 z-[61] flex max-h-[90dvh] ${wide ? 'w-[min(56rem,calc(100vw-2rem))]' : 'w-[min(38rem,calc(100vw-2rem))]'} -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3"><Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title><IconAction label={`关闭${title}`} onClick={onClose}><X aria-hidden size={16} /></IconAction></div>
        <ScrollArea label={`${title}内容`}><div className="min-w-0 space-y-4 px-5 py-4">{children}</div></ScrollArea>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function IconAction({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick(): void; disabled?: boolean }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" aria-label={label} className={extensionIconButton} disabled={disabled} onClick={onClick}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content side="top" sideOffset={6} className="z-[80] rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>
}

export function ExtensionSearch({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  const id = useId()
  return <div className="relative min-w-0 flex-1 sm:max-w-72"><label htmlFor={id} className="sr-only">{label}</label><Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" /><input id={id} type="search" className="ctl-field h-9 w-full pl-8" placeholder={label} value={value} onChange={event => onChange(event.target.value)} /></div>
}

export function ExtensionToggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <label className="flex items-center justify-between gap-3 text-xs font-medium">{label}<Switch.Root aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} className="ui-switch relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"><Switch.Thumb className="ui-switch-thumb ml-0.5 block size-3.5 data-[state=checked]:translate-x-4" /></Switch.Root></label>
}

export function ExtensionMenu({ label, items }: { label: string; items: { label: string; action(): void; danger?: boolean; disabled?: boolean }[] }) {
  return <DropdownMenu.Root><Tooltip.Root><Tooltip.Trigger asChild><DropdownMenu.Trigger aria-label={label} className={extensionIconButton}><MoreHorizontal aria-hidden size={16} /></DropdownMenu.Trigger></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content sideOffset={6} className="z-[80] rounded-md border border-line bg-surface-raised px-2 py-1 text-xs">{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root><DropdownMenu.Portal><DropdownMenu.Content sideOffset={5} align="end" className="select-menu z-[70] min-w-36 p-1">{items.map(item => <DropdownMenu.Item key={item.label} disabled={item.disabled} onSelect={item.action} className={`cursor-pointer rounded-md px-3 py-2 text-xs outline-none data-[highlighted]:bg-surface-raised data-[disabled]:opacity-40 ${item.danger ? 'text-danger' : 'text-fg'}`}>{item.label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}

export function ExtensionTable({ label, columns, children }: { label: string; columns: readonly { label: string; width: string }[]; children: ReactNode }) {
  return <div role="region" aria-label={label} tabIndex={0} className="table-scrollbar min-w-0 overflow-x-auto panel-surface"><table className="w-full min-w-[48rem] table-fixed border-separate border-spacing-0 text-left text-sm"><colgroup>{columns.map(column => <col key={column.label} style={{ width: column.width }} />)}</colgroup><thead><tr>{columns.map(column => <th key={column.label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">{column.label}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}

export function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col"><label htmlFor={id} className="mb-2 text-xs font-medium">{label}</label>{children}</div>
}


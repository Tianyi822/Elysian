import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreHorizontal, X } from '../../components/icons'
import { ScrollArea } from '../../components/ScrollArea'
import { DialogSurface } from '../../components/DialogSurface'
import { Button } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import { EXTENSION_TOOLTIP_CONTENT_CLASS } from '../../components/tooltipStyles'

export const extensionIconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed'

export function ExtensionDialog({ title, open, onClose, children, footer, wide = false }: { title: string; open: boolean; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose() }}>
    <DialogSurface aria-describedby={undefined} className={`flex max-h-[90dvh] ${wide ? 'w-[min(56rem,calc(100vw-2rem))]' : 'w-[min(38rem,calc(100vw-2rem))]'} flex-col shadow-xl`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3"><Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title><IconAction label={`关闭${title}`} onClick={onClose}><X aria-hidden size={16} /></IconAction></div>
      <ScrollArea label={`${title}内容`}><div className="min-w-0 space-y-4 px-5 py-4">{children}</div></ScrollArea>
      {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </DialogSurface>
  </Dialog.Root>
}

export function IconAction({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick(): void; disabled?: boolean }) {
  return <IconButton asChild label={label} tooltipSide="top" tooltipClassName={`${EXTENSION_TOOLTIP_CONTENT_CLASS} text-fg shadow-lg`} tooltipArrow={false}>
    <Button variant="ghost" size="icon" type="button" aria-label={label} className={extensionIconButton} disabled={disabled} onClick={onClick}>{children}</Button>
  </IconButton>
}

export function ExtensionToggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <label className="flex items-center justify-between gap-3 text-xs font-medium">{label}<ToggleSwitch label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} /></label>
}

export function ExtensionMenu({ label, items }: { label: string; items: { label: string; action(): void; danger?: boolean; disabled?: boolean }[] }) {
  return <DropdownMenu.Root><Tooltip.Root><Tooltip.Trigger asChild><DropdownMenu.Trigger asChild><Button variant="ghost" size="icon" aria-label={label} className={extensionIconButton}><MoreHorizontal aria-hidden size={16} /></Button></DropdownMenu.Trigger></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content sideOffset={6} className={EXTENSION_TOOLTIP_CONTENT_CLASS}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root><DropdownMenu.Portal><DropdownMenu.Content sideOffset={5} align="end" className="select-menu z-[70] min-w-36 p-1">{items.map(item => <DropdownMenu.Item key={item.label} disabled={item.disabled} onSelect={item.action} className={`cursor-pointer rounded-md px-3 py-2 text-xs outline-none data-[highlighted]:bg-surface-raised data-[disabled]:opacity-40 ${item.danger ? 'text-danger' : 'text-fg'}`}>{item.label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
}

export function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col"><label htmlFor={id} className="mb-2 text-xs font-medium">{label}</label>{children}</div>
}


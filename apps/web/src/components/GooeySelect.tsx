import { useState, type ReactNode } from 'react'
import { cn } from './easyui/utils'
import { motion, useReducedMotion } from 'framer-motion'
import { GooeyMenu } from './easyui/GooeyMenu'

/** 适配 EasyUI GooeyMenu，用于紧凑的视图收纳和工具栏筛选；表单候选用 SelectDropdown。 */
export function GooeySelect<T extends string>({
  ariaLabel, items, value, onSelect, fallbackLabel = '请选择', disabled = false,
  active = true, className, fieldLabel,
  leadingIcon, triggerClassName, align, portal,
}: {
  ariaLabel: string
  items: readonly { value: T; label: string; disabled?: boolean; description?: string; icon?: ReactNode }[]
  value?: T
  onSelect: (value: T) => void
  fallbackLabel?: string
  disabled?: boolean
  active?: boolean
  className?: string
  fieldLabel?: string
  leadingIcon?: ReactNode
  triggerClassName?: string
  align?: 'start' | 'center' | 'end'
  portal?: boolean
}) {
  const [open, setOpen] = useState(false)
  const reducedMotion = useReducedMotion()
  const label = items.find(item => item.value === value)?.label ?? fallbackLabel

  return <GooeyMenu
    options={items.map(item => item.value)}
    value={value ?? ''}
    getOptionLabel={(_, index) => items[index]?.label ?? fallbackLabel}
    getOptionDetails={(_, index) => items[index]!}
    isOptionDisabled={(_, index) => Boolean(items[index]?.disabled)}
    onSelect={(_, index) => { const item = items[index]; if (item) onSelect(item.value) }}
    open={open}
    onOpenChange={setOpen}
    disabled={disabled || !items.length}
    active={active}
    align={align}
    portal={portal}
    triggerLabel={`${ariaLabel}：${label}`}
    menuLabel={ariaLabel}
    trigger={<>
      {leadingIcon}
      {fieldLabel ? <span className="flex min-w-0 items-center gap-1">
        <span className="shrink-0 text-[var(--t-gooey-muted)]">{fieldLabel}</span>
        <span className="min-w-0 truncate">{label}</span>
      </span> : <span className="min-w-0 truncate">{label}</span>}
      <motion.svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 text-[var(--t-gooey-muted)]"
        animate={{ rotate: open && active && !disabled ? 180 : 0 }}
        transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 20 }}>
        <path d="m6 9 6 6 6-6" />
      </motion.svg>
    </>}
    triggerClassName={cn('h-[var(--message-button-size,2rem)] max-w-full gap-3 rounded-full px-3 text-sm font-medium', triggerClassName)}
    className={className}
  />
}

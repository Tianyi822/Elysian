import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CTL_FIELD } from './formControl'
import { Check, ChevronDown } from './icons'
import { IconButton } from './IconButton'
import { DROPDOWN_OPTION_CLASS, DROPDOWN_SURFACE_CLASS } from './dropdownStyles'
import { bindMenuScroll, revealMenuItem } from './dropdownScroll'

/** 可自由输入的候选字段：自绘列表、键盘选择与 Portal，不调用系统 datalist。 */
export function SuggestionInput({
  items, value, onValueChange, ariaLabel, className, ...inputProps
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list' | 'type'> & {
  items: readonly { value: string; label: string }[]
  value: string
  onValueChange(value: string): void
  ariaLabel: string
}) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const scrollCleanup = useRef<(() => void) | null>(null)
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node
    bindMenuScroll(node, scrollCleanup)
  }, [])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [showAll, setShowAll] = useState(false)
  const [composing, setComposing] = useState(false)
  const query = value.trim().toLowerCase()
  const visible = showAll || composing || items.some(item => item.value === value)
    ? items : items.filter(item => `${item.value} ${item.label}`.toLowerCase().includes(query))
  const expanded = open && visible.length > 0 && !inputProps.disabled
  const close = () => { setOpen(false); setActive(-1) }
  const choose = (next: string) => {
    onValueChange(next)
    inputRef.current?.focus()
    close()
  }
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (listRef.current && item) revealMenuItem(listRef.current, item)
  }, [active])

  return <Popover.Root open={expanded} onOpenChange={next => { setOpen(next); setActive(-1); if (next) setShowAll(true) }}>
    <Popover.Anchor asChild>
      <div ref={anchorRef} className="relative min-w-0">
        <input
          {...inputProps}
          ref={inputRef}
          value={value}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && active >= 0 && visible[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          className={`${CTL_FIELD} pr-9 ${className ?? ''}`}
          onFocus={event => { setOpen(true); setShowAll(false); inputProps.onFocus?.(event) }}
          onChange={event => { onValueChange(event.target.value); setShowAll(false); setActive(-1); setOpen(true) }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => { setComposing(false); setActive(-1) }}
          onKeyDown={event => {
            inputProps.onKeyDown?.(event)
            if (event.defaultPrevented || composing || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (visible.length === 0) return
              event.preventDefault()
              setOpen(true)
              setActive(index => event.key === 'ArrowDown' ? (index + 1) % visible.length : (index <= 0 ? visible.length - 1 : index - 1))
            } else if (event.key === 'Enter' && expanded && active >= 0 && visible[active]) {
              event.preventDefault()
              choose(visible[active].value)
            } else if (event.key === 'Escape' && expanded) {
              event.preventDefault()
              event.stopPropagation()
              close()
            } else if (event.key === 'Tab') close()
          }}
        />
        {items.length > 0 ? <IconButton label={`选择${ariaLabel}候选项`} disabled={inputProps.disabled} variant="ghost"
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2"
            onPress={() => { setShowAll(true); setOpen(!expanded); setActive(-1) }}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); inputRef.current?.focus(); setShowAll(true); setOpen(true); setActive(0) } }}>
            <ChevronDown aria-hidden size={13} />
          </IconButton> : null}
      </div>
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content role="presentation" align="start" sideOffset={6} collisionPadding={8}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => { if (event.target instanceof Node && anchorRef.current?.contains(event.target)) event.preventDefault() }}
        className={`${DROPDOWN_SURFACE_CLASS} w-[var(--radix-popover-trigger-width)]`}>
        <div ref={attachScroll} id={listId} role="listbox" aria-label={`${ariaLabel}候选项`}
          className="hover-scrollbar overflow-y-auto overscroll-contain p-1"
          style={{ maxHeight: 'min(15rem, var(--radix-popover-content-available-height, 15rem))' }}>
          {visible.map((item, index) => <div key={item.value} id={`${listId}-${index}`} role="option"
            aria-selected={item.value === value} data-index={index} data-highlighted={active === index ? '' : undefined}
            className={DROPDOWN_OPTION_CLASS}
            onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(item.value)}>
            <span className="min-w-0 flex-1 break-words">{item.label}</span>
            {item.value === value ? <Check aria-hidden size={13} className="shrink-0" /> : null}
          </div>)}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

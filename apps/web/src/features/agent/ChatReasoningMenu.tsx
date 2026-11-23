import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useReducedMotion } from 'framer-motion'
import { Liquid } from 'liquid-gooey'
import { Button } from '../../components/Button'
import { Brain, Check, ChevronDown } from '../../components/icons'
import { DROPDOWN_OPTION_CLASS } from '../../components/dropdownStyles'

type Anchor = { left: number; top: number; width: number; height: number }
const morph = { shape: true, contentBlur: 0, bounce: 0.2, speed: 2 }

/** Radix positions and focuses the real menu. Only its background travels from the trigger. */
function ReasoningMenuSurface({ trigger }: { trigger: RefObject<HTMLButtonElement | null> }) {
  const surface = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Anchor>()
  const [landed, setLanded] = useState(false)

  useLayoutEffect(() => {
    let settle: number | undefined
    let paint: number | undefined
    const measure = requestAnimationFrame(() => {
      const from = trigger.current?.getBoundingClientRect()
      const to = surface.current?.getBoundingClientRect()
      if (!from?.width || !to?.width || to.bottom <= 0) return
      setAnchor({ left: from.left - to.left, top: from.top - to.top, width: from.width, height: from.height })
      paint = requestAnimationFrame(() => { settle = requestAnimationFrame(() => setLanded(true)) })
    })
    return () => {
      cancelAnimationFrame(measure)
      if (paint !== undefined) cancelAnimationFrame(paint)
      if (settle !== undefined) cancelAnimationFrame(settle)
    }
  }, [trigger])

  return <div ref={surface} className="chat-reasoning-surface" data-liquid={anchor ? '' : undefined} aria-hidden="true">
    {anchor && <Liquid className="chat-reasoning-liquid" fill="var(--t-surface-raised)" blur={6}
      shadow="0 6px 18px var(--t-panel-shadow)">
      <Liquid.Item morph={morph}>
        <div className="chat-reasoning-shape" style={landed ? {
          left: 0, top: 0, width: '100%', height: '100%', borderRadius: 14,
        } : { ...anchor, borderRadius: 16 }} />
      </Liquid.Item>
    </Liquid>}
  </div>
}

const name = '选择思考等级'

export function ChatReasoningMenu({ levels, value, onSelect, disabled }: {
  levels: readonly { value: string; label: string }[]
  value: string
  onSelect(value: string): void
  disabled: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  const [open, setOpen] = useState(false)
  const label = levels.find(level => level.value === value)?.label ?? '思考等级'

  useLayoutEffect(() => { if (disabled) setOpen(false) }, [disabled])

  return <DropdownMenu.Root modal={false} open={open && !disabled} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild disabled={disabled}>
      <Button ref={trigger} type="button" unstyled className="chat-select chat-reasoning-select"
        aria-label={`${name}：${label}`} disabled={disabled}>
        <Brain size={16} aria-hidden />
        <span>{label}</span>
        <ChevronDown size={13} aria-hidden className="chat-reasoning-chevron" />
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content aria-label={name} align="end" side="top" sideOffset={6} collisionPadding={8} className="chat-reasoning-menu">
        {!reducedMotion && <ReasoningMenuSurface trigger={trigger} />}
        <DropdownMenu.RadioGroup value={value} onValueChange={onSelect} className="chat-reasoning-options hover-scrollbar">
          {levels.map(level => <DropdownMenu.RadioItem key={level.value} value={level.value} textValue={level.label}
            className={`${DROPDOWN_OPTION_CLASS} chat-reasoning-option`}>
            {level.label}
            <DropdownMenu.ItemIndicator><Check size={14} aria-hidden /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}

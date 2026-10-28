import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState } from 'react'
import { displayImageName, registryHost } from './imageReference'

/** 名称保持简短；鼠标、键盘和触屏共用完整引用提示。 */
export function ImageReferenceLabel({ name, tag, registry, className = '' }: {
  name: string
  tag: string
  registry?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const touch = useRef(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const display = `${displayImageName(name)}:${tag}`
  const reference = registry
    ? `${registryHost(registry)}/${name.includes('/') ? name : `library/${name}`}:${tag}`
    : `${name}:${tag}`
  const cancelClose = () => clearTimeout(closing.current)
  const reveal = () => { cancelClose(); setOpen(true) }
  const closeSoon = () => {
    cancelClose()
    closing.current = setTimeout(() => {
      const focused = document.activeElement
      if (!hovered.current && !trigger.current?.contains(focused) && !panel.current?.contains(focused)) setOpen(false)
    }, 140)
  }
  const pointerEnter = () => { hovered.current = true; reveal() }
  const pointerLeave = () => { hovered.current = false; closeSoon() }
  useEffect(() => () => clearTimeout(closing.current), [])

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" aria-label={`查看镜像引用 ${display}`}
        className={`inline-block max-w-full truncate rounded align-middle text-left font-medium ${className}`}
        onPointerEnter={event => { if (event.pointerType !== 'touch') pointerEnter() }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') pointerLeave() }}
        onPointerDown={event => { touch.current = event.pointerType === 'touch' }}
        onFocus={() => { if (!touch.current) reveal() }} onBlur={closeSoon}
        onClick={event => { event.preventDefault(); cancelClose(); setOpen(value => !value); touch.current = false }}>
        {display}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={panel} aria-label="完整镜像引用" side="top" align="start" sideOffset={8} collisionPadding={12}
        className="panel-surface z-[70] max-w-[min(24rem,calc(100vw-2rem))] p-3 text-xs"
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={pointerEnter} onPointerLeave={pointerLeave} onFocus={reveal} onBlur={closeSoon}>
        <p className="text-fg-muted">完整引用</p>
        <p className="mt-1 break-all font-mono text-fg">{reference}</p>
        {registry && <><p className="mt-2 text-fg-muted">镜像源</p><p className="mt-1 break-all font-mono text-fg">{registry}</p></>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

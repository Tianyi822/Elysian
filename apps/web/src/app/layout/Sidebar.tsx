import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NavLink } from 'react-router'
import type { NavLinkProps } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { GripVertical } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { NAV_ITEMS, PINNED_NAV_PATH } from '../navigation'
import {
  clampMovableSlot,
  commitNavOrder,
  moveNavItem,
  orderNavItems,
  playNavFlip,
  slotIndexAtPoint,
  translateForSlot,
  useNavOrder,
} from '../navigationOrder'
import { QuickActions } from './QuickActions'
import { SystemLoadBadge } from '../../components/SystemLoadBadge'

// Radix Slot 会合并 className；将路由回调留在内部，避免回调被转成字符串。
const SidebarLink = forwardRef<HTMLAnchorElement, NavLinkProps & { collapsed: boolean; pinned: boolean; dragging: boolean }>(
  function SidebarLink({ collapsed, pinned, dragging, ...props }, ref) {
    return <NavLink {...props} ref={ref} className={({ isActive }) => [
      'nav-link relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm no-underline transition-colors',
      collapsed ? 'w-10 justify-center px-0' : pinned ? 'w-full' : 'w-full pr-9',
      isActive ? 'bg-nav-selected font-semibold text-nav-fg' : dragging ? 'bg-nav-hover text-nav-fg' : 'text-nav-muted group-hover:bg-nav-hover group-hover:text-nav-fg',
    ].join(' ')} />
  },
)

type DragSession = {
  pointerId: number
  originIndex: number
  currentIndex: number
  startY: number
  offsetY: number
  tops: readonly number[]
  stride: number
}

function measureSlots(list: HTMLElement): { tops: number[]; stride: number } | null {
  const nodes = [...list.querySelectorAll<HTMLElement>('[data-nav-item]')]
  if (nodes.length === 0) return null
  const tops = nodes.map((node) => node.getBoundingClientRect().top)
  const stride = tops.length >= 2 ? tops[1]! - tops[0]! : nodes[0]!.getBoundingClientRect().height
  if (stride <= 0) return null
  return { tops, stride }
}

/** 桌面侧边栏与窄屏抽屉共用同一份导航与底部快捷操作。 */
export function Sidebar({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  const paths = useNavOrder()
  const items = orderNavItems(NAV_ITEMS, paths)
  const listRef = useRef<HTMLElement>(null)
  const pathsRef = useRef(paths)
  const dragRef = useRef<DragSession | null>(null)
  const pendingFlip = useRef<Map<string, number> | null>(null)
  const [drag, setDrag] = useState<DragSession | null>(null)
  const [hoveredTo, setHoveredTo] = useState<string | null>(null)
  pathsRef.current = paths

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
    }
  }, [dragging])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const session = dragRef.current
      if (!session || event.pointerId !== session.pointerId) return
      event.preventDefault()
      const offsetY = event.clientY - session.startY
      const currentIndex = clampMovableSlot(
        slotIndexAtPoint(event.clientY, session.tops, session.stride),
        session.tops.length,
      )
      if (currentIndex === session.currentIndex && offsetY === session.offsetY) return
      const next = { ...session, offsetY, currentIndex }
      dragRef.current = next
      setDrag(next)
    }
    const finish = (event: PointerEvent, commit: boolean) => {
      const session = dragRef.current
      if (!session || event.pointerId !== session.pointerId) return
      dragRef.current = null
      if (commit && session.originIndex !== session.currentIndex) {
        const next = moveNavItem(pathsRef.current, session.originIndex, session.currentIndex)
        if (next) commitNavOrder(next)
      }
      setDrag(null)
    }
    const onUp = (event: PointerEvent) => finish(event, true)
    const onCancel = (event: PointerEvent) => finish(event, false)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  useLayoutEffect(() => {
    const previous = pendingFlip.current
    pendingFlip.current = null
    if (!previous || !listRef.current) return
    playNavFlip(listRef.current, previous)
  }, [paths])

  function startDrag(index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !listRef.current || pathsRef.current[index] === PINNED_NAV_PATH) return
    const measured = measureSlots(listRef.current)
    if (!measured) return
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针已经结束或当前环境不支持捕获时，窗口上的监听仍能接到后续移动。
    }
    const session: DragSession = {
      pointerId: event.pointerId,
      originIndex: index,
      currentIndex: index,
      startY: event.clientY,
      offsetY: 0,
      tops: measured.tops,
      stride: measured.stride,
    }
    dragRef.current = session
    setDrag(session)
  }

  function reorderByKey(index: number, key: string) {
    const delta = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    const to = index + delta
    const current = pathsRef.current
    const next = moveNavItem(current, index, to)
    if (!next || !listRef.current) return
    pendingFlip.current = new Map(
      [...listRef.current.querySelectorAll<HTMLElement>('[data-nav-item]')].flatMap((node) => {
        const id = node.dataset['navItem']
        return id ? [[id, node.getBoundingClientRect().top] as const] : []
      }),
    )
    commitNavOrder(next)
  }

  return (
    <div className="flex h-full flex-col">
      <nav
        ref={listRef}
        aria-label="主导航"
        className={`flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 ${collapsed ? 'items-center' : ''}`}
      >
        {items.map((item, index) => {
          const pinned = item.to === PINNED_NAV_PATH
          const draggingThis = drag?.originIndex === index
          const shift =
            drag !== null
              ? translateForSlot(index, drag.originIndex, drag.currentIndex, drag.offsetY, drag.stride)
              : 0
          const navLink = (
            <SidebarLink
              to={item.to}
              end={item.end}
              draggable={false}
              onClick={onNavigate}
              collapsed={collapsed}
              pinned={pinned}
              dragging={draggingThis}
            >
              <item.icon aria-hidden size={17} />
              <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
            </SidebarLink>
          )
          return (
            <div
              key={item.to}
              data-nav-item={item.to}
              data-nav-index={index}
              className={[
                'group relative',
                collapsed ? 'w-10' : 'w-full',
                draggingThis ? 'z-10' : '',
                drag && !draggingThis
                  ? 'transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
                  : '',
              ].join(' ')}
              style={shift !== 0 ? { transform: `translateY(${shift}px)` } : undefined}
              onPointerEnter={() => setHoveredTo(item.to)}
              onPointerLeave={() => setHoveredTo((current) => (current === item.to ? null : current))}
            >
              {/* 展开态标签文字就在旁边，提示是重复；折叠态才套上悬停提示。
                  只在需要时挂载 Tooltip.Root，避免同一实例在受控与非受控之间来回跳。 */}
              {collapsed ? (
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>{navLink}</Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content side="right" sideOffset={10} className="z-[80] rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-lg">
                      {item.label}
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              ) : (
                navLink
              )}
              {collapsed || pinned ? null : (
                <span
                  data-dragging={draggingThis ? '' : undefined}
                  className={`absolute top-1/2 right-1.5 -translate-y-1/2 has-[:focus-visible]:opacity-100 data-[dragging]:opacity-100 ${
                    hoveredTo === item.to ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <IconButton
                    label={`拖拽排序：${item.label}`}
                    variant="ghost"
                    className="cursor-grab touch-none text-nav-muted hover:bg-nav-hover hover:text-nav-fg active:cursor-grabbing"
                    onPointerDown={(event) => startDrag(index, event)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      reorderByKey(index, event.key)
                    }}
                  >
                    <GripVertical aria-hidden size={16} />
                  </IconButton>
                </span>
              )}
            </div>
          )
        })}
      </nav>

      <div className={`shrink-0 p-3 ${collapsed ? 'items-center' : ''}`}>
        <div className="mb-2">
          <SystemLoadBadge navigation collapsed={collapsed} />
        </div>
        <QuickActions collapsed={collapsed} />
      </div>
    </div>
  )
}

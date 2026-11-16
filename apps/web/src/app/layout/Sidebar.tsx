import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NavLink, useLocation } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, useReducedMotion } from 'framer-motion'
import { SidebarPanel } from '../../components/easyui/Sidebar'
import { Bot, GripVertical, PanelLeftClose } from '../../components/icons'
import { Button } from '../../components/Button'
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
  onToggle,
  drawer = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
  onToggle?: () => void
  drawer?: boolean
}) {
  const paths = useNavOrder()
  const items = useMemo(() => orderNavItems(NAV_ITEMS, paths), [paths])
  const sections = useMemo(() => [{ items: items.map(item => ({ id: item.to, label: item.label, icon: <item.icon aria-hidden /> })) }], [items])
  const { pathname } = useLocation()
  const activeId = NAV_ITEMS.find(item => item.end ? pathname === item.to : pathname.startsWith(item.to))?.to ?? ''
  const reduced = useReducedMotion()
  const listRef = useRef<HTMLElement>(null)
  const pathsRef = useRef(paths)
  const dragRef = useRef<DragSession | null>(null)
  const pendingFlip = useRef<Map<string, number> | null>(null)
  const [drag, setDrag] = useState<DragSession | null>(null)
  const [hoveredTo, setHoveredTo] = useState<string | null>(null)
  pathsRef.current = paths

  const dragging = drag !== null
  useEffect(() => {
    if (collapsed) { dragRef.current = null; setDrag(null) }
  }, [collapsed])
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
    const cancel = () => { dragRef.current = null; setDrag(null) }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', cancel)
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

  return <SidebarPanel
    collapsed={collapsed}
    onToggle={onToggle}
    navRef={listRef}
    dragging={dragging}
    sections={sections}
    activeId={activeId}
    // React Router owns the navigation; the official panel only closes the drawer.
    onActiveChange={() => {}}
    onNavigate={onNavigate}
    header={<div className={`flex items-center ${collapsed ? 'gap-0' : 'gap-2'}`}>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sidebar-fg text-sidebar"><Bot aria-hidden size={16} /></span>
      <motion.span initial={false} animate={{ opacity: collapsed ? 0 : 1, width: collapsed ? 0 : 'auto' }}
        transition={{ duration: reduced ? 0 : 0.15 }} aria-hidden={collapsed || undefined}
        className="overflow-hidden whitespace-nowrap text-sm font-semibold text-sidebar-fg">Elysian</motion.span>
    </div>}
    headerAction={drawer ? <Dialog.Close asChild><Button unstyled type="button" aria-label="关闭主导航"
      className="grid size-7 shrink-0 place-items-center rounded-[8px] text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg focus-visible:ring-2 focus-visible:ring-focus">
      <PanelLeftClose aria-hidden size={18} />
    </Button></Dialog.Close> : undefined}
    footer={<><SystemLoadBadge navigation collapsed={collapsed} /><QuickActions collapsed={collapsed} /></>}
    renderLink={(item, props) => <NavLink {...props} to={item.id} end={NAV_ITEMS.find(nav => nav.to === item.id)?.end} draggable={false} />}
    itemAttributes={item => {
      const index = items.findIndex(nav => nav.to === item.id)
      const draggingThis = drag?.originIndex === index
      const shift = drag ? translateForSlot(index, drag.originIndex, drag.currentIndex, drag.offsetY, drag.stride) : 0
      return {
        'data-nav-item': item.id,
        'data-nav-index': index,
        className: `group relative w-full ${draggingThis ? 'z-10' : ''} ${drag && !draggingThis ? 'transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none' : ''}`,
        style: shift !== 0 ? { transform: `translateY(${shift}px)` } : undefined,
        onPointerEnter: () => setHoveredTo(item.id),
        onPointerLeave: () => setHoveredTo(current => current === item.id ? null : current),
      }
    }}
    itemAction={item => item.id === PINNED_NAV_PATH ? null : <span
      data-sidebar-reorder data-dragging={drag?.originIndex === items.findIndex(nav => nav.to === item.id) ? '' : undefined}
      className={`absolute top-1/2 right-1 -translate-y-1/2 has-[:focus-visible]:opacity-100 data-[dragging]:opacity-100 ${hoveredTo === item.id ? 'opacity-100' : 'opacity-0'}`}>
      <IconButton label={`拖拽排序：${item.label}`} variant="ghost"
        className="size-6 cursor-grab touch-none rounded-[6px] text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg active:cursor-grabbing"
        onPointerDown={event => startDrag(items.findIndex(nav => nav.to === item.id), event)}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          reorderByKey(items.findIndex(nav => nav.to === item.id), event.key)
        }}>
        <GripVertical aria-hidden size={14} />
      </IconButton>
    </span>}
  />
}

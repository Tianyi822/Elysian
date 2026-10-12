import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

const TRACK_INSET = 6
const MIN_THUMB = 32

/** 原生视口负责滚轮、触控板与焦点滚动；独立滑块提供主题样式及鼠标拖动。 */
export function ScrollArea({ children, label, className = '' }: { children: ReactNode; label: string; className?: string }) {
  const viewportId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; offset: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [metrics, setMetrics] = useState({ height: 0, content: 0, top: 0 })
  const measure = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const next = { height: viewport.clientHeight, content: viewport.scrollHeight, top: viewport.scrollTop }
    setMetrics(previous => previous.height === next.height && previous.content === next.content && previous.top === next.top ? previous : next)
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    measure()
    return () => observer.disconnect()
  }, [measure])

  const maximum = Math.max(0, metrics.content - metrics.height)
  const trackHeight = Math.max(0, metrics.height - TRACK_INSET * 2)
  const thumbHeight = Math.min(trackHeight, Math.max(MIN_THUMB, trackHeight * metrics.height / (metrics.content || 1)))
  const travel = trackHeight - thumbHeight
  const top = Math.max(0, Math.min(maximum, metrics.top))
  const thumbTop = maximum > 0 ? top / maximum * travel : 0
  const overflow = maximum > 1 && trackHeight > 0

  useEffect(() => {
    const track = trackRef.current
    if (!track) { drag.current = null; setDragging(false); return }
    // 轨道在视口外，仅在命中轨道时转交滚轮；内容区的原生惯性不被接管。
    const onWheel = (event: WheelEvent) => {
      const viewport = viewportRef.current
      if (!viewport || event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
      viewport.scrollTop += event.deltaY * unit
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [overflow])

  const scrollTo = (value: number) => {
    if (!viewportRef.current) return
    viewportRef.current.scrollTop = Math.max(0, Math.min(maximum, value))
    measure()
  }
  const movePointer = (event: PointerEvent<HTMLDivElement>, offset: number) => {
    if (travel <= 0) return
    scrollTo((event.clientY - event.currentTarget.getBoundingClientRect().top - offset) / travel * maximum)
  }
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const onThumb = thumbRef.current?.contains(event.target as Node)
    const offset = onThumb ? event.clientY - event.currentTarget.getBoundingClientRect().top - thumbTop : thumbHeight / 2
    drag.current = { pointerId: event.pointerId, offset }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    if (!onThumb) movePointer(event, offset)
  }
  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    switch (event.key) {
      case 'ArrowUp': next = top - 40; break
      case 'ArrowDown': next = top + 40; break
      case 'PageUp': next = top - metrics.height; break
      case 'PageDown': next = top + metrics.height; break
      case 'Home': next = 0; break
      case 'End': next = maximum; break
      case ' ': next = top + (event.shiftKey ? -1 : 1) * metrics.height; break
      default: return
    }
    event.preventDefault()
    scrollTo(next)
  }

  return <div className={`scroll-area ${className}`}>
    <div ref={viewportRef} id={viewportId} role="region" aria-label={label} tabIndex={0} onScroll={measure} className="scroll-area-viewport">
      <div ref={contentRef} className="min-w-0 flow-root">{children}</div>
    </div>
    {overflow && <div ref={trackRef} role="scrollbar" aria-label={`${label}滚动条`} aria-controls={viewportId} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={Math.round(top)} tabIndex={0}
      className="scroll-area-track" data-dragging={dragging || undefined} style={{ top: TRACK_INSET, bottom: TRACK_INSET }}
      onPointerDown={startDrag} onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) movePointer(event, drag.current.offset) }}
      onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag} onKeyDown={onKeyDown}>
      <div ref={thumbRef} className="scroll-area-thumb" style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }} />
    </div>}
  </div>
}

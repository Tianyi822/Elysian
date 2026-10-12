/** 浮层自己消费滚动，避免对话框在 document 上的滚动锁阻止候选列表滚动。 */
export function bindMenuScroll(node: HTMLDivElement | null, cleanup: { current: (() => void) | null }) {
  cleanup.current?.()
  cleanup.current = null
  if (!node) return
  const canScroll = () => node.scrollHeight > node.clientHeight + 1
  const onWheel = (event: WheelEvent) => {
    if (!canScroll()) return
    const atTop = node.scrollTop <= 0
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) event.preventDefault()
    event.stopPropagation()
  }
  const onTouchMove = (event: TouchEvent) => {
    if (canScroll()) event.stopPropagation()
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  node.addEventListener('touchmove', onTouchMove, { passive: true })
  cleanup.current = () => {
    node.removeEventListener('wheel', onWheel)
    node.removeEventListener('touchmove', onTouchMove)
  }
}

/** 只滚动候选列表，不移动外层页面或对话框。 */
export function revealMenuItem(container: HTMLElement, item: HTMLElement) {
  const containerRect = container.getBoundingClientRect()
  const itemRect = item.getBoundingClientRect()
  if (itemRect.top < containerRect.top) container.scrollTop -= containerRect.top - itemRect.top
  else if (itemRect.bottom > containerRect.bottom) container.scrollTop += itemRect.bottom - containerRect.bottom
}

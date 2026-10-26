/** 尺寸观察能力缺失或受限时，保留初始测量后的窗口、内容与交互更新。 */
export function observeElementSize(elements: readonly Element[], measure: () => void): () => void {
  if (typeof ResizeObserver === 'function') {
    let observer: ResizeObserver | undefined
    try {
      observer = new ResizeObserver(measure)
      for (const element of elements) observer.observe(element)
      return () => observer?.disconnect()
    } catch { observer?.disconnect() }
  }
  let frame = 0
  let disposed = false
  const schedule = () => {
    if (disposed || frame) return
    frame = requestAnimationFrame(() => { frame = 0; if (!disposed) measure() })
  }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : undefined
  for (const element of elements) observer?.observe(element, { childList: true, subtree: true, characterData: true })
  window.addEventListener('resize', schedule)
  document.addEventListener('transitionend', schedule, true)
  document.addEventListener('click', schedule, true)
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
    document.removeEventListener('transitionend', schedule, true)
    document.removeEventListener('click', schedule, true)
  }
}

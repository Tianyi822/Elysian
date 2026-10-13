/**
 * 后台标签页不持有展示连接：HTTP/1.1 的同源连接额度由各标签共享，
 * 每页两条全局 SSE 再加回答流，容易把普通读取挤在连接队列里。
 * pagehide 同时覆盖页面离开与往返缓存，恢复后重新读取服务端事实。
 */
export function subscribeWhileVisible(subscribe: () => () => void): () => void {
  let unsubscribe: (() => void) | undefined
  let pageHidden = false
  let disposed = false
  const stop = () => {
    const cleanup = unsubscribe
    unsubscribe = undefined
    cleanup?.()
  }
  const update = () => {
    if (disposed) return
    if (pageHidden || document.visibilityState === 'hidden') stop()
    else if (!unsubscribe) unsubscribe = subscribe()
  }
  const hide = () => { pageHidden = true; update() }
  const show = () => { pageHidden = false; update() }
  document.addEventListener('visibilitychange', update)
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', show)
  update()
  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', show)
    stop()
  }
}

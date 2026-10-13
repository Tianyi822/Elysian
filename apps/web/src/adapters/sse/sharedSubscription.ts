import type { Unsubscribe } from '@elysian/contracts'

/** 同源页面由 Web Lock 选出一个连接持有者，其余页面通过 BroadcastChannel 接收。 */
export function sharedSubscription<T>(
  name: string,
  start: (emit: (value: T) => void) => Unsubscribe,
  receive: (value: T) => void,
  snapshotKey: (value: T) => string | undefined,
): Unsubscribe {
  if (!navigator.locks || typeof BroadcastChannel === 'undefined') return start(receive)
  const channel = new BroadcastChannel(name)
  const controller = new AbortController()
  const id = crypto.randomUUID()
  const snapshot = new Map<string, T>()
  let disposed = false
  let owner = false
  let stop: Unsubscribe | undefined
  let release: (() => void) | undefined

  channel.onmessage = ({ data }) => {
    if (disposed || !data || typeof data !== 'object') return
    if (data.type === 'hello' && owner) {
      for (const value of snapshot.values()) channel.postMessage({ type: 'value', target: data.id, value })
    } else if (data.type === 'value' && (!data.target || data.target === id)) receive(data.value as T)
  }
  channel.postMessage({ type: 'hello', id })
  void navigator.locks.request(name, { signal: controller.signal }, async () => {
    if (disposed) return
    owner = true
    const held = new Promise<void>(resolve => { release = resolve })
    stop = start(value => {
      if (disposed) return
      const key = snapshotKey(value)
      if (key !== undefined) snapshot.set(key, value)
      receive(value)
      channel.postMessage({ type: 'value', value })
    })
    try { await held } finally { owner = false }
  }).catch(() => {
    // 不支持锁或锁服务异常时仍保留原订阅；主动退订不重新连接。
    if (!disposed) {
      owner = false
      stop?.()
      channel.onmessage = null
      channel.close()
      stop = start(receive)
    }
  })
  return () => {
    if (disposed) return
    disposed = true
    stop?.()
    controller.abort()
    release?.()
    channel.close()
  }
}

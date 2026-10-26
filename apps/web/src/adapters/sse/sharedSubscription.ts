import { randomId } from '../../utils/randomId'
import type { Unsubscribe } from '@elysian/contracts'

/** 同源页面由 Web Lock 选出一个连接持有者，其余页面通过 BroadcastChannel 接收。 */
export function sharedSubscription<T>(
  name: string,
  start: (emit: (value: T) => void) => Unsubscribe,
  receive: (value: T) => void,
  snapshotKey: (value: T) => string | undefined,
): Unsubscribe {
  let locks: LockManager | undefined
  try { locks = navigator.locks }
  catch { return start(receive) }
  if (typeof locks?.request !== 'function' || typeof BroadcastChannel !== 'function') return start(receive)
  let candidate: BroadcastChannel | undefined
  let id: string
  try {
    candidate = new BroadcastChannel(name)
    id = randomId()
    candidate.postMessage({ type: 'hello', id })
  } catch {
    try { candidate?.close() } catch { /* 共享通道失败不阻断直接订阅。 */ }
    return start(receive)
  }
  const channel = candidate
  const controller = new AbortController()
  const snapshot = new Map<string, T>()
  let disposed = false
  let owner = false
  let direct = false
  let stop: Unsubscribe | undefined
  let release: (() => void) | undefined

  const closeChannel = () => { channel.onmessage = null; try { channel.close() } catch { /* 清理失败不阻断直接订阅。 */ } }
  const fallback = () => {
    if (disposed || direct) return
    direct = true
    owner = false
    stop?.()
    stop = undefined
    controller.abort()
    release?.()
    closeChannel()
    stop = start(receive)
  }
  const broadcast = (value: unknown) => { try { channel.postMessage(value) } catch { fallback() } }

  channel.onmessage = ({ data }) => {
    if (disposed || direct || !data || typeof data !== 'object') return
    if (data.type === 'hello' && owner) {
      for (const value of snapshot.values()) broadcast({ type: 'value', target: data.id, value })
    } else if (data.type === 'value' && (!data.target || data.target === id)) receive(data.value as T)
  }
  void Promise.resolve().then(() => locks.request(name, { signal: controller.signal }, async () => {
    if (disposed || direct) return
    owner = true
    const held = new Promise<void>(resolve => { release = resolve })
    const unsubscribe = start(value => {
      if (disposed || direct) return
      const key = snapshotKey(value)
      if (key !== undefined) snapshot.set(key, value)
      receive(value)
      broadcast({ type: 'value', value })
    })
    if (disposed || direct) unsubscribe()
    else stop = unsubscribe
    try { await held } finally { owner = false }
  })).catch(fallback)
  return () => {
    if (disposed) return
    disposed = true
    stop?.()
    controller.abort()
    release?.()
    closeChannel()
  }
}

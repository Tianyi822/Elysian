import { subscribeWhileVisible } from '../subscribeWhileVisible'
import type { PlatformMemorySample } from './types'

export type PlatformMemoryView =
  | { status: 'loading' }
  | { status: 'ready'; sample: PlatformMemorySample }
  | { status: 'error' }

type MemoryReader = (signal?: AbortSignal) => Promise<PlatformMemorySample>
const loading: PlatformMemoryView = { status: 'loading' }

/** 多个展示组件共享采样；后台暂停，最后一个订阅退出时取消读取并清空快照。 */
export function createPlatformMemorySource(read: MemoryReader, intervalMs: number) {
  let snapshot: PlatformMemoryView = loading
  const listeners = new Set<() => void>()
  let dispose: (() => void) | undefined

  const publish = (next: PlatformMemoryView) => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const start = () => subscribeWhileVisible(() => {
    let active = true
    let pending = false
    const controller = new AbortController()
    const tick = async () => {
      if (!active || pending) return
      pending = true
      try {
        const sample = await read(controller.signal)
        if (active) publish({ status: 'ready', sample })
      } catch {
        if (active) publish({ status: 'error' })
      } finally {
        pending = false
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      active = false
      clearInterval(timer)
      controller.abort()
    }
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) dispose = start()
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        dispose?.()
        dispose = undefined
        snapshot = loading
      }
    },
  }
}

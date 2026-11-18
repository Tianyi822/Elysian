import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PlatformMemorySample } from '@elysian/contracts'
import { subscribeWhileVisible } from '../adapters/subscribeWhileVisible'
import type { PlatformMemoryAdapter, SystemLoad } from '../contracts/adapters'
import { getLastResourceSample, onStreamEvent } from './eventStreamStore'

export type PlatformMemoryView =
  | { status: 'loading' }
  | { status: 'ready'; sample: PlatformMemorySample }
  | { status: 'error' }

const SAMPLE_INTERVAL_MS = 5_000
const loading: PlatformMemoryView = { status: 'loading' }
const memorySources = new WeakMap<PlatformMemoryAdapter, ReturnType<typeof createPlatformMemorySource>>()

/** 多个展示组件共享采样；后台暂停，最后一个订阅退出时取消读取并清空快照。 */
function createPlatformMemorySource(adapter: PlatformMemoryAdapter) {
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
        const sample = await adapter.read(controller.signal)
        if (active) publish({ status: 'ready', sample })
      } catch {
        if (active) publish({ status: 'error' })
      } finally {
        pending = false
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
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

function getMemorySource(adapter: PlatformMemoryAdapter) {
  let source = memorySources.get(adapter)
  if (!source) {
    source = createPlatformMemorySource(adapter)
    memorySources.set(adapter, source)
  }
  return source
}

function readLoad(event: ReturnType<typeof getLastResourceSample>): SystemLoad | undefined {
  return event?.name === 'resource/sample' ? event.payload.load : undefined
}

/** 主机负载复用已有 SSE；面板进程内存由同一 adapter 的订阅者共享。 */
export function useSystemLoad(adapter: PlatformMemoryAdapter) {
  const source = getMemorySource(adapter)
  const memory = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const [load, setLoad] = useState(() => readLoad(getLastResourceSample()))
  useEffect(() => onStreamEvent((event) => {
    const next = readLoad(event)
    if (next) setLoad(next)
  }), [])
  return { memory, load }
}

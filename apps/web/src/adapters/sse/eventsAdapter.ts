import type { EventStreamHandlers, Unsubscribe } from '@elysian/contracts'
import { EVENT_MODES, EVENT_NAMES } from '@elysian/contracts'
import type { EventsAdapter } from '../../contracts/adapters'
import { parseElysianEvent } from './parse'

/**
 * 事件流只承载已发生的事实，也就是 emit 型事件。
 * waterfall、serial、parallel 需要应答，属于双向通道的语义，本期不订阅。
 */
const STREAMED_EVENT_NAMES = EVENT_NAMES.filter((name) => EVENT_MODES[name] === 'emit')

/**
 * 事件源的最小形状。只用到订阅、关闭与两个回调，
 * 因此可以在测试里注入替身，也可以在没有 EventSource 的环境里直接降级。
 */
export type EventSourceLike = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

export type EventSourceFactory = (url: string) => EventSourceLike

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  if (typeof EventSource === 'undefined') return undefined
  return (url) => new EventSource(url) as unknown as EventSourceLike
}

/**
 * 真实 SSE 实现：用浏览器原生事件源订阅命名事件，
 * 断线重连与 Last-Event-ID 回送由事件源自己负责。
 */
export function createSseEventsAdapter(
  options: {
    url?: string
    createEventSource?: EventSourceFactory
  } = {},
): EventsAdapter {
  const url = options.url ?? '/api/events'
  const factory = options.createEventSource ?? defaultEventSourceFactory()

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      if (!factory) {
        handlers.onStatus('degraded')
        return () => {}
      }

      let source: EventSourceLike
      try { source = factory(url) }
      catch { handlers.onStatus('degraded'); return () => {} }
      handlers.onStatus('connecting')

      for (const name of STREAMED_EVENT_NAMES) {
        source.addEventListener(name, (message: MessageEvent<string>) => {
          const event = parseElysianEvent(message.data)
          if (event) handlers.onEvent(event)
        })
      }

      source.onopen = () => handlers.onStatus('live')
      source.onerror = () => handlers.onStatus('connecting')

      return () => {
        source.close()
      }
    },
  }
}

/**
 * 韧性实现：优先走真实事件流，连不上就降级到同契约的内存事件源，
 * 并把降级状态上报给界面。探针窗口内没连上即视为不可用。
 */
export function createResilientEventsAdapter(options: {
  fallback: () => EventsAdapter
  url?: string
  probeMs?: number
  createEventSource?: EventSourceFactory
}): EventsAdapter {
  const url = options.url ?? '/api/events'
  const probeMs = options.probeMs ?? 3000
  const factory = options.createEventSource ?? defaultEventSourceFactory()

  return {
    subscribe(handlers: EventStreamHandlers): Unsubscribe {
      if (!factory) {
        // 与探针超时那条路径一样：降级状态由本层上报，内存事件源自己的健康状态不能覆盖它。
        const unsubscribeFallback = options.fallback().subscribe({
          onEvent: handlers.onEvent,
          onStatus: () => {},
        })
        handlers.onStatus('degraded')
        return unsubscribeFallback
      }

      let degraded = false
      let live = false
      let unsubscribeFallback: Unsubscribe | undefined

      let source: EventSourceLike
      try { source = factory(url) }
      catch {
        const unsubscribe = options.fallback().subscribe({ onEvent: handlers.onEvent, onStatus: () => {} })
        handlers.onStatus('degraded')
        return unsubscribe
      }
      handlers.onStatus('connecting')

      let timer: ReturnType<typeof setTimeout> | undefined
      const fallbackToMemory = () => {
        if (degraded) return
        degraded = true
        if (timer !== undefined) clearTimeout(timer)
        source.close()

        // 降级信号由本层负责：内存事件源会照常上报自己的连接中/已连接，
        // 那会把「已降级」这一事实盖掉，页头就会在真正降级时显示「已连接」。
        unsubscribeFallback = options.fallback().subscribe({
          onEvent: handlers.onEvent,
          onStatus: () => {},
        })
        handlers.onStatus('degraded')
      }

      source.onopen = () => {
        if (degraded) return
        live = true
        if (timer !== undefined) clearTimeout(timer)
        handlers.onStatus('live')
      }

      source.onerror = () => {
        if (degraded) return
        // 连上之前失败：判定端点不可用，换内存事件源。
        // 连上之后断开：交给事件源自带的自动重连，期间标记为连接中。
        if (!live) {
          fallbackToMemory()
          return
        }
        handlers.onStatus('connecting')
      }

      for (const name of STREAMED_EVENT_NAMES) {
        source.addEventListener(name, (message: MessageEvent<string>) => {
          const event = parseElysianEvent(message.data)
          if (event) handlers.onEvent(event)
        })
      }

      timer = setTimeout(fallbackToMemory, probeMs)

      return () => {
        if (timer !== undefined) clearTimeout(timer)
        // 监听器随事件源一起失效，不需要逐个摘除。
        source.close()
        unsubscribeFallback?.()
      }
    },
  }
}

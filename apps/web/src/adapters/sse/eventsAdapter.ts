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

      const source = factory(url)
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
        handlers.onStatus('degraded')
        return options.fallback().subscribe(handlers)
      }

      let degraded = false
      let live = false
      let unsubscribeFallback: Unsubscribe | undefined

      const source = factory(url)
      handlers.onStatus('connecting')

      const fallbackToMemory = () => {
        if (degraded) return
        degraded = true
        if (timer !== undefined) clearTimeout(timer)
        source.close()
        handlers.onStatus('degraded')
        unsubscribeFallback = options.fallback().subscribe(handlers)
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

      const listeners = STREAMED_EVENT_NAMES.map((name) => {
        const listener = (message: MessageEvent<string>) => {
          const event = parseElysianEvent(message.data)
          if (event) handlers.onEvent(event)
        }
        source.addEventListener(name, listener)
        return listener
      })

      const timer: ReturnType<typeof setTimeout> = setTimeout(fallbackToMemory, probeMs)

      return () => {
        if (timer !== undefined) clearTimeout(timer)
        void listeners
        source.close()
        unsubscribeFallback?.()
      }
    },
  }
}

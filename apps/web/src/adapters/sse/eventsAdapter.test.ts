import type { ElysianEvent, EventStreamHandlers, EventStreamStatus } from '@elysian/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../../test/fakeEventSource'
import type { EventsAdapter } from '../../contracts/adapters'
import { createResilientEventsAdapter, createSseEventsAdapter } from './eventsAdapter'

function createStubAdapter() {
  const state = {
    handlers: undefined as EventStreamHandlers | undefined,
    subscribeCount: 0,
    unsubscribeCount: 0,
  }
  const adapter: EventsAdapter = {
    subscribe(handlers) {
      state.subscribeCount += 1
      state.handlers = handlers
      return () => {
        state.unsubscribeCount += 1
      }
    },
  }
  return { adapter, state }
}

function envelope(id: string, name = 'agent/status'): string {
  return JSON.stringify({
    id,
    name,
    at: '2026-09-12T08:00:00.000Z',
    payload: { moduleId: 'command-coordination', status: 'running' },
  })
}

describe('韧性事件流适配器', () => {
  beforeEach(() => {
    FakeEventSource.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('连上之后上报已连接，并按事件名派发信封', () => {
    const statuses: EventStreamStatus[] = []
    const events: ElysianEvent[] = []
    const adapter = createResilientEventsAdapter({
      fallback: () => {
        throw new Error('已连上就不应降级')
      },
      createEventSource: (url) => new FakeEventSource(url),
    })

    const unsubscribe = adapter.subscribe({
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
    })

    const source = FakeEventSource.latest()
    expect(source).toBeDefined()
    expect(statuses).toEqual(['connecting'])

    source?.emitOpen()
    expect(statuses).toEqual(['connecting', 'live'])

    source?.emitRaw('agent/status', envelope('evt-1'))
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe('agent/status')

    // 内容不合法的帧被丢弃，不会把坏数据交给界面
    source?.emitRaw('agent/status', '不是 JSON')
    expect(events).toHaveLength(1)

    unsubscribe()
    expect(source?.closed).toBe(true)
  })

  it('探针窗口内没连上就降级到内存事件源', () => {
    vi.useFakeTimers()
    const stub = createStubAdapter()
    const statuses: EventStreamStatus[] = []

    const adapter = createResilientEventsAdapter({
      fallback: () => stub.adapter,
      probeMs: 1000,
      createEventSource: (url) => new FakeEventSource(url),
    })
    adapter.subscribe({ onStatus: (status) => statuses.push(status), onEvent: () => {} })

    expect(statuses).toEqual(['connecting'])
    vi.advanceTimersByTime(1001)

    expect(statuses).toEqual(['connecting', 'degraded'])
    expect(stub.state.subscribeCount).toBe(1)
    expect(FakeEventSource.latest()?.closed).toBe(true)
  })

  it('连上之前报错立即降级，不空等探针窗口', () => {
    vi.useFakeTimers()
    const stub = createStubAdapter()
    const statuses: EventStreamStatus[] = []

    const adapter = createResilientEventsAdapter({
      fallback: () => stub.adapter,
      probeMs: 10_000,
      createEventSource: (url) => new FakeEventSource(url),
    })
    adapter.subscribe({ onStatus: (status) => statuses.push(status), onEvent: () => {} })

    FakeEventSource.latest()?.emitError()

    expect(statuses).toEqual(['connecting', 'degraded'])
    expect(stub.state.subscribeCount).toBe(1)
  })

  it('连上之后断开只标记连接中，交给事件源自带重连，不降级', () => {
    vi.useFakeTimers()
    const stub = createStubAdapter()
    const statuses: EventStreamStatus[] = []

    const adapter = createResilientEventsAdapter({
      fallback: () => stub.adapter,
      probeMs: 1000,
      createEventSource: (url) => new FakeEventSource(url),
    })
    adapter.subscribe({ onStatus: (status) => statuses.push(status), onEvent: () => {} })

    const source = FakeEventSource.latest()
    source?.emitOpen()
    source?.emitError()
    vi.advanceTimersByTime(5000)

    expect(statuses).toEqual(['connecting', 'live', 'connecting'])
    expect(stub.state.subscribeCount).toBe(0)
  })

  it('退订会释放降级订阅', () => {
    vi.useFakeTimers()
    const stub = createStubAdapter()

    const adapter = createResilientEventsAdapter({
      fallback: () => stub.adapter,
      probeMs: 100,
      createEventSource: (url) => new FakeEventSource(url),
    })
    const unsubscribe = adapter.subscribe({ onStatus: () => {}, onEvent: () => {} })
    vi.advanceTimersByTime(101)
    unsubscribe()

    expect(stub.state.unsubscribeCount).toBe(1)
  })

  it('运行环境没有事件源能力时直接降级，测试因此不依赖服务端进程', () => {
    const stub = createStubAdapter()
    const statuses: EventStreamStatus[] = []

    // 不注入事件源工厂：jsdom 里没有 EventSource，走的正是浏览器缺能力时的分支。
    const adapter = createResilientEventsAdapter({ fallback: () => stub.adapter })
    adapter.subscribe({ onStatus: (status) => statuses.push(status), onEvent: () => {} })

    expect(statuses).toEqual(['degraded'])
    expect(stub.state.subscribeCount).toBe(1)
  })
})

describe('纯 SSE 实现', () => {
  it('缺少事件源能力时标记为降级且不退订任何东西', () => {
    const statuses: EventStreamStatus[] = []
    const adapter = createSseEventsAdapter()
    const unsubscribe = adapter.subscribe({
      onStatus: (status) => statuses.push(status),
      onEvent: () => {},
    })
    expect(statuses).toEqual(['degraded'])
    expect(() => unsubscribe()).not.toThrow()
  })
})

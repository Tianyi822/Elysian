import { EVENT_NAMES } from '@elysian/contracts'
import type { ElysianEvent, EventStreamStatus } from '@elysian/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource } from '../test/fakeEventSource'
import type { EventsAdapter } from './../contracts/adapters'
import { createMockDataset } from './mock/dataset'
import { createInMemoryEventsAdapter } from './mock/mockAdapters'
import { createResilientEventsAdapter, createSseEventsAdapter } from './sse/eventsAdapter'

/**
 * 事件流适配器的共同契约。
 *
 * 两个实现必须跑同一套断言——这是 ADR-0005 写下的验证方式，也是「mock 可替换」的实证：
 * 将来换成真实网关的适配器时，只要这套断言能过，界面与 store 就不需要改。
 */

type Harness = {
  adapter: EventsAdapter
  /** 让适配器进入「已连接」并至少投递一个事件。 */
  activate: () => void
}

const SAMPLE_ENVELOPE = {
  id: 'evt-1',
  name: 'agent/status',
  at: '2026-09-12T08:00:00.000Z',
  payload: { moduleId: 'command-coordination', status: 'running' },
}

function describeEventsAdapter(name: string, createHarness: () => Harness): void {
  describe(`事件流适配器契约：${name}`, () => {
    afterEach(() => {
      vi.useRealTimers()
      FakeEventSource.reset()
    })

    it('激活之后给出一个非「连接中」的最终状态', () => {
      const statuses: EventStreamStatus[] = []
      const harness = createHarness()

      const unsubscribe = harness.adapter.subscribe({
        onStatus: (status) => statuses.push(status),
        onEvent: () => {},
      })
      harness.activate()

      expect(statuses.length).toBeGreaterThan(0)
      expect(statuses.at(-1)).not.toBe('connecting')
      unsubscribe()
    })

    it('投递的事件信封字段齐全，事件名在契约之内', () => {
      const events: ElysianEvent[] = []
      const harness = createHarness()

      const unsubscribe = harness.adapter.subscribe({
        onStatus: () => {},
        onEvent: (event) => events.push(event),
      })
      harness.activate()

      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(event.id.length).toBeGreaterThan(0)
        expect(EVENT_NAMES).toContain(event.name)
        expect(Number.isNaN(Date.parse(event.at))).toBe(false)
        expect(event.payload).toBeDefined()
      }
      unsubscribe()
    })

    it('退订之后不再把事件交给订阅者', () => {
      const events: ElysianEvent[] = []
      const harness = createHarness()

      const unsubscribe = harness.adapter.subscribe({
        onStatus: () => {},
        onEvent: (event) => events.push(event),
      })
      unsubscribe()
      harness.activate()

      expect(events).toHaveLength(0)
    })
  })
}

describeEventsAdapter('SSE 实现', () => {
  const adapter = createSseEventsAdapter({
    createEventSource: (url) => new FakeEventSource(url),
  })

  return {
    adapter,
    activate: () => {
      const source = FakeEventSource.latest()
      source?.emitOpen()
      source?.emit('agent/status', SAMPLE_ENVELOPE)
    },
  }
})

describeEventsAdapter('内存降级实现', () => {
  vi.useFakeTimers()
  const dataset = createMockDataset()

  return {
    adapter: createInMemoryEventsAdapter(() => dataset, { intervalMs: 10 }),
    activate: () => {
      vi.advanceTimersByTime(20)
    },
  }
})

describe('真实降级组合', () => {
  afterEach(() => {
    vi.useRealTimers()
    FakeEventSource.reset()
  })

  it('端点不可用时最终状态是已降级，不会被内存事件源的「已连接」盖掉', () => {
    vi.useFakeTimers()
    const statuses: EventStreamStatus[] = []

    // 关键：这里用的是真实的内存降级实现，而不是一个从不上报状态的替身。
    const adapter = createResilientEventsAdapter({
      fallback: () => createInMemoryEventsAdapter(() => createMockDataset(), { intervalMs: 10 }),
      probeMs: 50,
      createEventSource: (url) => new FakeEventSource(url),
    })

    const unsubscribe = adapter.subscribe({
      onStatus: (status) => statuses.push(status),
      onEvent: () => {},
    })

    FakeEventSource.latest()?.emitError()
    expect(statuses.at(-1)).toBe('degraded')

    // 内存事件源继续产出事件，但状态必须保持「已降级」——
    // 否则页头会在真正降级时显示「已连接」，把降级这件事藏起来。
    vi.advanceTimersByTime(20)
    expect(statuses.at(-1)).toBe('degraded')

    unsubscribe()
  })

  it('没有事件源能力时直接降级，并且仍然收得到事件', () => {
    vi.useFakeTimers()
    const statuses: EventStreamStatus[] = []
    const events: ElysianEvent[] = []

    const adapter = createResilientEventsAdapter({
      fallback: () => createInMemoryEventsAdapter(() => createMockDataset(), { intervalMs: 10 }),
    })

    adapter.subscribe({
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
    })

    expect(statuses).toEqual(['degraded'])
    vi.advanceTimersByTime(20)
    expect(events.length).toBeGreaterThan(0)
    expect(statuses.at(-1)).toBe('degraded')
  })
})

describe('SSE 实现丢弃坏数据', () => {
  afterEach(() => {
    FakeEventSource.reset()
  })

  it('内容不是合法信封的帧不会交给订阅者', () => {
    const events: ElysianEvent[] = []
    const adapter = createSseEventsAdapter({
      createEventSource: (url) => new FakeEventSource(url),
    })

    adapter.subscribe({ onStatus: () => {}, onEvent: (event) => events.push(event) })
    const source = FakeEventSource.latest()
    source?.emitOpen()
    source?.emitRaw('agent/status', '这不是 JSON')
    source?.emitRaw('agent/status', JSON.stringify({ id: 'evt-x' }))
    source?.emit('agent/status', SAMPLE_ENVELOPE)

    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe('evt-1')
  })
})

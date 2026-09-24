import type { ElysianEvent, EventStreamHandlers } from '@elysian/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventsAdapter } from '../contracts/adapters'
import { MAX_RECENT_EVENTS, onStreamEvent, useEventStreamStore } from './eventStreamStore'

function createStubAdapter() {
  const state = {
    handlers: undefined as EventStreamHandlers | undefined,
    unsubscribeCount: 0,
  }
  const adapter: EventsAdapter = {
    subscribe(handlers) {
      state.handlers = handlers
      return () => {
        state.unsubscribeCount += 1
      }
    },
  }
  return { adapter, state }
}

function makeEvent(id: string): ElysianEvent {
  return {
    id,
    name: 'incident/updated',
    at: '2026-09-12T08:00:00.000Z',
    payload: { incidentId: 'INC-2100' },
  }
}

function resetStore() {
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
}

describe('事件流 store', () => {
  afterEach(resetStore)

  it('按适配器上报的状态更新界面状态', () => {
    const stub = createStubAdapter()
    useEventStreamStore.getState().connect(stub.adapter)

    stub.state.handlers?.onStatus('live')
    expect(useEventStreamStore.getState().status).toBe('live')

    stub.state.handlers?.onStatus('degraded')
    expect(useEventStreamStore.getState().status).toBe('degraded')
  })

  it('事件按新到旧累积并计数', () => {
    const stub = createStubAdapter()
    useEventStreamStore.getState().connect(stub.adapter)

    stub.state.handlers?.onEvent(makeEvent('evt-1'))
    stub.state.handlers?.onEvent(makeEvent('evt-2'))

    const state = useEventStreamStore.getState()
    expect(state.receivedCount).toBe(2)
    expect(state.recent.map((event) => event.id)).toEqual(['evt-2', 'evt-1'])
  })

  it('只保留最近的一批事件，长时间运行不会无限增长', () => {
    const stub = createStubAdapter()
    useEventStreamStore.getState().connect(stub.adapter)

    for (let index = 0; index < MAX_RECENT_EVENTS + 5; index += 1) {
      stub.state.handlers?.onEvent(makeEvent(`evt-${index}`))
    }

    const state = useEventStreamStore.getState()
    expect(state.recent).toHaveLength(MAX_RECENT_EVENTS)
    expect(state.receivedCount).toBe(MAX_RECENT_EVENTS + 5)
  })

  it('容器事件不进最近活动也不计数，但监听器照常收到', () => {
    const stub = createStubAdapter()
    useEventStreamStore.getState().connect(stub.adapter)
    const seen: string[] = []
    const unsubscribe = onStreamEvent((event) => seen.push(event.id))

    stub.state.handlers?.onEvent(makeEvent('evt-real'))
    stub.state.handlers?.onEvent({
      id: 'evt-sample',
      name: 'container/sample',
      at: '2026-09-12T08:00:00.000Z',
      payload: { samples: [{ containerId: 'ctr-nginx-proxy', cpuPercent: 12, memMb: 64 }] },
    })
    stub.state.handlers?.onEvent({
      id: 'evt-updated',
      name: 'container/updated',
      at: '2026-09-12T08:00:00.000Z',
      payload: { containerId: 'ctr-nginx-proxy', status: 'running', startedAt: '2026-09-12T08:00:00.000Z' },
    })

    const state = useEventStreamStore.getState()
    expect(state.recent.map((event) => event.id)).toEqual(['evt-real'])
    expect(state.receivedCount).toBe(1)
    expect(seen).toEqual(['evt-real', 'evt-sample', 'evt-updated'])
    unsubscribe()
  })

  it('重复连接会先退订上一条订阅', () => {
    const first = createStubAdapter()
    const second = createStubAdapter()

    useEventStreamStore.getState().connect(first.adapter)
    useEventStreamStore.getState().connect(second.adapter)

    expect(first.state.unsubscribeCount).toBe(1)
  })

  it('断开后不再接收事件', () => {
    const stub = createStubAdapter()
    useEventStreamStore.getState().connect(stub.adapter)
    const handlers = stub.state.handlers

    useEventStreamStore.getState().disconnect()
    handlers?.onEvent(makeEvent('evt-late'))

    expect(stub.state.unsubscribeCount).toBe(1)
    expect(useEventStreamStore.getState().receivedCount).toBe(0)
  })
})

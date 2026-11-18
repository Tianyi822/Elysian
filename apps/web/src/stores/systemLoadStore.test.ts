import { act, cleanup, renderHook } from '@testing-library/react'
import type { ElysianEvent, PlatformMemorySample } from '@elysian/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventsAdapter, SystemLoad } from '../contracts/adapters'
import { platformMemorySample } from '../test/platformMemorySample'
import { useEventStreamStore } from './eventStreamStore'
import { useSystemLoad } from './systemLoadStore'

let visibility: DocumentVisibilityState

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  cleanup()
  useEventStreamStore.getState().disconnect()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

function deferredSample() {
  let resolve!: (sample: PlatformMemorySample) => void
  let reject!: (error: Error) => void
  const promise = new Promise<PlatformMemorySample>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('侧栏系统负载数据', () => {
  it('同一个 adapter 共享快照和周期读取，最后一个退订后清空', async () => {
    const read = vi.fn(async () => platformMemorySample({ rssMb: 120 }))
      .mockResolvedValueOnce(platformMemorySample())
    const adapter = { read }
    const first = renderHook(() => useSystemLoad(adapter))
    const second = renderHook(() => useSystemLoad(adapter))
    await tick(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(first.result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 80 } })
    expect(second.result.current.memory).toBe(first.result.current.memory)

    await tick(5_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(first.result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
    expect(second.result.current.memory).toBe(first.result.current.memory)
    first.unmount()
    await tick(5_000)
    expect(read).toHaveBeenCalledTimes(3)
    second.unmount()
    await tick(15_000)
    expect(read).toHaveBeenCalledTimes(3)

    const third = renderHook(() => useSystemLoad(adapter))
    expect(third.result.current.memory.status).toBe('loading')
    await tick(0)
    expect(read).toHaveBeenCalledTimes(4)
    expect(third.result.current.memory.status).toBe('ready')
  })

  it('慢请求不重叠，最后退订时取消，已废弃的回执不污染同一个 adapter 的新快照', async () => {
    const old = deferredSample()
    const read = vi.fn(async (_signal?: AbortSignal) => platformMemorySample({ rssMb: 120 }))
      .mockReturnValueOnce(old.promise)
    const adapter = { read }
    const first = renderHook(() => useSystemLoad(adapter))
    await tick(15_000)
    expect(read).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(read.mock.calls[0]?.[0]?.aborted).toBe(true)

    const second = renderHook(() => useSystemLoad(adapter))
    await tick(0)
    expect(second.result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
    await act(async () => { old.resolve(platformMemorySample()) })
    expect(second.result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
  })

  it('后台挂载不采样，恢复前台立即读取且只启动一次', async () => {
    visibility = 'hidden'
    const read = vi.fn(async () => platformMemorySample())
    const adapter = { read }
    const { result } = renderHook(() => useSystemLoad(adapter))
    await tick(30_000)
    expect(read).not.toHaveBeenCalled()
    expect(result.current.memory.status).toBe('loading')

    await act(async () => {
      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.memory.status).toBe('ready')
    await tick(5_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['visibilitychange', 'pagehide'])('%s 取消在途请求并保留快照，恢复后忽略旧失败', async event => {
    const old = deferredSample()
    const read = vi.fn(async (_signal?: AbortSignal) => platformMemorySample({ rssMb: 120 }))
      .mockResolvedValueOnce(platformMemorySample())
      .mockReturnValueOnce(old.promise)
    const adapter = { read }
    const { result } = renderHook(() => useSystemLoad(adapter))
    await tick(5_000)
    const previous = result.current.memory
    expect(previous).toMatchObject({ status: 'ready', sample: { rssMb: 80 } })

    act(() => {
      if (event === 'visibilitychange') setVisibility('hidden')
      else window.dispatchEvent(new Event('pagehide'))
    })
    expect(read.mock.calls[1]?.[0]?.aborted).toBe(true)
    await tick(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current.memory).toBe(previous)

    await act(async () => {
      if (event === 'visibilitychange') setVisibility('visible')
      else window.dispatchEvent(new Event('pageshow'))
    })
    expect(read).toHaveBeenCalledTimes(3)
    expect(result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
    await act(async () => { old.reject(new Error('late failure')) })
    expect(result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
  })

  it('替换 adapter 时隔离快照和仍在途的旧结果', async () => {
    const old = deferredSample()
    const read = vi.fn((_signal?: AbortSignal) => old.promise)
    const current = { read: vi.fn(async () => platformMemorySample({ rssMb: 120 })) }
    const { result, rerender } = renderHook(adapter => useSystemLoad(adapter), { initialProps: { read } })

    rerender(current)
    expect(read.mock.calls[0]?.[0]?.aborted).toBe(true)
    expect(result.current.memory.status).toBe('loading')
    await tick(0)
    expect(result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
    await act(async () => { old.resolve(platformMemorySample()) })
    expect(result.current.memory).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
  })

  it('复用现有 SSE，挂载后接收最新负载，晚挂载时回放缓存', async () => {
    function sample(id: string, load: SystemLoad): ElysianEvent {
      return {
        id, name: 'resource/sample', at: '2026-10-02T06:00:00Z',
        payload: { cpu: 1, memory: 20, networkIo: 3, networkRx: 3, networkTx: 0, diskIo: 2, diskRead: 2, diskWrite: 0, load },
      }
    }
    let emit!: (event: ElysianEvent) => void
    const subscribe = vi.fn<EventsAdapter['subscribe']>(handlers => {
      emit = handlers.onEvent
      return () => {}
    })
    useEventStreamStore.getState().connect({ subscribe })
    const adapter = { read: vi.fn(async () => platformMemorySample()) }
    const first = renderHook(() => useSystemLoad(adapter))
    expect(first.result.current.load).toBeUndefined()
    const load = { m1: 0.42, m5: 0.18, m15: 0.07 }
    await act(async () => { emit(sample('rs-1', load)) })
    expect(first.result.current.load).toEqual(load)
    const second = renderHook(() => useSystemLoad(adapter))
    expect(second.result.current.load).toEqual(load)
    await tick(0)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })
})

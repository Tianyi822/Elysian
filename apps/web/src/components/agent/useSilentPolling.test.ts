import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSilentPolling } from './useSilentPolling'
import { advancePoll } from '../../test/agentTestUtils'

let sequence = 0
const nextTask = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  nextTask.mockReset()
  sequence = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function deferredTask() {
  const calls: { resolve: () => void; reject: (error: Error) => void }[] = []
  const task = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    sequence += 1
    calls.push({ resolve: resolve, reject: reject })
  }))
  return { task, calls, nth: () => sequence }
}

describe('useSilentPolling', () => {
  it('首拍先等一个节奏，之后每次完成才排下一次', async () => {
    const { task } = deferredTask()
    renderHook(() => useSilentPolling(task, { intervalMs: 3000 }))
    expect(task).not.toHaveBeenCalled()
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(1)
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(1) // 第一轮未完成，不重叠
  })

  it('上一轮完成后下一轮按节奏触发；卸载后停排并中断在途请求', async () => {
    const { task, calls } = deferredTask()
    const signals: AbortSignal[] = []
    task.mockImplementation((signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('请求已取消', 'AbortError')))
      void resolve
    }))
    const view = renderHook(() => useSilentPolling(task, { intervalMs: 3000 }))
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(signals[0]?.aborted).toBe(true)
    await advancePoll(30_000)
    expect(task).toHaveBeenCalledTimes(1)
    void calls
  })

  it('连续失败退避 ×2 至上限，成功后复位节奏并清除 degraded', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const task = vi.fn(async () => {
      if (mode === 'fail') throw new Error('网络失败')
    })
    const { result } = renderHook(() => useSilentPolling(task, { intervalMs: 3000, maxBackoffMs: 10_000 }))
    await act(async () => { await advancePoll(3000) })
    expect(result.current.degraded).toBe(true)
    await act(async () => { await advancePoll(3000) })
    expect(task).toHaveBeenCalledTimes(1) // 退避 6000，尚未到点
    await act(async () => { await advancePoll(3000) })
    expect(task).toHaveBeenCalledTimes(2)
    await act(async () => { await advancePoll(10_000) })
    expect(task).toHaveBeenCalledTimes(3) // 退避 10000 封顶
    mode = 'ok'
    await act(async () => { await advancePoll(10_000) })
    expect(result.current.degraded).toBe(false)
    const count = task.mock.calls.length
    await act(async () => { await advancePoll(3000) })
    expect(task).toHaveBeenCalledTimes(count + 1) // 复位回 3000 节奏
  })

  it('enabled:false 暂停轮询，恢复 true 后重新起拍', async () => {
    const { task, calls } = deferredTask()
    const { rerender } = renderHook(({ enabled }: { enabled: boolean }) =>
      useSilentPolling(task, { intervalMs: 3000, enabled }), { initialProps: { enabled: false } })
    await advancePoll(30_000)
    expect(task).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(1)
    void calls
  })

  it('页面隐藏暂停，恢复可见立即补跑一轮', async () => {
    const task = vi.fn(async () => {})
    renderHook(() => useSilentPolling(task, { intervalMs: 3000 }))
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await advancePoll(30_000)
    expect(task).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await advancePoll(0)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('在途请求期间隐藏再恢复，不并发补跑', async () => {
    const { task, calls } = deferredTask()
    renderHook(() => useSilentPolling(task, { intervalMs: 3000 }))
    await advancePoll(3000)
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await advancePoll(30_000)
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { calls[0]!.resolve() })
    await advancePoll(3000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('间隔变化先 abort 旧轮，并等未响应取消的请求结束后再开新轮', async () => {
    const { task, calls } = deferredTask()
    const view = renderHook(({ intervalMs }: { intervalMs: number }) =>
      useSilentPolling(task, { intervalMs }), { initialProps: { intervalMs: 3000 } })
    await advancePoll(3000)
    const oldSignal = task.mock.calls[0]![0]
    view.rerender({ intervalMs: 1000 })
    expect(oldSignal.aborted).toBe(true)
    await advancePoll(1000)
    expect(task).toHaveBeenCalledTimes(1)
    await act(async () => { calls[0]!.resolve() })
    expect(task).toHaveBeenCalledTimes(2)
    expect(task.mock.calls[1]![0].aborted).toBe(false)
    view.unmount()
    expect(task.mock.calls[1]![0].aborted).toBe(true)
  })
})

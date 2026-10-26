import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeElementSize } from './observeElementSize'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren() })
describe('可选尺寸观察', () => {
  it.each(['missing', 'blocked'])('ResizeObserver %s 时窗口和内容变化仍会测量，退出后停止', async failure => {
    vi.useFakeTimers()
    const previousObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = (failure === 'missing' ? undefined : class { constructor() { throw new Error('blocked') } }) as unknown as typeof ResizeObserver
    try {
      const target = document.createElement('div')
      document.body.append(target)
      const measure = vi.fn()
      const cleanup = observeElementSize([target], measure)
      window.dispatchEvent(new Event('resize'))
      document.dispatchEvent(new Event('click'))
      await vi.advanceTimersByTimeAsync(20)
      expect(measure).toHaveBeenCalledOnce()
      target.textContent = '新内容'
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(20)
      expect(measure).toHaveBeenCalledTimes(2)
      window.dispatchEvent(new Event('resize'))
      cleanup()
      target.textContent = '已退出'
      await vi.advanceTimersByTimeAsync(40)
      expect(measure).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { globalThis.ResizeObserver = previousObserver }
  })
})

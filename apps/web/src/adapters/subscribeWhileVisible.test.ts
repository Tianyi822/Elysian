import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeWhileVisible } from './subscribeWhileVisible'

afterEach(() => vi.restoreAllMocks())

describe('页面展示订阅的连接生命周期', () => {
  it('后台页不连接，回到前台只订阅一次，切后台及卸载分别释放对应连接', () => {
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const cleanups: ReturnType<typeof vi.fn>[] = []
    const subscribe = vi.fn(() => { const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup })
    const dispose = subscribeWhileVisible(subscribe)
    expect(subscribe).not.toHaveBeenCalled()
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(subscribe).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cleanups[0]).toHaveBeenCalledOnce()
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(subscribe).toHaveBeenCalledTimes(2)
    dispose(); dispose()
    expect(cleanups[1]).toHaveBeenCalledOnce()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('页面离开时关闭连接，往返缓存恢复后再连接，即使 visibility 未变化', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const stop = vi.fn()
    const subscribe = vi.fn(() => stop)
    const dispose = subscribeWhileVisible(subscribe)
    window.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(stop).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('pageshow'))
    expect(subscribe).toHaveBeenCalledTimes(2)
    dispose()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})

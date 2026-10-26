import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaQuery, observeMediaQuery } from './mediaQuery'

afterEach(() => vi.unstubAllGlobals())
describe('可选媒体查询', () => {
  it('缺少或禁止媒体查询时不抛错', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(mediaQuery('(min-width: 768px)')).toBeUndefined()
    vi.stubGlobal('matchMedia', () => { throw new Error('blocked') })
    expect(mediaQuery('(min-width: 768px)')).toBeUndefined()
    expect(observeMediaQuery(undefined, vi.fn())).toBeTypeOf('function')
  })
  it('只提供旧式 addListener 的宿主仍能监听，并在退出时清理', () => {
    const addListener = vi.fn(), removeListener = vi.fn(), update = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener, removeListener }))
    const cleanup = observeMediaQuery(mediaQuery('(prefers-color-scheme: light)'), update)
    expect(addListener).toHaveBeenCalledWith(update)
    addListener.mock.calls[0]![0]()
    expect(update).toHaveBeenCalledOnce()
    cleanup()
    expect(removeListener).toHaveBeenCalledWith(update)
  })
})

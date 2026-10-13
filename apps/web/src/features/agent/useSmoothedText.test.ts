import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSmoothedText } from './useSmoothedText'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('流式文本缓冲', () => {
  it('按完整词块渐进显示，最终内容不丢失，撤回立即清空', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const text = '这是一段持续生成的文本，用于检查分组更新。 Hello streaming world. '.repeat(5)
    const { result, rerender } = renderHook(({ text }) => useSmoothedText(text, true), { initialProps: { text } })
    expect(result.current).toBe('')
    act(() => vi.advanceTimersByTime(64))
    expect(result.current.length).toBeGreaterThan(8)
    expect(result.current.length).toBeLessThan(text.length)
    expect(text.startsWith(result.current)).toBe(true)
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(text)
    rerender({ text: '' })
    expect(result.current).toBe('')
  })

  it('历史消息及减少动态效果偏好直接展示，不播放打字动画', () => {
    const history = renderHook(() => useSmoothedText('历史回答', false))
    expect(history.result.current).toBe('历史回答')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const reduced = renderHook(() => useSmoothedText('新的回答', true))
    expect(reduced.result.current).toBe('新的回答')
  })
})

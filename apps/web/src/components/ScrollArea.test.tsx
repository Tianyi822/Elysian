import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScrollArea } from './ScrollArea'

let resize: () => void
const OriginalResizeObserver = globalThis.ResizeObserver
beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this) }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => { globalThis.ResizeObserver = OriginalResizeObserver })

function renderArea(contentHeight = 1000) {
  render(<ScrollArea label="表单"><input aria-label="名称" /><div>表单内容</div></ScrollArea>)
  const viewport = screen.getByRole('region', { name: '表单' })
  const dimensions = { height: 200, content: contentHeight }
  Object.defineProperties(viewport, {
    clientHeight: { get: () => dimensions.height },
    scrollHeight: { get: () => dimensions.content },
  })
  act(() => resize())
  return { viewport, dimensions }
}

function pointer(element: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', clientY: number) {
  const event = createEvent[type](element)
  Object.defineProperties(event, {
    pointerId: { value: 1 }, isPrimary: { value: true }, button: { value: 0 }, clientY: { value: clientY },
  })
  fireEvent(element, event)
}

describe('自绘滚动区域', () => {
  it('内容溢出才显示，展开、收起与视口变化后重新判断', () => {
    const { dimensions } = renderArea(100)
    expect(screen.queryByRole('scrollbar')).toBeNull()
    dimensions.content = 1000
    act(() => resize())
    expect(screen.getByRole('scrollbar')).toHaveAttribute('aria-valuemax', '800')
    dimensions.height = 1100
    act(() => resize())
    expect(screen.queryByRole('scrollbar')).toBeNull()
  })

  it('原生滚动同步滑块，滚动条支持键盘且不截获表单输入', () => {
    const { viewport } = renderArea()
    const track = screen.getByRole('scrollbar')
    viewport.scrollTop = 150
    fireEvent.scroll(viewport)
    expect(track).toHaveAttribute('aria-valuenow', '150')
    fireEvent.keyDown(track, { key: 'End' })
    expect(viewport.scrollTop).toBe(800)
    fireEvent.keyDown(track, { key: 'Home' })
    expect(viewport.scrollTop).toBe(0)
    fireEvent.keyDown(track, { key: 'PageDown' })
    expect(viewport.scrollTop).toBe(200)
    fireEvent.keyDown(track, { key: 'ArrowDown' })
    expect(viewport.scrollTop).toBe(240)
    fireEvent.keyDown(screen.getByLabelText('名称'), { key: 'Home' })
    expect(viewport.scrollTop).toBe(240)
  })

  it('可拖动滑块或点击轨道，释放和取消后停止拖动', () => {
    const { viewport } = renderArea()
    const track = screen.getByRole('scrollbar')
    const thumb = track.firstElementChild!
    pointer(thumb, 'pointerDown', 10)
    pointer(track, 'pointerMove', 300)
    expect(viewport.scrollTop).toBe(800)
    pointer(track, 'pointerUp', 300)
    pointer(track, 'pointerMove', 0)
    expect(viewport.scrollTop).toBe(800)
    pointer(track, 'pointerDown', 0)
    expect(viewport.scrollTop).toBe(0)
    pointer(track, 'pointerCancel', 0)
    pointer(track, 'pointerMove', 300)
    expect(viewport.scrollTop).toBe(0)
  })

  it('轨道接收滚轮，内容区保留原生滚动及触控板缩放', () => {
    const { viewport } = renderArea()
    const track = screen.getByRole('scrollbar')
    fireEvent.wheel(track, { deltaY: 2, deltaMode: 1 })
    expect(viewport.scrollTop).toBe(32)
    fireEvent.wheel(track, { deltaY: 1, deltaMode: 2 })
    expect(viewport.scrollTop).toBe(232)
    const nativeWheel = createEvent.wheel(viewport, { deltaY: 10, cancelable: true })
    fireEvent(viewport, nativeWheel)
    expect(nativeWheel.defaultPrevented).toBe(false)
    const zoom = createEvent.wheel(track, { deltaY: 10, ctrlKey: true, cancelable: true })
    fireEvent(track, zoom)
    expect(zoom.defaultPrevented).toBe(false)
    expect(viewport.scrollTop).toBe(232)
  })
})

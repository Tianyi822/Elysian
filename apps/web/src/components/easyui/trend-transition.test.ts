import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { trendTransition, type TrendFrame } from './trend-transition'
import { useTrendAnimation } from './useTrendAnimation'

const frame = (end: number, times: number[]): TrendFrame => ({
  width: 300, start: end - 300_000, end, windowMs: 300_000,
  plots: [{ label: '内存', color: 'green', points: times.map(time => ({ time, x: (time - end + 300_000) / 1000, y: 28.9 })) }],
})

describe('实时趋势按时间平移', () => {
  it('淘汰旧点并增加新点时，共同采样向左移动且不落到零线', () => {
    const from = frame(300_000, [0, 5_000, 295_000, 300_000])
    const to = frame(305_000, [5_000, 295_000, 300_000, 305_000])
    const transition = trendTransition(from, to)!
    const middle = transition(0.5).plots[0]!.points
    expect(middle.find(point => point.time === 300_000)).toEqual({ time: 300_000, x: 297.5, y: 28.9 })
    expect(transition(1).plots[0]!.points[0]!.x).toBe(-5)
    expect(transition(0).plots[0]!.points.at(-1)!.x).toBe(305)
    expect(middle.every(point => point.y === 28.9)).toBe(true)
  })

  it('首屏逐点增加不依赖相同的 SVG 指令数', () => {
    const transition = trendTransition(frame(5_000, [5_000]), frame(10_000, [5_000, 10_000]))!
    expect(transition(0.5).plots[0]!.points).toHaveLength(2)
    expect(transition(0.5).plots[0]!.points[0]!.x).toBe(297.5)
  })

  it('切换时间范围、容器尺寸或断开的历史时直接安装完整几何', () => {
    const from = frame(300_000, [295_000, 300_000])
    const to = frame(305_000, [300_000, 305_000])
    expect(trendTransition(from, { ...to, windowMs: 600_000 })).toBeNull()
    expect(trendTransition(from, { ...to, width: 200 })).toBeNull()
    expect(trendTransition(from, frame(900_000, [895_000, 900_000]))).toBeNull()
  })

  it('减少动态效果时新采样直接落位', () => {
    const initial = frame(300_000, [295_000, 300_000])
    const next = frame(305_000, [300_000, 305_000])
    const { result, rerender } = renderHook(({ target }) => useTrendAnimation(target, true), { initialProps: { target: initial } })
    rerender({ target: next })
    expect(result.current).toBe(next)
  })
})

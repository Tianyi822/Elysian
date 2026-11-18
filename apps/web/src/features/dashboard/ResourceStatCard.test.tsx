import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResourceStatCard, sampleResourceTrend } from './ResourceStatCard'
import type { ResourceSamplePoint } from '../../contracts/resourceMetrics'

const base: ResourceSamplePoint = { ts: 1000, cpu: 10, memory: 20, networkIo: 0, networkRx: 0, networkTx: 0, diskIo: 0, diskRead: 0, diskWrite: 0 }

describe('EasyUI 统计卡资源适配', () => {
  it.each([0, 45, 100])('恒定内存 %s%% 始终使用 0–100%% 纵轴', memory => {
    const { container } = render(<ResourceStatCard metricKey="memory" points={[{ ...base, memory }, { ...base, ts: 6000, memory }]} />)
    const latest = container.querySelector('[data-trend-latest]')!
    expect(Number(latest.getAttribute('cy'))).toBeCloseTo(8 + (1 - memory / 100) * 38)
  })

  it('恒定的非零 IO 保留零基线，不误显示为零流量', () => {
    const { container } = render(<ResourceStatCard metricKey="networkIo" points={[{ ...base, networkRx: 10 }, { ...base, ts: 6000, networkRx: 10 }]} />)
    const markers = container.querySelectorAll('[data-trend-latest]')
    expect(Number(markers[0]!.getAttribute('cy'))).toBe(8)
    expect(Number(markers[1]!.getAttribute('cy'))).toBe(46)
  })

  it('追加和淘汰采样后保留原 SVG 和曲线节点，固定内存不发生纵向跳动', async () => {
    const start = [{ ...base, ts: 0, memory: 45 }, { ...base, ts: 300_000, memory: 45 }]
    const { container, rerender } = render(<ResourceStatCard metricKey="memory" points={start} />)
    const svg = container.querySelector('svg')
    const line = container.querySelector('[data-trend-line]')!
    rerender(<ResourceStatCard metricKey="memory" points={[...start, { ...base, ts: 305_000, memory: 45 }]} />)
    expect(container.querySelector('svg')).toBe(svg)
    expect(container.querySelector('[data-trend-line]')).toBe(line)
    await waitFor(() => expect(line.getAttribute('d')).toContain('28.90'))
    rerender(<ResourceStatCard metricKey="memory" points={[start[1]!, { ...base, ts: 310_000, memory: 45 }]} />)
    expect(container.querySelector('[data-trend-line]')).toBe(line)
    expect(Number(container.querySelector('[data-trend-latest]')!.getAttribute('cy'))).toBeCloseTo(28.9)
  })

  it('长窗抽样保留原始首尾、时间身份与数据值，滑窗中间点保持稳定', () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({ ...base, ts: index * 60_000, memory: index / 20 }))
    const first = sampleResourceTrend(points, 1000 * 60_000)
    const next = sampleResourceTrend([...points.slice(1), { ...base, ts: 1000 * 60_000 }], 1000 * 60_000)
    expect(first.length).toBeLessThanOrEqual(64)
    expect(first[0]).toBe(points[0])
    expect(first.at(-1)).toBe(points.at(-1))
    expect(first.every(point => points.includes(point))).toBe(true)
    expect(next.filter(point => first.includes(point)).length).toBeGreaterThan(55)
  })

  it('历史游标可用键盘浏览；退出后立即恢复最新真实读数', () => {
    render(<ResourceStatCard metricKey="cpu" points={[{ ...base, ts: 1000, cpu: 10 }, { ...base, ts: 9000, cpu: 87 }]} />)
    const card = screen.getByRole('group', { name: /CPU 使用率历史采样/ })
    expect(screen.getByText('87%')).toHaveClass('text-warning')
    fireEvent.keyDown(card, { key: 'ArrowLeft' })
    expect(screen.getByText('10%')).toHaveClass('text-fg')
    expect(screen.getByText(/历史采样 ·/)).toBeInTheDocument()
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.getByText('87%')).toHaveClass('text-warning')
    expect(screen.getByText('当前采样 · 移动查看趋势')).toBeInTheDocument()
  })

  it('新增采样直接显示当前值，不播放从旧读数递增的动画', () => {
    const { rerender } = render(<ResourceStatCard metricKey="memory" points={[{ ...base, memory: 20 }]} />)
    rerender(<ResourceStatCard metricKey="memory" points={[{ ...base, memory: 20 }, { ...base, ts: base.ts + 5000, memory: 91 }]} />)
    expect(screen.getByText('91%')).toHaveClass('text-warning')
    expect(screen.queryByText('20%')).not.toBeInTheDocument()
  })

  it.each([
    { metricKey: 'networkIo' as const, label: '网络 IO', directions: ['下行', '上行'], current: ['180 MB/s', '420 MB/s'], history: ['120 MB/s', '240 MB/s'], total: '600 MB/s', previousTotal: '360 MB/s' },
    { metricKey: 'diskIo' as const, label: '磁盘 IO', directions: ['读取', '写入'], current: ['200 MB/s', '500 MB/s'], history: ['100 MB/s', '300 MB/s'], total: '700 MB/s', previousTotal: '400 MB/s' },
  ])('$label 同时展示双向指标，历史游标与总量保持同一采样', ({ metricKey, label, directions, current, history, total, previousTotal }) => {
    const first = { ...base, networkRx: 120, networkTx: 240, networkIo: 360, diskRead: 100, diskWrite: 300, diskIo: 400 }
    const last = { ...base, ts: 9000, networkRx: 180, networkTx: 420, networkIo: 600, diskRead: 200, diskWrite: 500, diskIo: 700 }
    render(<ResourceStatCard metricKey={metricKey} points={[first, last]} />)
    const card = screen.getByRole('group', { name: `${label}历史采样，使用左右方向键查看，Escape 返回当前值` })
    expect(screen.getByText(total)).toBeInTheDocument()
    directions.forEach((direction, index) => expect(screen.getByLabelText(direction)).toHaveTextContent(current[index]!))
    expect(screen.getByRole('img', { name: `${label}趋势：${directions.join('、')}` })).toBeInTheDocument()
    fireEvent.keyDown(card, { key: 'ArrowLeft' })
    expect(screen.getByText(previousTotal)).toBeInTheDocument()
    directions.forEach((direction, index) => expect(screen.getByLabelText(direction)).toHaveTextContent(history[index]!))
    fireEvent.keyDown(card, { key: 'Escape' })
    directions.forEach((direction, index) => expect(screen.getByLabelText(direction)).toHaveTextContent(current[index]!))
  })
})

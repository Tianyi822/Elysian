import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResourceStatCard } from './ResourceStatCard'
import type { ResourceSamplePoint } from '../../adapters/mock/resourceMetrics'

const base: ResourceSamplePoint = { ts: 1000, cpu: 10, memory: 20, networkIo: 0, networkRx: 0, networkTx: 0, diskIo: 0, diskRead: 0, diskWrite: 0 }

describe('EasyUI 统计卡资源适配', () => {
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

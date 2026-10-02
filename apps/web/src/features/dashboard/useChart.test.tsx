import { act, render } from '@testing-library/react'
import * as echarts from 'echarts/core'
import { describe, expect, it } from 'vitest'
import type { ResourceSamplePoint } from '../../adapters/mock/resourceMetrics'
import './chartComponents'
import { buildResourceTrendOption, type ChartPalette } from './chartOptions'
import { useChart } from './useChart'

const PALETTE: ChartPalette = {
  text: '#tt',
  subtle: '#ss',
  axisLine: '#aa',
  accent: '#ac',
  surface: '#sf',
}

function makePoints(count: number, baseTs = 1_700_000_000_000): ResourceSamplePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: baseTs + index * 5_000,
    cpu: 50,
    memory: 60,
    networkIo: 100,
    networkRx: 100 + index,
    networkTx: 20,
    diskIo: 80,
    diskRead: 80,
    diskWrite: 10,
  }))
}

function Harness({ points, palette }: { points: readonly ResourceSamplePoint[]; palette: ChartPalette }) {
  const last = points[points.length - 1]
  const { containerRef } = useChart(
    () => buildResourceTrendOption(points, 'networkIo', palette),
    `net:${palette.accent}:${points.length}:${last?.ts ?? 0}`,
  )
  return <div ref={containerRef} style={{ width: 400, height: 200 }} />
}

function legendSelected(chart: echarts.ECharts): Record<string, boolean> {
  const option = chart.getOption() as { legend?: ReadonlyArray<{ selected?: Record<string, boolean> }> }
  return option.legend?.[0]?.selected ?? {}
}

function colors(chart: echarts.ECharts) {
  const option = chart.getOption() as {
    legend?: ReadonlyArray<{ textStyle?: { color?: string } }>
    series?: ReadonlyArray<{ lineStyle?: { color?: string } }>
  }
  return {
    legend: option.legend?.[0]?.textStyle?.color,
    line: option.series?.[0]?.lineStyle?.color,
  }
}

const ALT_PALETTE: ChartPalette = { ...PALETTE, accent: '#ff0000', text: '#000000' }

describe('useChart 更新补丁', () => {
  it('新采样并入后仍保留图例的取消选择：5 秒刷新不把隐藏的系列放回来', () => {
    const { container, rerender } = render(<Harness points={makePoints(40)} palette={PALETTE} />)
    const el = container.firstElementChild as HTMLElement
    const chart = echarts.getInstanceByDom(el)
    expect(chart).toBeDefined()
    if (!chart) return

    act(() => chart.dispatchAction({ type: 'legendUnSelect', name: '上行' }))
    expect(legendSelected(chart)['上行']).toBe(false)

    act(() => rerender(<Harness points={makePoints(41)} palette={PALETTE} />))

    expect(legendSelected(chart)['上行']).toBe(false)
  })

  it('配色换档后图例与折线取到新色，不残留旧色', () => {
    const { container, rerender } = render(<Harness points={makePoints(40)} palette={PALETTE} />)
    const el = container.firstElementChild as HTMLElement
    const chart = echarts.getInstanceByDom(el)
    expect(chart).toBeDefined()
    if (!chart) return

    act(() => rerender(<Harness points={makePoints(40)} palette={ALT_PALETTE} />))

    expect(colors(chart)).toEqual({ legend: ALT_PALETTE.text, line: ALT_PALETTE.accent })
  })

  it('框选缩放跨一拍保留：新采样不把视野冲回全量', () => {
    const { container, rerender } = render(<Harness points={makePoints(40)} palette={PALETTE} />)
    const el = container.firstElementChild as HTMLElement
    const chart = echarts.getInstanceByDom(el)
    expect(chart).toBeDefined()
    if (!chart) return

    const zoomOf = () => {
      const option = chart.getOption() as {
        dataZoom?: ReadonlyArray<{ start?: number; end?: number }>
      }
      return { start: option.dataZoom?.[0]?.start, end: option.dataZoom?.[0]?.end }
    }

    act(() => chart.dispatchAction({ type: 'dataZoom', start: 40, end: 70 }))
    expect(zoomOf()).toEqual({ start: 40, end: 70 })

    act(() => rerender(<Harness points={makePoints(41)} palette={PALETTE} />))

    expect(zoomOf()).toEqual({ start: 40, end: 70 })
  })
})

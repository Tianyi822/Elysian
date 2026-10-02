import { describe, expect, it } from 'vitest'
import type { ResourceSamplePoint } from '../../adapters/mock/resourceMetrics'
import {
  buildResourceTrendOption,
  readChartPalette,
} from './chartOptions'
import type { ChartPalette } from './chartOptions'

const PALETTE: ChartPalette = {
  text: '#tt',
  subtle: '#ss',
  axisLine: '#aa',
  accent: '#ac',
  surface: '#sf',
}

function makePoints(count: number, baseTs = 1_700_000_000_000): ResourceSamplePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: baseTs + index * 3_000,
    cpu: 50 + index,
    memory: 60 + index,
    networkIo: 100,
    networkRx: 100,
    networkTx: 0,
    diskIo: 80,
    diskRead: 80,
    diskWrite: 0,
  }))
}

describe('图表配色读取', () => {
  it('jsdom 解析不了 CSS 令牌时按主题回落，深浅两套不同', () => {
    const dark = readChartPalette('dark')
    const light = readChartPalette('light')
    expect(dark.text).not.toBe(light.text)
    expect(dark.accent).not.toBe(light.accent)
  })
})

describe('资源趋势 option', () => {
  it('单系列，数据点数与采样点一致，颜色取强调色', () => {
    const points = makePoints(7)
    const option = buildResourceTrendOption(points, 'cpu', PALETTE)

    const series = option.series as ReadonlyArray<{
      id: string
      data: ReadonlyArray<{ id: string; value: [number, number] }>
      itemStyle: { color: string }
    }>
    expect(series).toHaveLength(1)
    expect(series[0]?.id).toBe('resource-cpu')
    // 每个点把时间戳当作 id：滚动窗里同一个采样点保持身份，折线才会左移而不是重新入场
    expect(series[0]?.data).toEqual(
      points.map((point) => ({ id: String(point.ts), value: [point.ts, point.cpu] })),
    )
    expect(series[0]?.itemStyle.color).toBe(PALETTE.accent)

    expect(option.animation).toBe(true)
    expect(option.animationDurationUpdate).toBeLessThanOrEqual(300)
    expect(option.animationEasingUpdate).toBe('linear')
    expect(option.dataZoom).toBeTruthy()
  })

  it('横纵坐标轴可见：X 轴为时间轴、Y 轴带单位并显示刻度', () => {
    const points = makePoints(7)
    const option = buildResourceTrendOption(points, 'cpu', PALETTE)

    const xAxis = option.xAxis as {
      type: string
      show: boolean
      axisLabel: { color: string }
      axisLine: { show: boolean }
    }
    const yAxis = option.yAxis as {
      show: boolean
      name: string
      max?: number
      axisLabel: { color: string }
      splitLine: { show: boolean }
    }

    expect(xAxis.type).toBe('time')
    expect(xAxis.show).toBe(true)
    expect(xAxis.axisLine.show).toBe(true)
    expect(xAxis.axisLabel.color).toBe(PALETTE.subtle)

    expect(yAxis.show).toBe(true)
    expect(yAxis.name).toBe('%')
    expect(yAxis.max).toBe(100)
    expect(yAxis.splitLine.show).toBe(true)
  })

  it('吞吐类指标按峰值换算纵轴单位，且不锁 100 上限', () => {
    const points = makePoints(3).map((point) => ({
      ...point,
      networkIo: 0.05,
      networkRx: 0.03,
      networkTx: 0.02,
    }))
    const option = buildResourceTrendOption(points, 'networkIo', PALETTE)
    const yAxis = option.yAxis as { name: string; max?: number }
    expect(yAxis.name).toBe('KB/s')
    expect(yAxis.max).toBeUndefined()
  })

  it('网络与磁盘为双折线（上下行 / 读写），其余仍为单系列', () => {
    const points = makePoints(5)
    const memory = buildResourceTrendOption(points, 'memory', PALETTE)
    expect((memory.series as ReadonlyArray<{ id: string }>).map((s) => s.id)).toEqual([
      'resource-memory',
    ])

    const network = buildResourceTrendOption(points, 'networkIo', PALETTE)
    expect((network.series as ReadonlyArray<{ id: string; name: string }>).map((s) => s.name)).toEqual([
      '下行',
      '上行',
    ])
    expect(network.legend).toEqual(
      expect.objectContaining({ data: ['下行', '上行'] }),
    )

    const disk = buildResourceTrendOption(points, 'diskIo', PALETTE)
    expect((disk.series as ReadonlyArray<{ name: string }>).map((s) => s.name)).toEqual(['读', '写'])
  })

  it('启用 inside dataZoom 与横向 brush 框选', () => {
    const option = buildResourceTrendOption(makePoints(2), 'cpu', PALETTE)
    const zoom = option.dataZoom as ReadonlyArray<{ type: string }>
    expect(zoom.map((entry) => entry.type)).toEqual(['inside'])
    expect(option.brush).toEqual(
      expect.objectContaining({
        brushType: 'lineX',
        xAxisIndex: 0,
      }),
    )
  })

  it('折线随滚动窗左移：首屏不入场、更新按线性缓动平移，系列不再关动画', () => {
    const option = buildResourceTrendOption(makePoints(60), 'cpu', PALETTE)
    const series = option.series as ReadonlyArray<{ animation?: boolean }>

    expect(option.animationDuration).toBe(0)
    expect(series[0]?.animation).toBeUndefined()
    expect(option.animationDurationUpdate).toBeGreaterThan(0)
    expect(option.animationDurationUpdate).toBeLessThanOrEqual(300)
    expect(option.animationEasingUpdate).toBe('linear')
  })
})

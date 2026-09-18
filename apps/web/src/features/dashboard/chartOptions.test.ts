import { describe, expect, it } from 'vitest'
import type { ResourceSamplePoint } from '../../adapters/mock/resourceMetrics'
import {
  buildDiskBarsOption,
  buildLoadBarsOption,
  buildResourceTrendOption,
  readChartPalette,
} from './chartOptions'
import type { ChartPalette } from './chartOptions'

const PALETTE: ChartPalette = {
  text: '#tt',
  subtle: '#ss',
  axisLine: '#aa',
  accent: '#ac',
  warning: '#wn',
  danger: '#dg',
  surface: '#sf',
}

function makePoints(count: number, baseTs = 1_700_000_000_000): ResourceSamplePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    ts: baseTs + index * 3_000,
    cpu: 50 + index,
    memory: 60 + index,
    networkIo: 100,
    diskIo: 80,
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
      data: readonly [number, number][]
      itemStyle: { color: string }
    }>
    expect(series).toHaveLength(1)
    expect(series[0]?.id).toBe('resource-cpu')
    expect(series[0]?.data).toEqual(points.map((point) => [point.ts, point.cpu]))
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

  it('吞吐类指标 Y 轴单位为 MB/s 且不锁 100 上限', () => {
    const points = makePoints(3)
    const option = buildResourceTrendOption(points, 'networkIo', PALETTE)
    const yAxis = option.yAxis as { name: string; max?: number }
    expect(yAxis.name).toBe('MB/s')
    expect(yAxis.max).toBeUndefined()
  })

  it('各资源指标共用同一配色策略（强调色），互不依赖严重等级令牌', () => {
    const points = makePoints(5)
    for (const key of ['memory', 'networkIo', 'diskIo'] as const) {
      const option = buildResourceTrendOption(points, key, PALETTE)
      const series = option.series as ReadonlyArray<{ id: string }>
      expect(series[0]?.id).toBe(`resource-${key}`)
    }
  })

  it('启用 inside 与 slider 两类 dataZoom', () => {
    const option = buildResourceTrendOption(makePoints(2), 'cpu', PALETTE)
    const zoom = option.dataZoom as ReadonlyArray<{ type: string }>
    expect(zoom.map((entry) => entry.type)).toEqual(['inside', 'slider'])
  })
})

describe('运行负载条形图 option', () => {
  it('三个类目按 15/5/1 分钟自下而上排列，数值保留两位小数标签', () => {
    const option = buildLoadBarsOption({ m1: 0.4, m5: 0.08, m15: 0.02 }, PALETTE)

    const yAxis = option.yAxis as { data: readonly string[] }
    expect(yAxis.data).toEqual(['15 分钟', '5 分钟', '1 分钟'])

    const series = option.series as ReadonlyArray<{
      id: string
      data: ReadonlyArray<{ value: number }>
    }>
    expect(series[0]?.id).toBe('load-bars')
    expect(series[0]?.data.map((entry) => entry.value)).toEqual([0.02, 0.08, 0.4])
  })

  it('数值轴上限固定为 2.5，与 load average 的演示区间一致', () => {
    const option = buildLoadBarsOption({ m1: 2.4, m5: 0.1, m15: 0.05 }, PALETTE)
    expect((option.xAxis as { max: number }).max).toBe(2.5)
  })
})

describe('磁盘占用条形图 option', () => {
  it('每个挂载点一条，类目顺序自下而上反转', () => {
    const disks = [
      { mount: '/', usagePct: 62 },
      { mount: '/data', usagePct: 78 },
      { mount: '/backup', usagePct: 41 },
    ]
    const option = buildDiskBarsOption(disks, PALETTE)

    const yAxis = option.yAxis as { data: readonly string[] }
    expect(yAxis.data).toEqual(['/backup', '/data', '/'])

    const series = option.series as ReadonlyArray<{
      id: string
      data: ReadonlyArray<{ value: number }>
    }>
    expect(series[0]?.data.map((entry) => entry.value)).toEqual([41, 78, 62])
  })

  it('阈值着色沿用 df 惯例：≥80 警告、≥90 危险、其余强调色', () => {
    const disks = [
      { mount: '/', usagePct: 62 },
      { mount: '/data', usagePct: 85 },
      { mount: '/backup', usagePct: 91 },
    ]
    const option = buildDiskBarsOption(disks, PALETTE)
    const series = option.series as ReadonlyArray<{
      data: ReadonlyArray<{ itemStyle: { color: string } }>
    }>
    // builder 反转入栈：数组顺序是 backup(91 危险)、data(85 警告)、/(62 强调)
    expect(series[0]?.data.map((entry) => entry.itemStyle.color)).toEqual([
      PALETTE.danger,
      PALETTE.warning,
      PALETTE.accent,
    ])
  })
})

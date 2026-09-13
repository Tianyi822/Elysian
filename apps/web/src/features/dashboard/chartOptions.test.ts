import { describe, expect, it } from 'vitest'
import { createResourceMetrics, sliceResourceMetrics } from '../../adapters/mock/resourceMetrics'
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

describe('图表配色读取', () => {
  it('jsdom 解析不了 CSS 令牌时按主题回落，深浅两套不同', () => {
    const dark = readChartPalette('dark')
    const light = readChartPalette('light')
    expect(dark.text).not.toBe(light.text)
    expect(dark.accent).not.toBe(light.accent)
  })
})

describe('资源趋势 option', () => {
  it('单系列，数据点数与天数一致，颜色取强调色', () => {
    const days = sliceResourceMetrics(createResourceMetrics(), '7d')
    const option = buildResourceTrendOption(days, 'cpu', PALETTE)

    const series = option.series as ReadonlyArray<{
      id: string
      data: readonly number[]
      itemStyle: { color: string }
    }>
    expect(series).toHaveLength(1)
    expect(series[0]?.id).toBe('resource-cpu')
    expect(series[0]?.data).toEqual(days.map((day) => day.cpu))
    expect(series[0]?.itemStyle.color).toBe(PALETTE.accent)

    const xAxis = option.xAxis as { data: readonly string[] }
    expect(xAxis.data).toHaveLength(7)
  })

  it('各资源指标共用同一配色策略（强调色），互不依赖严重等级令牌', () => {
    const days = createResourceMetrics()
    for (const key of ['memory', 'networkIo', 'diskIo'] as const) {
      const option = buildResourceTrendOption(days, key, PALETTE)
      const series = option.series as ReadonlyArray<{ id: string }>
      expect(series[0]?.id).toBe(`resource-${key}`)
    }
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

import { describe, expect, it } from 'vitest'
import { sliceTrend } from '../../adapters/mock/timeseries'
import { createIncidentTrend } from '../../adapters/mock/timeseries'
import { createResourceMetrics, sliceResourceMetrics } from '../../adapters/mock/resourceMetrics'
import { buildDistributionOption, buildResourceTrendOption, buildTrendOption, readChartPalette } from './chartOptions'
import type { ChartPalette } from './chartOptions'

const PALETTE: ChartPalette = {
  sev: { sev1: '#c1', sev2: '#c2', sev3: '#c3', sev4: '#c4' },
  text: '#tt',
  subtle: '#ss',
  axisLine: '#aa',
  accent: '#kk',
  surface: '#ff',
}

describe('严重等级分布 option', () => {
  it('四个扇区与分布数值一一对应，颜色来自调色板', () => {
    const option = buildDistributionOption({ sev1: 2, sev2: 5, sev3: 7, sev4: 3 }, PALETTE)
    const series = option.series as ReadonlyArray<{
      id?: string
      data: ReadonlyArray<{ name: string; value: number; itemStyle: { color: string } }>
    }>
    const pie = series.find((entry) => entry.id === 'severity-distribution')
    expect(pie).toBeDefined()

    expect(pie?.data.map((entry) => entry.value)).toEqual([2, 5, 7, 3])
    expect(pie?.data.map((entry) => entry.name)).toEqual(['致命', '严重', '一般', '提示'])
    expect(pie?.data.map((entry) => entry.itemStyle.color)).toEqual(['#c1', '#c2', '#c3', '#c4'])
  })
})

describe('事故趋势 option', () => {
  it('四条严重等级系列，数据点数与天数一致，颜色来自调色板', () => {
    const days = sliceTrend(createIncidentTrend(), '7d')
    const option = buildTrendOption(days, PALETTE)

    expect((option.xAxis as { data: readonly string[] }).data).toHaveLength(7)
    const series = option.series as ReadonlyArray<{
      id: string
      name: string
      data: readonly number[]
      itemStyle: { color: string }
    }>

    expect(series.map((entry) => entry.name)).toEqual(['致命', '严重', '一般', '提示'])
    const keys = ['sev1', 'sev2', 'sev3', 'sev4'] as const
    for (const [index, key] of keys.entries()) {
      expect(series[index]?.data).toEqual(days.map((day) => day[key]))
      expect(series[index]?.itemStyle.color).toBe(PALETTE.sev[key])
    }
  })

  it('范围切换就是数据点数变化：30 天序列切 7 天后为 7 个点', () => {
    const option = buildTrendOption(sliceTrend(createIncidentTrend(), '30d'), PALETTE)
    expect((option.xAxis as { data: readonly string[] }).data).toHaveLength(30)
  })
})

describe('资源迷你趋势 option', () => {
  it('单系列数据与指标数值一一对应，线色来自 accent 令牌', () => {
    const days = sliceResourceMetrics(createResourceMetrics(), '7d')
    const option = buildResourceTrendOption(days, 'cpu', PALETTE)

    const [series] = option.series as [
      {
        id: string
        data: readonly number[]
        itemStyle: { color: string }
      },
    ]
    expect(series.id).toBe('resource-cpu')
    expect(series.data).toEqual(days.map((day) => day.cpu))
    expect(series.itemStyle.color).toBe(PALETTE.accent)
  })

  it('sparkline 不画坐标轴标签，悬浮由 tooltip 提供日期与数值', () => {
    const days = sliceResourceMetrics(createResourceMetrics(), '7d')
    const option = buildResourceTrendOption(days, 'memory', PALETTE)

    const xAxis = option.xAxis as { show: boolean; data: readonly string[] }
    const yAxis = option.yAxis as { show: boolean }
    expect(xAxis.show).toBe(false)
    expect(yAxis.show).toBe(false)
    expect(xAxis.data).toEqual(days.map((day) => day.date))
    expect((option.tooltip as { trigger: string }).trigger).toBe('axis')
  })
})

describe('图表配色读取', () => {
  it('jsdom 解析不了 CSS 令牌时按主题回落，深浅两套不同', () => {
    const dark = readChartPalette('dark')
    const light = readChartPalette('light')
    expect(dark.sev.sev1).not.toBe(light.sev.sev1)
    expect(dark.text).not.toBe(light.text)
  })

  it('accent 令牌同样按主题读取', () => {
    const dark = readChartPalette('dark')
    const light = readChartPalette('light')
    expect(dark.accent).not.toBe(light.accent)
  })
})

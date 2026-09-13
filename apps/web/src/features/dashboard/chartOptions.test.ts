import { describe, expect, it } from 'vitest'
import { createResourceMetrics, sliceResourceMetrics } from '../../adapters/mock/resourceMetrics'
import { buildResourceTrendOption, readChartPalette } from './chartOptions'
import type { ChartPalette } from './chartOptions'

const PALETTE: ChartPalette = {
  text: '#tt',
  subtle: '#ss',
  axisLine: '#aa',
  accent: '#ac',
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

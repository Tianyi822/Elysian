import { describe, expect, it } from 'vitest'
import type { ResourceSamplePoint } from '../../adapters/mock/resourceMetrics'
import {
  buildDiskRingOption,
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
    expect(option.animationDuration).toBe(0)
    const series = option.series as ReadonlyArray<{ animation?: boolean }>
    expect(series[0]?.animation).toBe(false)
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

describe('磁盘占用环图 option', () => {
  it('环图含全部挂载点，图例只列已用容量最高的 5 项', () => {
    const disks = [
      { mount: '/', usagePct: 10, usedKb: 100, sizeKb: 1000 },
      { mount: '/a', usagePct: 20, usedKb: 200, sizeKb: 1000 },
      { mount: '/b', usagePct: 30, usedKb: 300, sizeKb: 1000 },
      { mount: '/c', usagePct: 40, usedKb: 400, sizeKb: 1000 },
      { mount: '/d', usagePct: 50, usedKb: 500, sizeKb: 1000 },
      { mount: '/e', usagePct: 60, usedKb: 600, sizeKb: 1000 },
      { mount: '/f', usagePct: 5, usedKb: 50, sizeKb: 1000 },
    ]
    const option = buildDiskRingOption(disks, PALETTE)
    const series = option.series as ReadonlyArray<{
      id: string
      type: string
      center: [string, string]
      data: ReadonlyArray<{ name: string; value: number }>
    }>
    expect(series[0]?.id).toBe('disk-ring')
    expect(series[0]?.type).toBe('pie')
    expect(series[0]?.center[0]).toBe('24%')
    expect(series[0]?.data.map((entry) => entry.name)).toEqual(disks.map((disk) => disk.mount))
    expect(series[0]?.data.map((entry) => entry.value)).toEqual(disks.map((disk) => disk.usedKb))

    const legend = option.legend as { data: readonly string[]; selectedMode: boolean; left: string }
    expect(legend.selectedMode).toBe(false)
    expect(legend.left).toBe('46%')
    expect(legend.data).toEqual(['/e', '/d', '/c', '/b', '/a'])
  })

  it('阈值着色：≥80 警告、≥90 危险', () => {
    const disks = [
      { mount: '/', usagePct: 62, usedKb: 620, sizeKb: 1000 },
      { mount: '/data', usagePct: 85, usedKb: 850, sizeKb: 1000 },
      { mount: '/backup', usagePct: 91, usedKb: 910, sizeKb: 1000 },
    ]
    const option = buildDiskRingOption(disks, PALETTE)
    const series = option.series as ReadonlyArray<{
      data: ReadonlyArray<{ name: string; itemStyle: { color: string } }>
    }>
    const byMount = Object.fromEntries(
      series[0]!.data.map((entry) => [entry.name, entry.itemStyle.color]),
    )
    expect(byMount['/']).toBe(PALETTE.accent)
    expect(byMount['/data']).toBe(PALETTE.warning)
    expect(byMount['/backup']).toBe(PALETTE.danger)
  })
})

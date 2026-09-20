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

  it('演示区间下量程停在 2.5，真实 loadavg 越界时量程上浮', () => {
    const demo = buildLoadBarsOption({ m1: 2.4, m5: 0.1, m15: 0.05 }, PALETTE)
    expect((demo.xAxis as { max: number }).max).toBe(2.5)

    // 多核宿主上 load 常年过 2.5：钉死上限会把轨道顶满、刻度说谎。
    const busy = buildLoadBarsOption({ m1: 6.8, m5: 5.2, m15: 3.1 }, PALETTE)
    expect((busy.xAxis as { max: number }).max).toBe(7)
  })

  it('轨道常显，低读数时读起来是刻度而非空白', () => {
    const option = buildLoadBarsOption({ m1: 0.15, m5: 0.14, m15: 0.32 }, PALETTE)
    const series = option.series as ReadonlyArray<{
      showBackground: boolean
      barWidth: number
      backgroundStyle: { borderRadius: number }
      data: ReadonlyArray<{ itemStyle: { borderRadius: number } }>
    }>
    expect(series[0]?.showBackground).toBe(true)
    expect(series[0]?.backgroundStyle.borderRadius).toBe((series[0]?.barWidth ?? 0) / 2)
    expect(series[0]?.data[0]?.itemStyle.borderRadius).toBe((series[0]?.barWidth ?? 0) / 2)
  })

  it('轨道铺满整行，读数固定在标签列', () => {
    const load = { m1: 0.16, m5: 0.13, m15: 0.1 }
    const narrow = buildLoadBarsOption(load, PALETTE, { width: 340, height: 176 })
    const wide = buildLoadBarsOption(load, PALETTE, { width: 1200, height: 300 })
    const labelOf = (option: ReturnType<typeof buildLoadBarsOption>) =>
      option.yAxis as {
        axisLabel: {
          formatter: (label: string, index: number) => string
          rich: { name: { fontSize: number }; value: { fontSize: number; width: number } }
        }
      }

    // 右侧只留一条边距：宽卡片不再空出一片，轨道本身就是到上限的刻度。
    expect((wide.grid as { right: number }).right).toBeLessThan(40)
    // 类目轴自下而上：'1 分钟' 落在最后一个位置。
    expect(labelOf(wide).axisLabel.formatter('1 分钟', 2)).toBe('{name|1 分钟} {value|0.16}')
    expect(labelOf(wide).axisLabel.formatter('15 分钟', 0)).toBe('{name|15 分钟} {value|0.10}')
    expect(labelOf(wide).axisLabel.rich.value.fontSize).toBeGreaterThan(
      labelOf(narrow).axisLabel.rich.value.fontSize,
    )
    const barWidthOf = (option: ReturnType<typeof buildLoadBarsOption>) =>
      (option.series as ReadonlyArray<{ barWidth: number }>)[0]!.barWidth
    expect(barWidthOf(wide)).toBeGreaterThan(barWidthOf(narrow))
  })

  it('读数列宽随最宽读数算，多位数不会把右对齐挤坏', () => {
    const small = buildLoadBarsOption({ m1: 0.16, m5: 0.13, m15: 0.1 }, PALETTE, {
      width: 1200,
      height: 300,
    })
    const large = buildLoadBarsOption({ m1: 1024.5, m5: 0.13, m15: 0.1 }, PALETTE, {
      width: 1200,
      height: 300,
    })
    const columnOf = (option: ReturnType<typeof buildLoadBarsOption>) =>
      (option.yAxis as { axisLabel: { rich: { value: { width: number } } } }).axisLabel.rich.value
        .width

    expect(columnOf(large)).toBeGreaterThan(columnOf(small))
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
      center: [number, string]
      data: ReadonlyArray<{ name: string; value: number }>
    }>
    expect(series[0]?.id).toBe('disk-ring')
    expect(series[0]?.type).toBe('pie')
    expect(series[0]?.data.map((entry) => entry.name)).toEqual(disks.map((disk) => disk.mount))
    expect(series[0]?.data.map((entry) => entry.value)).toEqual(disks.map((disk) => disk.usedKb))

    const legend = option.legend as { data: readonly string[]; selectedMode: boolean }
    expect(legend.selectedMode).toBe(false)
    expect(legend.data).toEqual(['/e', '/d', '/c', '/b', '/a'])
  })

  it('环与图例按像素紧邻成组：间隙不随卡片变宽而放大', () => {
    const disks = [
      { mount: '/', usagePct: 62, usedKb: 620_000, sizeKb: 1_000_000 },
      { mount: '/data', usagePct: 78, usedKb: 1_560_000, sizeKb: 2_000_000 },
    ]
    const geometry = (option: ReturnType<typeof buildDiskRingOption>) => {
      const series = option.series as ReadonlyArray<{
        center: [number, string]
        radius: [number, number]
      }>
      const legend = option.legend as { left: number }
      const [inner, outer] = series[0]!.radius
      return {
        gap: legend.left - (series[0]!.center[0] + outer),
        ringLeft: series[0]!.center[0] - outer,
        hole: outer - inner,
      }
    }
    const narrow = geometry(buildDiskRingOption(disks, PALETTE, { width: 340, height: 176 }))
    const wide = geometry(buildDiskRingOption(disks, PALETTE, { width: 1200, height: 300 }))

    expect(wide.gap).toBe(narrow.gap)
    // 窄卡整组仍贴左缘，宽卡整组居中：留白分到两侧，而不是全堆在右边。
    expect(narrow.ringLeft).toBeLessThan(60)
    expect(wide.ringLeft).toBeGreaterThan(narrow.ringLeft * 3)
    // 环随卡片长高而变大，不是钉死在小尺寸。
    expect(wide.hole).toBeGreaterThan(narrow.hole)
  })

  it('长挂载点先吃掉图例的宽度预算，环为此让位而不是把图例挤出容器', () => {
    const geometry = (option: ReturnType<typeof buildDiskRingOption>) => {
      const series = option.series as ReadonlyArray<{ radius: [number, number] }>
      const legend = option.legend as {
        left: number
        textStyle: { rich: { label: { overflow?: string; width?: number } } }
      }
      return {
        radius: series[0]!.radius[1],
        legendLeft: legend.left,
        labelStyle: legend.textStyle.rich.label,
      }
    }
    const size = { width: 264, height: 160 }
    const short = geometry(
      buildDiskRingOption([{ mount: '/', usagePct: 62, usedKb: 620, sizeKb: 1000 }], PALETTE, size),
    )
    const long = geometry(
      buildDiskRingOption(
        [{ mount: '/var/lib/elysian', usagePct: 62, usedKb: 620, sizeKb: 1000 }],
        PALETTE,
        size,
      ),
    )

    expect(long.radius).toBeLessThan(short.radius)
    expect(long.legendLeft).toBeLessThan(short.legendLeft)
    // 预算兜底仍放不下时退成省略号，而不是被容器右缘切一半。
    expect(long.labelStyle.overflow).toBe('truncate')
    expect(long.labelStyle.width).toBeGreaterThan(0)
    expect(long.legendLeft + (long.labelStyle.width ?? 0)).toBeLessThanOrEqual(size.width)
  })

  it('图例右侧够宽才补容量明细，窄卡只留挂载点与占用率', () => {
    const disks = [{ mount: '/backup', usagePct: 41, usedKb: 2_050_000, sizeKb: 5_000_000 }]
    const narrowLegend = buildDiskRingOption(disks, PALETTE, { width: 340, height: 176 })
      .legend as { formatter: (name: string) => string }
    const wideLegend = buildDiskRingOption(disks, PALETTE, { width: 1200, height: 300 })
      .legend as { formatter: (name: string) => string }

    expect(narrowLegend.formatter('/backup')).toBe('{label|/backup  41%}')
    expect(wideLegend.formatter('/backup')).toContain('2.0 GB / 4.8 GB')
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

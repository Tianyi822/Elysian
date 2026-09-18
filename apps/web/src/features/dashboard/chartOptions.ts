import type { EChartsCoreOption } from 'echarts/core'
import {
  RESOURCE_METRIC_UNITS,
  type ResourceMetricKey,
  type ResourceSamplePoint,
} from '../../adapters/mock/resourceMetrics'
import { mbpsToUnit, pickThroughputUnit } from './formatMetricDisplay'

/**
 * 图表配置的组装纯函数与配色读取。
 *
 * option 组装与 ECharts 实例管理刻意分离：测试直接断言 option 的系列与数据点，
 * 不需要 canvas。配色从语义令牌取值（读不到时按主题回落到与 CSS 相同的值，
 * 这主要发生在 jsdom 里），深浅主题因此自动跟随。
 */

export type ChartPalette = {
  text: string
  subtle: string
  axisLine: string
  /** 强调色，供资源趋势图使用。 */
  accent: string
  /** 警告与危险色，供磁盘占用阈值着色。 */
  warning: string
  danger: string
  /** 图表浮层表面色，供浅色主题避免继承 ECharts 默认深色浮层。 */
  surface?: string
}

const DARK_FALLBACK: ChartPalette = {
  text: '#e8eef5',
  subtle: '#7c8ea3',
  axisLine: '#28323f',
  accent: '#4c8dff',
  warning: '#d29922',
  danger: '#f85149',
  surface: '#131a23',
}

const LIGHT_FALLBACK: ChartPalette = {
  text: '#1f2328',
  subtle: '#6e7781',
  axisLine: '#d0d7de',
  accent: '#0969da',
  warning: '#9a6700',
  danger: '#cf222e',
  surface: '#ffffff',
}

/** 按主题读取图表配色：优先取 CSS 语义令牌，取不到时用同值回落。 */
export function readChartPalette(theme: 'dark' | 'light'): ChartPalette {
  const fallback = theme === 'dark' ? DARK_FALLBACK : LIGHT_FALLBACK
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback

  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallbackValue: string): string =>
    style.getPropertyValue(name).trim() || fallbackValue

  return {
    text: read('--t-fg', fallback.text),
    subtle: read('--t-fg-subtle', fallback.subtle),
    axisLine: read('--t-line', fallback.axisLine),
    accent: read('--t-accent', fallback.accent),
    warning: read('--t-warning', fallback.warning),
    danger: read('--t-danger', fallback.danger),
    surface: read('--t-surface-raised', fallback.surface ?? fallback.axisLine),
  }
}

/**
 * 资源指标趋势 option：时间轴；图内横向框选（brush）+ inside 平移/滚轮。
 * 吞吐类按窗口峰值换算纵轴单位。网络/磁盘为双折线面积图（上下行、读写）。
 * 更新动画只做水平滑动，不做从 0 弹起。
 */
export function buildResourceTrendOption(
  points: readonly ResourceSamplePoint[],
  key: ResourceMetricKey,
  palette: ChartPalette,
): EChartsCoreOption {
  const storedUnit = RESOURCE_METRIC_UNITS[key]
  const percentScale = storedUnit === '%'
  const throughput = storedUnit === 'MB/s'
  const dualIo =
    key === 'networkIo'
      ? ({
          a: 'networkRx' as const,
          b: 'networkTx' as const,
          labelA: '下行',
          labelB: '上行',
        } as const)
      : key === 'diskIo'
        ? ({
            a: 'diskRead' as const,
            b: 'diskWrite' as const,
            labelA: '读',
            labelB: '写',
          } as const)
        : null

  const peakValues = dualIo
    ? points.flatMap((point) => [point[dualIo.a], point[dualIo.b]])
    : points.map((point) => point[key])
  const throughputUnit = throughput ? pickThroughputUnit(peakValues) : undefined
  const axisUnit = throughputUnit ?? storedUnit
  const secondary = '#3ecf8e'

  const mapSeries = (field: 'networkRx' | 'networkTx' | 'diskRead' | 'diskWrite' | ResourceMetricKey) =>
    points.map((point) => {
      const raw = point[field]
      const value = throughputUnit ? mbpsToUnit(raw, throughputUnit) : raw
      return [point.ts, value] as [number, number]
    })

  const dualSeries = dualIo
    ? [
        {
          id: `resource-${key}-${dualIo.a}`,
          name: dualIo.labelA,
          type: 'line' as const,
          smooth: true,
          showSymbol: false,
          animation: false,
          data: mapSeries(dualIo.a),
          itemStyle: { color: palette.accent },
          lineStyle: { color: palette.accent, width: 1.5 },
          areaStyle: { color: palette.accent, opacity: 0.1 },
        },
        {
          id: `resource-${key}-${dualIo.b}`,
          name: dualIo.labelB,
          type: 'line' as const,
          smooth: true,
          showSymbol: false,
          animation: false,
          data: mapSeries(dualIo.b),
          itemStyle: { color: secondary },
          lineStyle: { color: secondary, width: 1.5 },
          areaStyle: { color: secondary, opacity: 0.08 },
        },
      ]
    : [
        {
          id: `resource-${key}`,
          name: key,
          type: 'line' as const,
          smooth: true,
          showSymbol: false,
          animation: false,
          data: mapSeries(key),
          itemStyle: { color: palette.accent },
          lineStyle: { color: palette.accent, width: 1.5 },
          areaStyle: { color: palette.accent, opacity: 0.12 },
        },
      ]

  const formatThroughput = (numeric: number): string => {
    const rounded =
      Math.abs(numeric) >= 100
        ? String(Math.round(numeric))
        : Math.abs(numeric) >= 10
          ? numeric.toFixed(1)
          : numeric.toFixed(2)
    return `${rounded} ${axisUnit}`
  }

  return {
    textStyle: { color: palette.text, fontSize: 12 },
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 300,
    animationEasingUpdate: 'linear',
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.surface,
      borderColor: palette.axisLine,
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
      valueFormatter: (value: unknown) => {
        const numeric = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(numeric)) return '—'
        if (percentScale) return `${numeric}%`
        if (throughput) return formatThroughput(numeric)
        return String(numeric)
      },
    },
    ...(dualIo
      ? {
          legend: {
            data: [dualIo.labelA, dualIo.labelB],
            top: 0,
            right: 4,
            itemWidth: 10,
            itemHeight: 6,
            textStyle: { color: palette.text, fontSize: 13 },
          },
        }
      : {}),
    grid: { left: 12, right: 16, top: dualIo ? 36 : 28, bottom: 8, containLabel: true },
    brush: {
      toolbox: [],
      xAxisIndex: 0,
      brushLink: 'all',
      brushType: 'lineX',
      brushMode: 'single',
      transformable: false,
      throttleType: 'debounce',
      throttleDelay: 50,
      removeOnClick: false,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(76, 141, 255, 0.16)',
        borderColor: palette.accent,
      },
      outOfBrush: { colorAlpha: 0.35 },
    },
    dataZoom: [
      {
        type: 'inside',
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: false,
        moveOnMouseWheel: 'shift',
        preventDefaultMouseMove: true,
      },
    ],
    xAxis: {
      type: 'time',
      show: true,
      boundaryGap: false,
      min: 'dataMin',
      max: 'dataMax',
      axisLine: { show: true, lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.subtle,
        fontSize: 11,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      show: true,
      name: axisUnit,
      nameTextStyle: { color: palette.subtle, fontSize: 11, padding: [0, 0, 0, 4] },
      ...(percentScale ? { max: 100, min: 0 } : {}),
      axisLine: { show: true, lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: palette.subtle, fontSize: 11 },
      splitLine: { show: true, lineStyle: { color: palette.axisLine, type: 'dashed' } },
    },
    series: dualSeries,
  }
}

/**
 * 横向条形图（ECharts 类目轴在 Y、数值在 X）：用于运行负载。
 * 只读展示：禁悬停变形与 tooltip。
 */
export function buildLoadBarsOption(
  load: { m1: number; m5: number; m15: number },
  palette: ChartPalette,
): EChartsCoreOption {
  const windows = [
    { key: 'm1' as const, label: '1 分钟' },
    { key: 'm5' as const, label: '5 分钟' },
    { key: 'm15' as const, label: '15 分钟' },
  ]
  return {
    animationDurationUpdate: 500,
    animationEasingUpdate: 'linear',
    tooltip: { show: false },
    grid: { left: 8, right: 48, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'value', show: false, max: 2.5 },
    yAxis: {
      type: 'category',
      data: windows.map((window) => window.label).reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.subtle, fontSize: 13 },
    },
    series: [
      {
        id: 'load-bars',
        type: 'bar',
        silent: true,
        cursor: 'default',
        barWidth: 10,
        emphasis: { disabled: true },
        data: windows
          .map((window) => ({
            value: load[window.key],
            itemStyle: { color: palette.accent, borderRadius: 5 },
          }))
          .reverse(),
        label: {
          show: true,
          position: 'right',
          color: palette.text,
          fontSize: 13,
          formatter: ({ value }: { value: number }) => value.toFixed(2),
        },
      },
    ],
  }
}

const DISK_RING_LEGEND_LIMIT = 5

function diskRingColor(usagePct: number, index: number, palette: ChartPalette): string {
  if (usagePct >= 90) return palette.danger
  if (usagePct >= 80) return palette.warning
  const cycle = [palette.accent, '#6ea8fe', '#38bdf8', '#8b7cf7', '#3ecf8e', '#a78bfa']
  return cycle[index % cycle.length]!
}

function formatDiskKiB(kib: number): string {
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MB`
  return `${Math.round(kib)} KB`
}

/** 磁盘占用环图：扇区按已用容量；右侧图例常显已用最高的 5 项；悬停看占用率与容量。 */
export function buildDiskRingOption(
  disks: ReadonlyArray<{ mount: string; usagePct: number; usedKb: number; sizeKb: number }>,
  palette: ChartPalette,
): EChartsCoreOption {
  const ranked = [...disks].sort(
    (a, b) => b.usedKb - a.usedKb || b.usagePct - a.usagePct || a.mount.localeCompare(b.mount),
  )
  const legendMounts = ranked.slice(0, DISK_RING_LEGEND_LIMIT).map((disk) => disk.mount)
  const byMount = new Map(disks.map((disk) => [disk.mount, disk]))

  return {
    animationDurationUpdate: 500,
    animationEasingUpdate: 'linear',
    tooltip: {
      trigger: 'item',
      backgroundColor: palette.surface,
      borderColor: palette.axisLine,
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const item = params as { name?: string }
        const disk = byMount.get(item.name ?? '')
        if (!disk) return item.name ?? ''
        return `${disk.mount}<br/>占用 ${disk.usagePct}%<br/>已用 ${formatDiskKiB(disk.usedKb)} / ${formatDiskKiB(disk.sizeKb)}`
      },
    },
    legend: {
      type: 'plain',
      orient: 'vertical',
      left: '46%',
      top: 'middle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      icon: 'circle',
      selectedMode: false,
      data: legendMounts,
      textStyle: {
        color: palette.text,
        fontSize: 13,
        rich: {
          label: { color: palette.text, fontSize: 13, lineHeight: 18 },
        },
      },
      formatter: (name: string) => {
        const disk = byMount.get(name)
        const text = disk === undefined ? name : `${name}  ${disk.usagePct}%`
        return `{label|${text}}`
      },
    },
    textStyle: { color: palette.text, fontSize: 13 },
    series: [
      {
        id: 'disk-ring',
        type: 'pie',
        radius: ['46%', '68%'],
        // 环与图例紧邻：环偏左、图例紧随其后，中间不留大块空白。
        center: ['24%', '50%'],
        cursor: 'default',
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scale: false,
          itemStyle: { shadowBlur: 0 },
        },
        data: disks.map((disk, index) => ({
          name: disk.mount,
          // 扇区按已用 KiB，避免把各挂载点「自身占用率」当成同一总量的份额。
          value: Math.max(disk.usedKb, 0),
          itemStyle: {
            color: diskRingColor(disk.usagePct, index, palette),
            borderRadius: 2,
            borderColor: palette.surface ?? palette.axisLine,
            borderWidth: 2,
          },
        })),
      },
    ],
  }
}


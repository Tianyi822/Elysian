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

/** 图表容器的实测尺寸，供按像素摆位的小图（负载条、磁盘环）随卡片宽高超适应。 */
export type ChartSize = { width: number; height: number }

/** 首帧与 jsdom 量不到尺寸（全为 0）时回落到窄屏卡片的常见尺寸，避免几何算成 0。 */
const SIZE_FALLBACK: ChartSize = { width: 340, height: 176 }

function resolveSize(size: ChartSize | undefined): ChartSize {
  return {
    width: size && size.width > 0 ? size.width : SIZE_FALLBACK.width,
    height: size && size.height > 0 ? size.height : SIZE_FALLBACK.height,
  }
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
 * 数据点以时间戳为 id：一拍里窗口前进不止一格（补发、丢帧）时，逐点配对仍然精确，
 * 折线整体平移到新位置；但「不整条重画」的前提是更新按 id 合并同一系列与图例，
 * 见 useChart——按组件重建会让整批点重新入场，也会清掉图例的取消选择。
 * 首屏用 animationDuration: 0 直接落图，不做入场。
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
      // id 钉在时间戳上：窗口前进不止一格时（补发、丢帧）同一个采样点仍能与旧帧逐点配对，
      // 折线于是整体平移到新位置，而不是逐点各走各路。
      return { id: String(point.ts), value: [point.ts, value] as [number, number] }
    })

  const dualSeries = dualIo
    ? [
        {
          id: `resource-${key}-${dualIo.a}`,
          name: dualIo.labelA,
          type: 'line' as const,
          smooth: true,
          showSymbol: false,
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

/** 卡片宽到这个档就按宽屏排：小图的字号与几何随档位上调，不再挤在小卡尺寸上。 */
const WIDE_CARD_WIDTH = 720

/** 负载计量条的最小量程：演示里 load 常年低于 1，留一条稳定量程免得轨道被噪声撑满。 */
const LOAD_AXIS_FLOOR = 2.5

/**
 * 横向计量条（ECharts 类目轴在 Y、数值在 X）：用于运行负载。
 * 轨道铺满整行常显，读数固定在标签列里——宽卡片下这一行读到的是
 * 「窗口 + 读数 + 到上限的刻度」，右侧不留空白，读数也不随条形长短漂移。
 * 量程随读数上浮（真实 loadavg 不封顶），标签列宽度按最宽的字算，换档时不跳列。
 * 只读展示：禁悬停变形与 tooltip。
 */
export function buildLoadBarsOption(
  load: { m1: number; m5: number; m15: number },
  palette: ChartPalette,
  size?: ChartSize,
): EChartsCoreOption {
  const { width, height } = resolveSize(size)
  const nameSize = width >= WIDE_CARD_WIDTH ? 14 : 13
  const valueSize = width >= WIDE_CARD_WIDTH ? 17 : 15
  // 卡片被同行趋势卡拉高时三行各摊到更多空间，条宽跟高度长，不留一排细线。
  const barWidth = Math.round(Math.min(22, Math.max(10, height * 0.075)))
  const windows = [
    { key: 'm1' as const, label: '1 分钟' },
    { key: 'm5' as const, label: '5 分钟' },
    { key: 'm15' as const, label: '15 分钟' },
  ]
  // 类目轴自下而上：倒序后下标就是轴标签的位置，读数按位置取，不靠显示字符串回查。
  const ordered = [...windows].reverse()
  const values = ordered.map((window) => load[window.key])
  const axisMax = Math.max(LOAD_AXIS_FLOOR, Math.ceil(Math.max(...values) * 2) / 2)
  const nameColumn = Math.round(Math.max(...ordered.map((w) => measureText(w.label, nameSize))) + 6)
  const valueColumn =
    Math.round(Math.max(...values.map((value) => measureText(value.toFixed(2), valueSize)))) + 8
  return {
    animationDurationUpdate: 500,
    animationEasingUpdate: 'linear',
    tooltip: { show: false },
    grid: { left: 8, right: 12, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'value', show: false, max: axisMax },
    yAxis: {
      type: 'category',
      data: ordered.map((window) => window.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        margin: 10,
        formatter: (label: string, index: number) =>
          `{name|${label}} {value|${(values[index] ?? 0).toFixed(2)}}`,
        rich: {
          name: {
            color: palette.subtle,
            fontSize: nameSize,
            width: nameColumn,
            align: 'left' as const,
          },
          value: {
            color: palette.text,
            fontSize: valueSize,
            fontWeight: 600,
            width: valueColumn,
            align: 'right' as const,
          },
        },
      },
    },
    series: [
      {
        id: 'load-bars',
        type: 'bar',
        silent: true,
        cursor: 'default',
        barWidth,
        showBackground: true,
        backgroundStyle: { color: palette.axisLine, borderRadius: barWidth / 2 },
        emphasis: { disabled: true },
        data: values.map((value) => ({
          value,
          itemStyle: { color: palette.accent, borderRadius: barWidth / 2 },
        })),
        label: { show: false },
      },
    ],
  }
}

const DISK_RING_LEGEND_LIMIT = 5
/** 环与图例之间的固定间隙：两者成一组摆位，间隙不随卡片变宽而放大。 */
const DISK_RING_LEGEND_GAP = 20
const DISK_RING_EDGE_PADDING = 12
const DISK_RING_MAX_RADIUS = 168
/** 图例条目的排版常量：色点宽、色点与文字的间隙、行距。 */
const DISK_LEGEND_ICON = 9
const DISK_LEGEND_ICON_GAP = 6

/** 估算一行文字的像素宽度：CJK 按整号宽，拉丁与数字按 0.56 号宽。 */
function measureText(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) width += char.charCodeAt(0) > 0x2e80 ? fontSize : fontSize * 0.56
  return Math.round(width)
}

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

/** 磁盘占用环图：扇区按已用容量；左侧环 + 右侧图例常显已用最高的 5 项；悬停看占用率与容量。 */
export function buildDiskRingOption(
  disks: ReadonlyArray<{ mount: string; usagePct: number; usedKb: number; sizeKb: number }>,
  palette: ChartPalette,
  size?: ChartSize,
): EChartsCoreOption {
  const { width, height } = resolveSize(size)
  const ranked = [...disks].sort(
    (a, b) => b.usedKb - a.usedKb || b.usagePct - a.usagePct || a.mount.localeCompare(b.mount),
  )
  const legendDisks = ranked.slice(0, DISK_RING_LEGEND_LIMIT)
  const legendMounts = legendDisks.map((disk) => disk.mount)
  const byMount = new Map(disks.map((disk) => [disk.mount, disk]))

  const fontSize = width >= WIDE_CARD_WIDTH ? 15 : 13
  const capacitySize = fontSize - 2
  const lineHeight = fontSize + 6
  const entryText = (disk: { mount: string; usagePct: number; usedKb: number; sizeKb: number }) =>
    `${disk.mount}  ${disk.usagePct}%  ${formatDiskKiB(disk.usedKb)} / ${formatDiskKiB(disk.sizeKb)}`
  const shortText = (disk: { mount: string; usagePct: number }) => `${disk.mount}  ${disk.usagePct}%`
  const legendWidth = (withCapacity: boolean) =>
    legendDisks.length === 0
      ? 0
      : Math.max(
          ...legendDisks.map(
            (disk) =>
              DISK_LEGEND_ICON +
              DISK_LEGEND_ICON_GAP +
              measureText(withCapacity ? entryText(disk) : shortText(disk), fontSize),
          ),
        )

  // 宽度预算先给图例留够：环最多长到「容器宽 − 图例最短可读宽度」的一半，
  // 长挂载点（如 /var/lib/elysian）在窄卡下也不会被容器右缘裁掉。
  const radiusFromLegendBudget =
    (width -
      DISK_RING_EDGE_PADDING * 2 -
      DISK_RING_LEGEND_GAP -
      legendWidth(false)) /
    2
  // 环取「高度可给」「宽度可给」「图例要得」里的最小者：卡片越高环越大，但绝不挤出图例。
  const radius = Math.max(
    36,
    Math.min(
      DISK_RING_MAX_RADIUS,
      (height - DISK_RING_EDGE_PADDING * 2) / 2,
      width * 0.34 - DISK_RING_EDGE_PADDING,
      radiusFromLegendBudget,
    ),
  )
  // 明细放得下就带上；放不下先退掉明细，再让整组居中，右侧就不留大片空白。
  const groupWidth = (withCapacity: boolean) =>
    DISK_RING_EDGE_PADDING * 2 + radius * 2 + DISK_RING_LEGEND_GAP + legendWidth(withCapacity)
  const showCapacity = groupWidth(true) <= width
  const offset = Math.max(0, Math.round((width - groupWidth(showCapacity)) / 2))
  const centerX = Math.round(offset + DISK_RING_EDGE_PADDING + radius)
  const legendLeft = Math.round(
    offset + DISK_RING_EDGE_PADDING + radius * 2 + DISK_RING_LEGEND_GAP,
  )
  // 预算兜底后仍放不下（极窄容器 + 超长挂载点）时退成省略号，而不是被切一半。
  const tightLabelWidth = showCapacity
    ? undefined
    : Math.max(40, width - legendLeft - DISK_RING_EDGE_PADDING)

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
      left: legendLeft,
      top: 'middle',
      itemWidth: DISK_LEGEND_ICON,
      itemHeight: DISK_LEGEND_ICON,
      itemGap: fontSize >= 15 ? 18 : 12,
      icon: 'circle',
      selectedMode: false,
      data: legendMounts,
      textStyle: {
        color: palette.text,
        fontSize,
        rich: {
          label: {
            color: palette.text,
            fontSize,
            lineHeight,
            ...(tightLabelWidth === undefined
              ? {}
              : { width: tightLabelWidth, overflow: 'truncate' as const, ellipsis: '…' }),
          },
          capacity: { color: palette.subtle, fontSize: capacitySize, lineHeight },
        },
      },
      formatter: (name: string) => {
        const disk = byMount.get(name)
        if (disk === undefined) return `{label|${name}}`
        const head = `{label|${name}  ${disk.usagePct}%}`
        return showCapacity
          ? `${head} {capacity|${formatDiskKiB(disk.usedKb)} / ${formatDiskKiB(disk.sizeKb)}}`
          : head
      },
    },
    textStyle: { color: palette.text, fontSize },
    series: [
      {
        id: 'disk-ring',
        type: 'pie',
        radius: [Math.round(radius * 0.66), Math.round(radius)],
        center: [centerX, '50%'],
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


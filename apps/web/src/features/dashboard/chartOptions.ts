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
  /** 图表浮层表面色，供浅色主题避免继承 ECharts 默认深色浮层。 */
  surface?: string
}

/** 图表容器的实测尺寸，供 useChart 在尺寸变化时重排图表。 */
export type ChartSize = { width: number; height: number }

const DARK_FALLBACK: ChartPalette = {
  text: '#e8eef5',
  subtle: '#7c8ea3',
  axisLine: '#28323f',
  accent: '#4c8dff',
  surface: '#131a23',
}

const LIGHT_FALLBACK: ChartPalette = {
  text: '#1f2328',
  subtle: '#6e7781',
  axisLine: '#d0d7de',
  accent: '#0969da',
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


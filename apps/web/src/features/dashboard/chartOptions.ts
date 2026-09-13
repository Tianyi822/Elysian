import type { EChartsCoreOption } from 'echarts/core'
import type { DailyResourceMetrics, ResourceMetricKey } from '../../adapters/mock/resourceMetrics'

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
  /** 强调色，供单系列迷你趋势图使用。 */
  accent: string
  /** 图表浮层表面色，供浅色主题避免继承 ECharts 默认深色浮层。 */
  surface?: string
}

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
 * 资源指标的 sparkline option：不画坐标轴，数值靠 tooltip 读取；
 * 日期走 category 轴提供，悬浮提示因此自带日期。
 */
export function buildResourceTrendOption(
  days: readonly DailyResourceMetrics[],
  key: ResourceMetricKey,
  palette: ChartPalette,
): EChartsCoreOption {
  return {
    textStyle: { color: palette.text, fontSize: 12 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.surface,
      borderColor: palette.axisLine,
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
    },
    grid: { left: 8, right: 8, top: 8, bottom: 0 },
    xAxis: {
      type: 'category',
      show: false,
      boundaryGap: false,
      data: days.map((day) => day.date),
    },
    yAxis: { type: 'value', show: false },
    series: [
      {
        id: `resource-${key}`,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: days.map((day) => day[key]),
        itemStyle: { color: palette.accent },
        lineStyle: { color: palette.accent, width: 1.5 },
        areaStyle: { color: palette.accent, opacity: 0.12 },
      },
    ],
  }
}

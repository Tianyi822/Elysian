import { SEVERITIES, SEVERITY_LABELS } from '@elysian/contracts'
import type { Severity } from '@elysian/contracts'
import type { EChartsCoreOption } from 'echarts/core'
import type { DailyIncidents } from '../../adapters/mock/timeseries'

/**
 * 图表配置的组装纯函数与配色读取。
 *
 * option 组装与 ECharts 实例管理刻意分离：测试直接断言 option 的系列与数据点，
 * 不需要 canvas。配色从语义令牌取值（读不到时按主题回落到与 CSS 相同的值，
 * 这主要发生在 jsdom 里），深浅主题因此自动跟随。
 */

export type ChartPalette = {
  sev: Record<Severity, string>
  text: string
  subtle: string
  axisLine: string
  /** 图表浮层表面色，供浅色主题避免继承 ECharts 默认深色浮层。 */
  surface?: string
}

const DARK_FALLBACK: ChartPalette = {
  sev: { sev1: '#ff8a80', sev2: '#f0a45e', sev3: '#e3c04a', sev4: '#9fb0c0' },
  text: '#e8eef5',
  subtle: '#7c8ea3',
  axisLine: '#28323f',
  surface: '#131a23',
}

const LIGHT_FALLBACK: ChartPalette = {
  sev: { sev1: '#d6455d', sev2: '#d97706', sev3: '#b08900', sev4: '#7b8794' },
  text: '#1f2328',
  subtle: '#6e7781',
  axisLine: '#d0d7de',
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
    sev: {
      sev1: read('--t-sev1-fg', fallback.sev.sev1),
      sev2: read('--t-sev2-fg', fallback.sev.sev2),
      sev3: read('--t-sev3-fg', fallback.sev.sev3),
      sev4: read('--t-sev4-fg', fallback.sev.sev4),
    },
    text: read('--t-fg', fallback.text),
    subtle: read('--t-fg-subtle', fallback.subtle),
    axisLine: read('--t-line', fallback.axisLine),
    surface: read('--t-surface-raised', fallback.surface ?? fallback.axisLine),
  }
}

export function buildDistributionOption(
  distribution: Record<Severity, number>,
  palette: ChartPalette,
): EChartsCoreOption {
  return {
    textStyle: { color: palette.text, fontSize: 12 },
    tooltip: {
      trigger: 'item',
      backgroundColor: palette.surface,
      borderColor: palette.axisLine,
      borderWidth: 1,
      textStyle: { color: palette.text, fontSize: 12 },
    },
    legend: { show: false },
    series: [
      {
        id: 'severity-distribution',
        name: '严重等级分布',
        type: 'pie',
        radius: ['55%', '82%'],
        label: { show: false },
        data: SEVERITIES.map((severity) => ({
          name: SEVERITY_LABELS[severity],
          value: distribution[severity],
          itemStyle: { color: palette.sev[severity] },
        })),
      },
    ],
  }
}

export function buildTrendOption(
  days: readonly DailyIncidents[],
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
      axisPointer: {
        type: 'line',
        lineStyle: { color: palette.subtle, width: 1 },
      },
    },
    legend: {
      top: 0,
      textStyle: { color: palette.subtle, fontSize: 12 },
      itemWidth: 14,
      itemHeight: 10,
      itemGap: 16,
    },
    grid: { left: 12, right: 12, top: 34, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: days.map((day) => day.date.slice(5)),
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: palette.subtle, fontSize: 11, margin: 10 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: palette.axisLine } },
      axisLabel: { color: palette.subtle, fontSize: 11, margin: 10 },
      axisTick: { show: false },
    },
    series: SEVERITIES.map((severity) => ({
      id: `trend-${severity}`,
      name: SEVERITY_LABELS[severity],
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: days.map((day) => day[severity]),
      itemStyle: { color: palette.sev[severity] },
      lineStyle: { color: palette.sev[severity], width: 2 },
    })),
  }
}

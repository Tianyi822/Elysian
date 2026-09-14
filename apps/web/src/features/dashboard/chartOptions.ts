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
 * 资源指标的 sparkline option：不画坐标轴，数值靠 tooltip 读取；
 * X 轴使用稳定的槽位索引，避免滚动窗口更新时触发首点 remove/尾点 add 的 diff；
 * 日期由轴标签格式化提供给 tooltip。
 */
export function buildResourceTrendOption(
  days: readonly DailyResourceMetrics[],
  key: ResourceMetricKey,
  palette: ChartPalette,
): EChartsCoreOption {
  return {
    textStyle: { color: palette.text, fontSize: 12 },
    // ECharts 官方的更新动画配置：动画在下一拍之前完成，避免频繁重启动画。
    animation: true,
    animationDurationUpdate: 1600,
    animationEasingUpdate: 'linear',
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
      // 槽位保持不变，滚动时只更新数值，曲线会整体平滑移动而不会先清空左端。
      data: days.map((_, index) => String(index)),
      axisLabel: {
        formatter: (value: string) => days[Number(value)]?.date ?? value,
      },
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

/**
 * 横向条形图（ECharts 类目轴在 Y、数值在 X）：用于运行负载与磁盘占用。
 * 条尾数值标签常驻，坐标轴只保留类目名——看条长扫视、看标签读数。
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
    grid: { left: 8, right: 48, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'value', show: false, max: 2.5 },
    yAxis: {
      type: 'category',
      data: windows.map((window) => window.label).reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.subtle, fontSize: 11 },
    },
    series: [
      {
        id: 'load-bars',
        type: 'bar',
        barWidth: 10,
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
          fontSize: 11,
          formatter: ({ value }: { value: number }) => value.toFixed(2),
        },
      },
    ],
  }
}

export function buildDiskBarsOption(
  disks: ReadonlyArray<{ mount: string; usagePct: number }>,
  palette: ChartPalette,
): EChartsCoreOption {
  return {
    animationDurationUpdate: 500,
    animationEasingUpdate: 'linear',
    grid: { left: 8, right: 48, top: 8, bottom: 0, containLabel: true },
    xAxis: { type: 'value', show: false, max: 100 },
    yAxis: {
      type: 'category',
      data: disks.map((disk) => disk.mount).reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.subtle, fontSize: 11 },
    },
    series: [
      {
        id: 'disk-bars',
        type: 'bar',
        barWidth: 10,
        data: disks
          .map((disk) => ({
            value: disk.usagePct,
            // 阈值着色沿用 df 惯例：≥80% 警告、≥90% 危险，其余强调色。
            itemStyle: {
              color:
                disk.usagePct >= 90 ? palette.danger : disk.usagePct >= 80 ? palette.warning : palette.accent,
              borderRadius: 5,
            },
            label: { color: disk.usagePct >= 80 ? palette.warning : palette.text },
          }))
          .reverse(),
        label: {
          show: true,
          position: 'right',
          fontSize: 11,
          formatter: ({ value }: { value: number }) => `${value}%`,
        },
      },
    ],
  }
}

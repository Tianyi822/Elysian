import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  ToolboxComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { LegacyGridContainLabel } from 'echarts/features'
import { SVGRenderer } from 'echarts/renderers'

/**
 * 仪表盘图表的按需注册出口：只引 echarts/core 加用到的图与组件，不整包引入。
 * 界面与测试都从这里取同一份注册，避免「测试里能渲染的图和生产不是同一套组件」。
 */
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  BrushComponent,
  ToolboxComponent,
  // 负载卡的读数整列落在 grid.containLabel 的保留区里；ECharts 6 已把它降级为可选特性，
  // 只走 echarts/core 就不会自动注册，靠隐式回落等于把布局押在一个会被移除的兼容层上。
  LegacyGridContainLabel,
  SVGRenderer,
])

export {}

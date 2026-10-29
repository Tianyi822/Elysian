import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { BusyVeil } from '../../components/RefreshState'

/*
 * 日志表格的共用底座：固定列宽、横向滚动、sticky 表头。
 *
 * 固定列宽不靠估：日期时间与等级两列的内容是固定字符数，单元格一律等宽字体
 * （`font-mono`）加 `tabular-nums`，于是每个字符的前进宽度相同，「列宽 = 字符数 ×
 * 字宽 + 内距」可以直接算出来。下面的常量就是这条算式的参数，`LogTable.test.tsx`
 * 逐条断言算式成立，改字号或改列宽会立刻被测试拦下。
 */

/** 等宽字体栈里单个字符的前进宽度上限（em）：Menlo / SF Mono / Courier New 为 0.6，Consolas 更窄。 */
export const MONO_ADVANCE_EM = 0.6
/** 单元格字号（text-xs）与左右内距（px-3，两侧各 12px）。 */
export const LOG_CELL_FONT_PX = 12
export const LOG_CELL_PADDING_PX = 24
/** StatusTag 自身的内距与边框：px-1.5 两侧各 6px + 1px 边框两侧。 */
export const STATUS_TAG_CHROME_PX = 14

/** 日期时间列：`2026-09-23 11:24:54` 固定 19 字符。 */
export const TIMESTAMP_CHARS = 19
export const TIMESTAMP_COLUMN_PX = 176
/**
 * 等级列：等级值原样显示英文（debug/info/warning/error），最长 'warning' 7 个小写字母。
 * StatusTag 是无衬线体（非等宽），按保守的小写拉丁前进宽度计算，见 LATIN_ADVANCE_EM。
 */
export const LEVEL_LABEL_CHARS = 7
/** 无衬线小写拉丁字母的保守前进宽度（em）：平均约 0.5，最宽的 'w' 约 0.78，取 0.62 留余量。 */
export const LATIN_ADVANCE_EM = 0.62
export const LEVEL_COLUMN_PX = 96
/** 日志信息列的最小宽度：约 34 个中文字符，一眼能看出是哪条日志。 */
export const MESSAGE_COLUMN_MIN_PX = 560
/** 表格最小宽度 = 三列之和；窄于它的视口整表横向滚动，不压缩列。 */
export const RUNTIME_LOG_TABLE_MIN_PX = TIMESTAMP_COLUMN_PX + LEVEL_COLUMN_PX + MESSAGE_COLUMN_MIN_PX

/**
 * 两列固定宽度各自的内容实需（px）。断言用：实需必须 ≤ 取定的列宽，否则文本会被截。
 * 等宽字体下时间列的字符前进宽度统一，所以这里是精确值而不是估算区间。
 */
export function fixedColumnDemand(): { timestamp: number; level: number } {
  return {
    timestamp: TIMESTAMP_CHARS * MONO_ADVANCE_EM * LOG_CELL_FONT_PX + LOG_CELL_PADDING_PX,
    level: LEVEL_LABEL_CHARS * LATIN_ADVANCE_EM * LOG_CELL_FONT_PX + STATUS_TAG_CHROME_PX + LOG_CELL_PADDING_PX,
  }
}

/**
 * 外框承担卡片材质与定位上下文，内层滚动容器绝对铺满。
 * 遮罩挂在外框上：滚动条动它不动，刷新期间整张表始终被盖住——
 * 若把遮罩放进滚动容器，它会随内容一起卷出可视区。
 */
const DEFAULT_SHELL_CLASS = 'relative min-h-72 flex-1 overflow-hidden panel-surface'
const SCROLL_CLASS = 'absolute inset-0 overflow-auto hover-scrollbar'

export type LogColumn<T> = {
  /** 列标题，同时作为列标识（同一张表内不重复）。 */
  label: string
  /** 固定列宽类（如 `w-44`）；不传的列吃掉表格剩余宽度（表格另有 min-width 兜底）。 */
  widthClass?: string
  /** 渲染一整格（含 `<td>`；日志正文列用 LogMessageCell）。 */
  cell: (row: T) => ReactNode
}

/**
 * 日志表格：固定列宽 + 整表横向滚动的单容器（表头与正文同一滚动上下文）。
 * 纵向滚动位置完全交给用户，表格不主动改动它。
 */
export function LogTable<T>({
  label,
  minWidthClass,
  columns,
  rows,
  rowKey,
  emptyMessage,
  busy = false,
}: {
  /** 滚动容器的可访问名，如「运行日志表」。 */
  label: string
  /** 表格的 min-width 类；窄屏据此出现横向滚动条。 */
  minWidthClass: string
  columns: readonly LogColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  /** 表格内一行的空提示（数据为空或搜索无命中）。 */
  emptyMessage: ReactNode
  /** 查询在途：旧行留在表里，只由表格自身盖一层浅色遮罩，不换成加载占位。 */
  busy?: boolean
}) {
  return (
    <div className={DEFAULT_SHELL_CLASS}>
      <BusyVeil busy={busy} />
      <div role="region" aria-label={label} className={SCROLL_CLASS}>
        <table className={`w-full ${minWidthClass} table-fixed border-separate border-spacing-0 text-left text-sm`}>
          <colgroup>
            {columns.map((column, index) => (
              <col key={`${column.label}-${index}`} className={column.widthClass} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column.label}-${index}`}
                  scope="col"
                  className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="border-b border-line px-3 py-8 text-center text-sm text-fg-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)} className="transition-colors hover:bg-surface-raised">
                  {columns.map((column, index) => (
                    <Fragment key={`${column.label}-${index}`}>{column.cell(row)}</Fragment>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

import { TERMINAL_COLS, terminalCharWidth, terminalTextWidth } from '@elysian/contracts'

/**
 * 终端会话内核的类型与纯函数：不依赖 React、DOM 与任何领域适配层，
 * 各演示会话（终端类界面）共用的类型与纯函数。
 */

/**
 * 输出行的三种形态：横幅（演示标注）、输入语句、输出结果。
 * input 行的 prompt 是提交当时的提示符快照。活动提示符会随工作目录变化，
 * 已落日志的输入行必须沿用这份快照，不能跟着当前提示符改写。
 */
export type TerminalLine = {
  kind: 'banner' | 'input' | 'output'
  text: string
  prompt?: string
}

/** 补全引擎的返回形状：新草稿与光标；无法再收敛时给出候选列表。 */
export type TerminalCompletion = {
  draft: string
  cursor: number
  /** 多个候选且无法再收敛时给出，由界面按 bash 的习惯列出行。 */
  candidates?: readonly string[]
}

/** 历史连续去重：连按同一条只记一次。 */
export function pushHistory(history: readonly string[], command: string): readonly string[] {
  return history[history.length - 1] === command ? history : [...history, command]
}

/** 游标语义：history.length 表示「回到新输入」，0..length-1 指向历史条目。 */
export function recallHistory(
  history: readonly string[],
  index: number | null,
  direction: -1 | 1,
): { draft: string; index: number } {
  const position = index ?? history.length
  const next = direction === -1 ? Math.max(0, position - 1) : Math.min(history.length, position + 1)
  return { draft: next === history.length ? '' : (history[next] ?? ''), index: next }
}

/**
 * Tab 补全的候选池：首个词（命令位）用命令池，行中词用词池。
 * 词池是文件名、参数候选等任意词表；null 或缺省表示没有词池可用，退回命令池
 * （对应真实端点「cwd 文件数超限为 null，补全退回命令表」的口径）。空数组是「有池但无词」。
 */
export type TerminalCompletionPools = {
  commands: readonly string[]
  words?: readonly string[] | null
}

/**
 * 按池收敛 Tab 补全：唯一命中补齐并补一个空格，多命中收敛最长公共前缀，
 * 无法再收敛时给候选列表。mock 引擎与真实 WS 适配器共用这一个实现——
 * 算法只有一个家，词表来源由调用方决定。
 */
export function completeWithPools(
  draft: string,
  cursor: number,
  pools: TerminalCompletionPools,
): TerminalCompletion {
  const before = draft.slice(0, cursor)
  const token = /(\S*)$/.exec(before)?.[0] ?? ''
  const tokenStart = cursor - token.length
  const previousWord = before
    .slice(0, tokenStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .pop()
  const pool = previousWord ? (pools.words ?? pools.commands) : pools.commands
  const matches = pool.filter((candidate) => candidate.startsWith(token))

  if (matches.length === 0) return { draft, cursor }

  if (matches.length === 1) {
    const completed = `${matches[0]} `
    return {
      draft: before.slice(0, tokenStart) + completed + draft.slice(cursor),
      cursor: tokenStart + completed.length,
    }
  }

  const common = matches.reduce((acc, candidate) => {
    let i = 0
    while (i < acc.length && i < candidate.length && acc[i] === candidate[i]) i += 1
    return acc.slice(0, i)
  }, matches[0] ?? '')

  if (common.length > token.length) {
    return {
      draft: before.slice(0, tokenStart) + common + draft.slice(cursor),
      cursor: tokenStart + common.length,
    }
  }

  return { draft, cursor, candidates: matches }
}

/** 渲染分段：连续的窄字符合成一段，宽字符各自成段（其后的零宽附加符并入该段）。 */
export type TerminalTextSegment = { text: string; wide: boolean }

export function segmentTerminalText(text: string): readonly TerminalTextSegment[] {
  const segments: TerminalTextSegment[] = []
  for (const char of text) {
    const width = terminalCharWidth(char)
    const last = segments[segments.length - 1]
    if (last && (width === 0 || (width === 1 && !last.wide))) {
      last.text += char
    } else {
      segments.push({ text: char, wide: width === 2 })
    }
  }
  return segments
}

const COLUMN_GAP = 2

/**
 * 按 ls -C 的习惯把条目排成纵向分栏：先竖后横填充，每列宽取该列最宽条目，
 * 列间隔两格，在行宽内取能放下的最多列数；宽字符按两格计。候选清单与演示 ls 共用。
 */
export function formatTerminalColumns(
  items: readonly string[],
  lineWidth: number = TERMINAL_COLS,
): readonly string[] {
  if (items.length === 0) return []
  const widths = items.map(terminalTextWidth)
  const maxColumns = Math.min(items.length, Math.floor((lineWidth + COLUMN_GAP) / (1 + COLUMN_GAP)))
  for (let columns = Math.max(1, maxColumns); columns >= 1; columns -= 1) {
    const rows = Math.ceil(items.length / columns)
    const used = Math.ceil(items.length / rows)
    const columnWidths = Array.from({ length: used }, (_, column) =>
      widths.slice(column * rows, column * rows + rows).reduce((max, width) => Math.max(max, width), 0),
    )
    const total = columnWidths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * (used - 1)
    if (total > lineWidth && columns > 1) continue
    return Array.from({ length: rows }, (_, row) => {
      let line = ''
      for (let column = 0; column < used; column += 1) {
        const index = column * rows + row
        const item = items[index]
        if (item === undefined) break
        const hasNext = index + rows < items.length
        line += hasNext
          ? item + ' '.repeat((columnWidths[column] ?? 0) - (widths[index] ?? 0) + COLUMN_GAP)
          : item
      }
      return line
    })
  }
  return [...items]
}

/**
 * 本机终端连接关闭码 → 界面错误消息的映射（终端消息协议「客户端错误映射」的唯一权威）：
 * 4000 空闲超时；1008 原样透传服务端中文 reason；1006 与其它一律按连接中断处理。
 */
export function hostTerminalCloseMessage(code: number, reason: string): string {
  if (code === 4000) return '终端会话空闲超时，已断开'
  if (code === 1008) return reason.length > 0 ? reason : '本机终端连接中断'
  return '本机终端连接中断'
}

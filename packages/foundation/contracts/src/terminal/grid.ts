/**
 * 终端栅格口径：本机终端 PTY 的固定栅格、制表位宽与字符显示宽度。
 * 服务端按它把 PTY 字节落成行（制表位展开、回车覆盖写），浏览器按它排版与渲染
 * （宽字符固定占两格、候选清单按栅格行宽分栏）。两端口径一致，对齐输出才不会错列。
 */

/** PTY 栅格：启动行 stty 固定尺寸（script 管道无 TIOCSWINSZ 通道，不做动态窗口）。 */
export const TERMINAL_COLS = 100
export const TERMINAL_ROWS = 30

/** 制表位间隔：与 stty 默认的 tab0 一致，每 8 列一个制表位。 */
export const TERMINAL_TAB_WIDTH = 8

type CodePointRange = readonly [number, number]

/**
 * 两格宽的码点区间（闭区间、升序）：Unicode East Asian Width 的 W/F 主要区段
 * 加 emoji 表象区段。与 glibc wcwidth 在个别符号上可能差一格。
 */
const WIDE_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

/** 零宽的码点区间（闭区间、升序）：组合附加符、零宽空格与连接符、方向控制、变体选择符。 */
const ZERO_WIDTH_RANGES: readonly CodePointRange[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
]

function inRanges(code: number, ranges: readonly CodePointRange[]): boolean {
  for (const [start, end] of ranges) {
    if (code < start) return false
    if (code <= end) return true
  }
  return false
}

/** 单个码点在终端里占的列数：零宽 0、半角 1、全角与中文 2。 */
export function terminalCharWidth(char: string): 0 | 1 | 2 {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x0300) return 1
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0
  return inRanges(code, WIDE_RANGES) ? 2 : 1
}

/** 一段文本在终端里占的列数。 */
export function terminalTextWidth(text: string): number {
  let width = 0
  for (const char of text) width += terminalCharWidth(char)
  return width
}

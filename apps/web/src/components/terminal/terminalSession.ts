/**
 * 终端会话内核的类型与纯函数：不依赖 React、DOM 与任何领域适配层，
 * 各演示会话（终端类界面）共用的类型与纯函数。
 */

/** 输出行的三种形态：横幅（演示标注）、输入语句、输出结果。 */
export type TerminalLine = { kind: 'banner' | 'input' | 'output'; text: string }

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

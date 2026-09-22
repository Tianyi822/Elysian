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

/**
 * 本机终端连接关闭码 → 界面错误消息的映射（终端消息协议「客户端错误映射」的唯一权威）：
 * 4000 空闲超时；1008 原样透传服务端中文 reason；1006 与其它一律按连接中断处理。
 */
export function hostTerminalCloseMessage(code: number, reason: string): string {
  if (code === 4000) return '终端会话空闲超时，已断开'
  if (code === 1008) return reason.length > 0 ? reason : '本机终端连接中断'
  return '本机终端连接中断'
}

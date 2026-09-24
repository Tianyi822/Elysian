/**
 * 启动命令分词：按 shell 字面规则拆成 argv，不做变量展开。
 * 供创建容器表单与服务端 docker create 共用。
 */

export const MAX_SHELL_WORDS = 256

export type ParseShellWordsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string }

const WHITESPACE = /[\t\n\r ]/

function isWhitespace(ch: string): boolean {
  return WHITESPACE.test(ch)
}

export function parseShellWords(input: string): ParseShellWordsResult {
  if (input.includes('\n') || input.includes('\r')) {
    return { ok: false, error: '启动命令不能包含换行' }
  }

  const args: string[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    while (i < len && isWhitespace(input[i]!)) i += 1
    if (i >= len) break

    let word = ''
    let closed = true

    while (i < len && !isWhitespace(input[i]!)) {
      const ch = input[i]!

      if (ch === "'") {
        i += 1
        while (i < len && input[i] !== "'") {
          word += input[i]!
          i += 1
        }
        if (i >= len) {
          return { ok: false, error: '启动命令含有未闭合的引号' }
        }
        i += 1
        continue
      }

      if (ch === '"') {
        i += 1
        closed = false
        while (i < len) {
          const inner = input[i]!
          if (inner === '\\' && i + 1 < len) {
            word += input[i + 1]!
            i += 2
            continue
          }
          if (inner === '"') {
            i += 1
            closed = true
            break
          }
          word += inner
          i += 1
        }
        if (!closed) {
          return { ok: false, error: '启动命令含有未闭合的引号' }
        }
        continue
      }

      if (ch === '\\' && i + 1 < len) {
        word += input[i + 1]!
        i += 2
        continue
      }

      word += ch
      i += 1
    }

    args.push(word)
    if (args.length > MAX_SHELL_WORDS) {
      return { ok: false, error: `启动命令参数不能超过 ${MAX_SHELL_WORDS} 个` }
    }
  }

  return { ok: true, args }
}

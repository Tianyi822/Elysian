/*
 * 把 Caddyfile 的全局段收成面板需要的 admin unix socket。
 * 只改全局段里的 admin 指令，站点块原样留下；全局段括号不配对时拒绝改写。
 */

export const CADDYFILE_GLOBAL_UNCLOSED = 'Caddyfile 全局段没有结束括号'

/** Caddyfile 全局段的 admin 指令。`unix/` 加绝对路径即文档里的 `unix//run/...`。 */
export function caddyAdminDirective(socketPath: string): string {
  return `admin unix/${socketPath}`
}

function withTrailingNewline(value: string): string {
  if (value.length === 0 || value.endsWith('\n')) return value
  return `${value}\n`
}

/** 跳过空行与 # 注释，找到全局段的起始 `{`；不是单独的 `{` 就视为没有全局段。 */
function indexOfGlobalOpen(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed === '{' ? index : -1
  }
  return -1
}

function indexOfGlobalClose(lines: readonly string[], open: number): number {
  let depth = 0
  for (let index = open; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    for (const char of line) {
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
    }
    if (index > open && depth === 0) return index
  }
  return -1
}

/**
 * 保证全局段声明目标 admin 地址。已是该地址则文本不变（只统一换行）；
 * 已有别的 admin 则换成这一条；没有全局段则在文件头补上。
 */
export function ensureCaddyAdminSocket(source: string, socketPath: string): string {
  const directive = caddyAdminDirective(socketPath)
  const normalized = source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const start = indexOfGlobalOpen(lines)
  if (start === -1) {
    const body = normalized.trim()
    const next = body.length === 0
      ? `{\n\t${directive}\n}\n`
      : `{\n\t${directive}\n}\n\n${body}\n`
    return next
  }
  const end = indexOfGlobalClose(lines, start)
  if (end === -1) throw new Error(CADDYFILE_GLOBAL_UNCLOSED)
  const adminIndexes: number[] = []
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    if (line !== undefined && /^\s*admin\s+/.test(line)) adminIndexes.push(index)
  }
  const only = adminIndexes[0]
  const adminLine = only === undefined ? undefined : lines[only]
  if (adminIndexes.length === 1 && adminLine?.trim() === directive) {
    return withTrailingNewline(normalized)
  }
  const kept = lines.filter((_, index) => !adminIndexes.includes(index))
  kept.splice(start + 1, 0, `\t${directive}`)
  return withTrailingNewline(kept.join('\n'))
}

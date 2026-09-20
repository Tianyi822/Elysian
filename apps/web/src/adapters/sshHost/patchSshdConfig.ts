/*
 * sshd_config 的行级补丁器：只改 Port、PasswordAuthentication、PubkeyAuthentication、
 * PermitRootLogin 这四个白名单指令——已有全局取值就整行替换为规范写法，没有就在
 * 全局段末尾追加；其余任何行（注释、Include、Match 块、别的指令）一律原样保留。
 *
 * 追加位置必须在全局段内：文件带 Match 块时追加到首个 Match 之前，
 * 否则新指令会落进条件块、只在部分连接上生效。
 */

import { SSHD_DIRECTIVE_NAMES, stripConfigComment, type SshdDirectiveName } from './parseSshdConfig'

/** 补丁取值：指令名（规范大小写）→ 单个取值词。 */
export type SshdConfigPatch = Partial<Record<SshdDirectiveName, string>>

/** 逐行打补丁；输入与补丁都不含白名单外指令时，输出与输入的差别只在目标行与追加行。 */
export function patchSshdConfig(text: string, patch: SshdConfigPatch): string {
  const pending = new Map<SshdDirectiveName, string>()
  for (const name of SSHD_DIRECTIVE_NAMES) {
    const value = patch[name]
    if (value !== undefined) pending.set(name, value)
  }

  const lines = text.split('\n')
  // 全局段末尾：首个顶层 Match 行之前；没有 Match 块则是文件尾（保留结尾空行语义）。
  let appendIndex = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripConfigComment(lines[index] ?? '').trim()
    if (!line) continue
    if (line.split(/\s+/)[0]?.toLowerCase() === 'match') {
      appendIndex = index
      break
    }
  }
  // 结尾空行（来自末尾换行）不算内容行，追加插在它前面，避免多出一个空行。
  if (appendIndex === lines.length && lines[appendIndex - 1] === '') {
    appendIndex -= 1
  }

  for (let index = 0; index < appendIndex; index += 1) {
    const line = stripConfigComment(lines[index] ?? '').trim()
    if (!line) continue
    const keyword = line.split(/\s+/)[0]?.toLowerCase() ?? ''
    for (const name of [...pending.keys()]) {
      // 同一指令多次出现时 sshd 以首个取值生效，因此只替换首个未注释行，后续行保持原样（本就不生效）。
      if (name.toLowerCase() === keyword) {
        lines[index] = `${name} ${pending.get(name)}`
        pending.delete(name)
      }
    }
  }

  let insertAt = appendIndex
  for (const [name, value] of pending) {
    lines.splice(insertAt, 0, `${name} ${value}`)
    insertAt += 1
  }
  return lines.join('\n')
}

/*
 * sshd_config 的行级补丁器：只改 Port、PasswordAuthentication、PubkeyAuthentication、
 * PermitRootLogin 这四个白名单指令——已有全局取值就整行替换为规范写法，没有就在
 * 全局段内追加；其余任何行（注释、Include、Match 块、别的指令）一律原样保留。
 *
 * 取值顺序对齐 sshd_config(5)：同一指令多次出现时以首次取值生效（first-obtained），
 * Include 引入的文件按出现序参与该顺序，Port 是明示的例外——多次出现为累积监听，
 * sshd 会同时监听所有 Port 行。因此：
 * - 追加位置必须在任何 Include 与 Match 之前：面板行先于 Include 取得取值，
 *   sshd_config.d 里的同名指令不再能按 first-obtained 遮蔽面板写入；
 * - Include 之后才出现的非 Port 白名单指令不作替换目标（该行可能已被 drop-in 遮蔽），
 *   改由插到 Include 之前的面板行接管生效；
 * - Port 替换首个未注释行的同时，把全局段内其余未注释 Port 行注释掉——留存行会让
 *   sshd 继续监听旧端口（drop-in 里的 Port 无法从主文件撤销，属面板能力边界）。
 * 关键词识别前先按 sshd_config(5) 把行内第一处 = 归一为空白分隔：Include、Match 的
 * 等号写法与空白写法等价，漏识别会让插入点或全局段边界判错。
 */

import { SSHD_DIRECTIVE_NAMES, normalizeEqualsSeparator, stripConfigComment, type SshdDirectiveName } from './parseSshdConfig'

/** 补丁取值：指令名（规范大小写）→ 单个取值词。 */
export type SshdConfigPatch = Partial<Record<SshdDirectiveName, string>>

/** 逐行打补丁；输入与补丁都不含白名单外指令时，输出与输入的差别只在目标行、被注释的 Port 行与插入行。 */
export function patchSshdConfig(text: string, patch: SshdConfigPatch): string {
  const pending = new Map<SshdDirectiveName, string>()
  for (const name of SSHD_DIRECTIVE_NAMES) {
    const value = patch[name]
    if (value !== undefined) pending.set(name, value)
  }

  const lines = text.split('\n')
  // 首个 Include 与首个 Match 的位置：前者决定面板行能否取得首个取值，后者划分全局段。
  let firstIncludeIndex = lines.length
  let firstMatchIndex = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeEqualsSeparator(stripConfigComment(lines[index] ?? '').trim())
    if (!line) continue
    const keyword = line.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (keyword === 'include' && firstIncludeIndex === lines.length) firstIncludeIndex = index
    if (keyword === 'match' && firstMatchIndex === lines.length) firstMatchIndex = index
  }
  // 插入点：全局段内、任何 Include 与 Match 之前；没有 Match 块则是文件尾（保留结尾空行语义）。
  let insertIndex = Math.min(firstIncludeIndex, firstMatchIndex)
  // 结尾空行（来自末尾换行）不算内容行，插入放它前面，避免多出一个空行。
  if (insertIndex === lines.length && lines[insertIndex - 1] === '') {
    insertIndex -= 1
  }

  let portReplaced = false
  for (let index = 0; index < firstMatchIndex; index += 1) {
    const line = normalizeEqualsSeparator(stripConfigComment(lines[index] ?? '').trim())
    if (!line) continue
    const keyword = line.split(/\s+/)[0]?.toLowerCase() ?? ''

    if (pending.has('Port') && keyword === 'port') {
      if (!portReplaced) {
        // 首个未注释 Port 行整行替换为规范写法。
        lines[index] = `Port ${pending.get('Port')}`
        portReplaced = true
      } else {
        // Port 为累积监听指令：其余未注释行注释掉，否则旧端口仍在监听而面板只显示新端口。
        lines[index] = `#${lines[index]}`
      }
      continue
    }

    for (const name of [...pending.keys()]) {
      // 首次取值生效：只替换首个未注释行，后续行原样保留（本就不生效）。
      // 替换目标还必须先于任何 Include：晚于 Include 的取值可能已被 drop-in 遮蔽，替换不保证生效。
      if (name.toLowerCase() === keyword && index < firstIncludeIndex) {
        lines[index] = `${name} ${pending.get(name)}`
        pending.delete(name)
      }
    }
  }
  // Port 已有替换落点时不再追加，避免同一端口写两行。
  if (portReplaced) pending.delete('Port')

  let insertAt = insertIndex
  for (const [name, value] of pending) {
    lines.splice(insertAt, 0, `${name} ${value}`)
    insertAt += 1
  }
  return lines.join('\n')
}

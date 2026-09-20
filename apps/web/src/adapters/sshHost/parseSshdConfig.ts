/*
 * /etc/ssh/sshd_config 的只读解析器：只提取面板要动的四个指令（Port、
 * PasswordAuthentication、PubkeyAuthentication、PermitRootLogin），其余行不解释。
 * 语义对齐 sshd_config(5)：井号起始的行是注释；指令名大小写不敏感；同一指令
 * 多次出现时首个取值生效（first-obtained value，Port 是例外——多次出现为累积监听，
 * 解析仍取首个用于面板显示，补丁侧负责消掉多余 Port 行）；Match 块内的指令只对
 * 匹配的连接生效，不属于全局配置，解析时整块跳过。Include 的展开发生在调用方
 * （文本先行按 sshd 语义拼接），本解析器只看单份文本。
 */

/** 面板允许读写的四个指令名，写法用 sshd_config 的规范大小写。 */
export const SSHD_DIRECTIVE_NAMES = [
  'Port',
  'PasswordAuthentication',
  'PubkeyAuthentication',
  'PermitRootLogin',
] as const

export type SshdDirectiveName = (typeof SSHD_DIRECTIVE_NAMES)[number]

/** 四个指令的解析结果；指令未在全局段出现（或取值无法辨认）时为 null，由调用方按 sshd 默认值兜底。 */
export type SshdDirectives = {
  port: number | null
  passwordAuthentication: boolean | null
  pubkeyAuthentication: boolean | null
  permitRootLogin: string | null
}

/** sshd_config 里 `#` 只有出现在行首或空白之后才是注释起点，公钥等取值里不会有这个形态。 */
export function stripConfigComment(line: string): string {
  const match = /(^\s*#|\s#)/.exec(line)
  return match ? line.slice(0, match.index) : line
}

/**
 * sshd_config(5)：关键词与取值之间可用「可选空白 + 恰一个 = + 可选空白」分隔，
 * 与空白分隔等价（`Port=22`、`Port = 22` 同 `Port 22`）。解析前把行内第一处
 * 「= 及其紧邻空白」归一为单个空白即可覆盖该写法；面板只读四个白名单指令，
 * 它们的取值都不含 =，后续取值不受影响。
 */
export function normalizeEqualsSeparator(line: string): string {
  const match = /\s*=\s*/.exec(line)
  return match ? `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}` : line
}

/** 解析全文的全局段指令。 */
export function parseSshdConfig(text: string): SshdDirectives {
  const directives: SshdDirectives = {
    port: null,
    passwordAuthentication: null,
    pubkeyAuthentication: null,
    permitRootLogin: null,
  }
  let seen: Record<SshdDirectiveName, boolean> = {
    Port: false,
    PasswordAuthentication: false,
    PubkeyAuthentication: false,
    PermitRootLogin: false,
  }
  let inMatchBlock = false

  for (const rawLine of text.split('\n')) {
    const line = normalizeEqualsSeparator(stripConfigComment(rawLine).trim())
    if (!line) continue
    const tokens = line.split(/\s+/)
    const keyword = (tokens[0] ?? '').toLowerCase()
    const value = tokens[1]

    if (keyword === 'match') {
      // Match 块到文件尾或下一个 Match 为止，块内指令不进全局取值。
      inMatchBlock = true
      continue
    }
    if (inMatchBlock) continue

    const name = SSHD_DIRECTIVE_NAMES.find((candidate) => candidate.toLowerCase() === keyword)
    if (!name || value === undefined || seen[name]) continue
    seen = { ...seen, [name]: true }

    switch (name) {
      case 'Port': {
        const port = Number.parseInt(value, 10)
        directives.port = /^\d+$/.test(value) && port >= 1 && port <= 65535 ? port : null
        break
      }
      case 'PasswordAuthentication':
      case 'PubkeyAuthentication': {
        const normalized = value.toLowerCase()
        const parsed =
          normalized === 'yes' ? true : normalized === 'no' ? false : null
        if (name === 'PasswordAuthentication') directives.passwordAuthentication = parsed
        else directives.pubkeyAuthentication = parsed
        break
      }
      case 'PermitRootLogin': {
        // without-password 是 prohibit-password 的废弃别名（sshd_config(5)）：
        // 归一后交付，调用方的枚举匹配不再被别名打破。
        const normalized = value.toLowerCase()
        directives.permitRootLogin = normalized === 'without-password' ? 'prohibit-password' : normalized
        break
      }
    }
  }

  return directives
}
